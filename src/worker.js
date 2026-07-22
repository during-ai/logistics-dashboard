import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import manifestJSON from "__STATIC_CONTENT_MANIFEST";
const assetManifest = JSON.parse(manifestJSON);

/* ── 유틸 ── */
function getTodayKST() {
  const n = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return n.toISOString().slice(0, 10);
}

function getPrevDateKST(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  };
}

/* ── API 핸들러 ── */
async function handleAPI(url, method, request, env) {
  const p = url.pathname;

  // ── POST /api/auth (PIN 인증) ──
  if (method === "POST" && p === "/api/auth") {
    try {
      const body = await request.json();
      const ok = String(body.pin) === env.MANAGER_PIN;
      return json(ok ? 200 : 401, { ok });
    } catch { return json(400, { ok: false }); }
  }

  // ── GET /api/dashboard/today ──
  if (method === "GET" && p === "/api/dashboard/today") {
    const date = getTodayKST();
    return serveDashboard(env, date);
  }

  // ── GET /api/dashboard/:date ──
  const dashMatch = p.match(/^\/api\/dashboard\/(\d{4}-\d{2}-\d{2})$/);
  if (method === "GET" && dashMatch) {
    return serveDashboard(env, dashMatch[1]);
  }

  // ── POST /api/plan/push (API_KEY 인증, 팀별 merge) ──
  if (method === "POST" && p === "/api/plan/push") {
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return json(401, { message: "Invalid API key" });
    }
    try {
      const body = await request.json();
      const date = body.date || getTodayKST();
      // 기존 데이터 로드 → 팀별 merge
      const existingRaw = await env.LOGISTICS_KV.get(`plan:${date}`);
      const existing = existingRaw ? JSON.parse(existingRaw) : {};
      if (!existing.teams) existing.teams = {};
      // 새로 push된 팀만 갱신, 나머지 유지
      const pushedTeams = [];
      if (body.teams) {
        for (const [team, data] of Object.entries(body.teams)) {
          existing.teams[team] = data;
          pushedTeams.push(team);
        }
      }
      // KPI를 전체 팀 기준으로 재계산
      let linesDay = 0, linesNight = 0, switchCount = 0, resumeCount = 0;
      for (const data of Object.values(existing.teams)) {
        linesDay += (data.lines?.day || 0);
        linesNight += (data.lines?.night || 0);
        switchCount += (data.switches?.length || 0);
      }
      existing.date = date;
      existing.kpi = { linesDay, linesNight, switchCount, resumeCount };
      existing.pushedAt = body.pushedAt || new Date(Date.now() + 9*3600000).toISOString();
      existing.source = body.source || "production_plan_push.py";
      await env.LOGISTICS_KV.put(`plan:${date}`, JSON.stringify(existing));
      await snapshotHistory(env, date);
      return json(200, { ok: true, date, merged: pushedTeams });
    } catch { return json(400, { message: "Invalid JSON" }); }
  }

  // ── POST /api/comm/push (API_KEY 인증) ──
  if (method === "POST" && p === "/api/comm/push") {
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return json(401, { message: "Invalid API key" });
    }
    try {
      const body = await request.json();
      const date = body.date || getTodayKST();
      await env.LOGISTICS_KV.put(`comm:${date}`, JSON.stringify(body));
      await snapshotHistory(env, date);
      return json(200, { ok: true, date });
    } catch { return json(400, { message: "Invalid JSON" }); }
  }

  // ── GET /api/notes/:date ── (persistent 또는 날짜별)
  const notesGetMatch = p.match(/^\/api\/notes\/([^/]+)$/);
  if (method === "GET" && notesGetMatch) {
    const key = notesGetMatch[1] === "persistent" ? "notes:persistent" : `notes:${notesGetMatch[1]}`;
    const raw = await env.LOGISTICS_KV.get(key);
    return json(200, raw ? JSON.parse(raw) : { "권선": [], "사출": [], "전장": [] });
  }

  // ── POST /api/notes (전달사항 추가 — persistent) ──
  if (method === "POST" && p === "/api/notes") {
    try {
      const body = await request.json();
      const team = body.team;
      const text = (body.text || "").trim();
      if (!team || !text) return json(400, { message: "team, text 필수" });

      const key = "notes:persistent";
      const raw = await env.LOGISTICS_KV.get(key);
      const notes = raw ? JSON.parse(raw) : { "권선": [], "사출": [], "전장": [] };
      if (!notes[team]) notes[team] = [];

      const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const time = now.toISOString().slice(11, 16);
      notes[team].unshift({ time, text, author: body.author || "" });

      await env.LOGISTICS_KV.put(key, JSON.stringify(notes));
      return json(201, { ok: true, notes });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── POST /api/notes/:key/:team/:idx/done (전달사항 완료 처리) ──
  const notesDoneMatch = p.match(/^\/api\/notes\/([^/]+)\/([^/]+)\/(\d+)\/done$/);
  if (method === "POST" && notesDoneMatch) {
    const [, dateOrKey, team, idxStr] = notesDoneMatch;
    const decodedTeam = decodeURIComponent(team);
    const idx = parseInt(idxStr);
    const key = dateOrKey === "persistent" ? "notes:persistent" : `notes:${dateOrKey}`;
    const raw = await env.LOGISTICS_KV.get(key);
    const notes = raw ? JSON.parse(raw) : {};
    if (notes[decodedTeam] && idx >= 0 && idx < notes[decodedTeam].length) {
      const wasDone = notes[decodedTeam][idx].done;
      notes[decodedTeam][idx].done = !wasDone;
      notes[decodedTeam][idx].doneAt = !wasDone ? new Date().toISOString() : null;
    }
    await env.LOGISTICS_KV.put(key, JSON.stringify(notes));
    return json(200, { ok: true, notes });
  }

  // ── DELETE /api/notes/:key/:team/:idx ── (persistent 또는 날짜별)
  const notesDelMatch = p.match(/^\/api\/notes\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (method === "DELETE" && notesDelMatch) {
    const [, dateOrKey, team, idxStr] = notesDelMatch;
    const decodedTeam = decodeURIComponent(team);
    const idx = parseInt(idxStr);
    const key = dateOrKey === "persistent" ? "notes:persistent" : `notes:${dateOrKey}`;
    const raw = await env.LOGISTICS_KV.get(key);
    const notes = raw ? JSON.parse(raw) : {};
    if (notes[decodedTeam] && idx >= 0 && idx < notes[decodedTeam].length) {
      notes[decodedTeam].splice(idx, 1);
      await env.LOGISTICS_KV.put(key, JSON.stringify(notes));
    }
    return json(200, { ok: true, notes });
  }

  // ── POST /api/upload/staff (PIN 인증) ──
  if (method === "POST" && p === "/api/upload/staff") {
    try {
      const body = await request.json();
      if (String(body.pin) !== env.MANAGER_PIN) return json(401, { message: "PIN 오류" });
      await env.LOGISTICS_KV.put("staff:latest", JSON.stringify(body.data));
      return json(200, { ok: true });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── POST /api/upload/bom (PIN 인증) ──
  if (method === "POST" && p === "/api/upload/bom") {
    try {
      const body = await request.json();
      if (String(body.pin) !== env.MANAGER_PIN) return json(401, { message: "PIN 오류" });
      await env.LOGISTICS_KV.put("bom:latest", JSON.stringify(body.data));
      return json(200, { ok: true });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── POST /api/chat/upload (PIN 인증 — 텍스트 기반) ──
  if (method === "POST" && p === "/api/chat/upload") {
    try {
      const body = await request.json();
      if (String(body.pin) !== env.MANAGER_PIN) return json(401, { message: "PIN 오류" });
      const date = body.date || getTodayKST();
      const key = `chat:${date}`;
      const raw = await env.LOGISTICS_KV.get(key);
      const chat = raw ? JSON.parse(raw) : {};
      const team = body.team;
      if (!team) return json(400, { message: "team 필수" });
      chat[team] = body.summary || body.text || "";
      await env.LOGISTICS_KV.put(key, JSON.stringify(chat));
      return json(200, { ok: true });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── POST /api/plan/manual (PIN 인증 — 수동 입력) ──
  if (method === "POST" && p === "/api/plan/manual") {
    try {
      const body = await request.json();
      if (String(body.pin) !== env.MANAGER_PIN) return json(401, { message: "PIN 오류" });
      const date = body.date || getTodayKST();
      await env.LOGISTICS_KV.put(`plan:${date}`, JSON.stringify(body.data));
      await snapshotHistory(env, date);
      return json(200, { ok: true, date });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── POST /api/notices/common (공통 공지 추가) ──
  if (method === "POST" && p === "/api/notices/common") {
    try {
      const body = await request.json();
      const text = (body.text || "").trim();
      if (!text) return json(400, { message: "text 필수" });
      const raw = await env.LOGISTICS_KV.get("notices:common");
      const notices = raw ? JSON.parse(raw) : [];
      const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
      notices.unshift({ text, time: now.toISOString().slice(0, 16), author: body.author || "" });
      await env.LOGISTICS_KV.put("notices:common", JSON.stringify(notices));
      return json(201, { ok: true });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── PUT /api/notices/common/reorder ──
  if (method === "PUT" && p === "/api/notices/common/reorder") {
    try {
      const body = await request.json();
      const from = body.from;
      const to = body.to;
      const raw = await env.LOGISTICS_KV.get("notices:common");
      const notices = raw ? JSON.parse(raw) : [];
      if (from < 0 || from >= notices.length || to < 0 || to >= notices.length) {
        return json(400, { message: "Invalid index" });
      }
      const [item] = notices.splice(from, 1);
      notices.splice(to, 0, item);
      await env.LOGISTICS_KV.put("notices:common", JSON.stringify(notices));
      return json(200, { ok: true });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── DELETE /api/notices/common/:idx ──
  const commonDelMatch = p.match(/^\/api\/notices\/common\/(\d+)$/);
  if (method === "DELETE" && commonDelMatch) {
    const idx = parseInt(commonDelMatch[1]);
    const raw = await env.LOGISTICS_KV.get("notices:common");
    const notices = raw ? JSON.parse(raw) : [];
    if (idx >= 0 && idx < notices.length) {
      notices.splice(idx, 1);
      await env.LOGISTICS_KV.put("notices:common", JSON.stringify(notices));
    }
    return json(200, { ok: true });
  }

  // ── POST /api/calendar/event (주간 일정 추가) ──
  if (method === "POST" && p === "/api/calendar/event") {
    try {
      const body = await request.json();
      const evDate = body.date;
      const text = (body.text || "").trim();
      if (!evDate || !text) return json(400, { message: "date, text 필수" });
      // 해당 주 월요일 기준 키 계산
      const weekKey = getWeekKey(evDate);
      const raw = await env.LOGISTICS_KV.get(`calendar:${weekKey}`);
      const cal = raw ? JSON.parse(raw) : {};
      if (!cal[evDate]) cal[evDate] = [];
      cal[evDate].push(text);
      await env.LOGISTICS_KV.put(`calendar:${weekKey}`, JSON.stringify(cal));
      return json(201, { ok: true });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── DELETE /api/calendar/event/:date/:idx ──
  const calDelMatch = p.match(/^\/api\/calendar\/event\/(\d{4}-\d{2}-\d{2})\/(\d+)$/);
  if (method === "DELETE" && calDelMatch) {
    const [, evDate, idxStr] = calDelMatch;
    const idx = parseInt(idxStr);
    const weekKey = getWeekKey(evDate);
    const raw = await env.LOGISTICS_KV.get(`calendar:${weekKey}`);
    const cal = raw ? JSON.parse(raw) : {};
    if (cal[evDate] && idx >= 0 && idx < cal[evDate].length) {
      cal[evDate].splice(idx, 1);
      await env.LOGISTICS_KV.put(`calendar:${weekKey}`, JSON.stringify(cal));
    }
    return json(200, { ok: true });
  }

  // ── GET /api/calendar/events/:date (특정 날짜 일정 조회) ──
  const calGetMatch = p.match(/^\/api\/calendar\/events\/(\d{4}-\d{2}-\d{2})$/);
  if (method === "GET" && calGetMatch) {
    const evDate = calGetMatch[1];
    const weekKey = getWeekKey(evDate);
    const raw = await env.LOGISTICS_KV.get(`calendar:${weekKey}`);
    const cal = raw ? JSON.parse(raw) : {};
    return json(200, { date: evDate, events: cal[evDate] || [] });
  }

  // ── POST /api/material/push (API_KEY 인증) ──
  if (method === "POST" && p === "/api/material/push") {
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return json(401, { message: "Invalid API key" });
    }
    try {
      const body = await request.json();
      const date = body.date || getTodayKST();
      // 기존 데이터에서 received 상태 보존 (자재품번 기준)
      const oldRaw = await env.LOGISTICS_KV.get(`material:${date}`);
      if (oldRaw && body.items) {
        const old = JSON.parse(oldRaw);
        const recvMap = {};
        (old.items || []).forEach(it => {
          if (it.received) recvMap[it["자재품번"]] = { received: true, receivedAt: it.receivedAt || null };
        });
        body.items.forEach(it => {
          const prev = recvMap[it["자재품번"]];
          if (prev) { it.received = true; it.receivedAt = prev.receivedAt; }
        });
      }
      await env.LOGISTICS_KV.put(`material:${date}`, JSON.stringify(body));
      return json(200, { ok: true, date, total: (body.items || []).length });
    } catch { return json(400, { message: "Invalid JSON" }); }
  }

  // ── POST /api/material/:date/received/:idx (입고 확인 토글) ──
  const materialReceivedMatch = p.match(/^\/api\/material\/(\d{4}-\d{2}-\d{2})\/received\/(\d+)$/);
  if (method === "POST" && materialReceivedMatch) {
    const [, mDate, idxStr] = materialReceivedMatch;
    const idx = parseInt(idxStr);
    const raw = await env.LOGISTICS_KV.get(`material:${mDate}`);
    if (!raw) return json(404, { message: "해당 날짜 자재 데이터 없음" });
    const material = JSON.parse(raw);
    if (!material.items || idx < 0 || idx >= material.items.length) {
      return json(400, { message: "Invalid index" });
    }
    const wasReceived = material.items[idx].received;
    material.items[idx].received = !wasReceived;
    material.items[idx].receivedAt = !wasReceived ? new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString() : null;
    await env.LOGISTICS_KV.put(`material:${mDate}`, JSON.stringify(material));
    return json(200, { ok: true, material });
  }

  // ── GET /api/material/:date ──
  const materialMatch = p.match(/^\/api\/material\/(\d{4}-\d{2}-\d{2})$/);
  if (method === "GET" && materialMatch) {
    const raw = await env.LOGISTICS_KV.get(`material:${materialMatch[1]}`);
    if (!raw) return json(404, { message: "해당 날짜 자재 데이터 없음" });
    return json(200, JSON.parse(raw));
  }

  // ── POST /api/alerts/push (API_KEY 인증) ──
  if (method === "POST" && p === "/api/alerts/push") {
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return json(401, { message: "Invalid API key" });
    }
    try {
      const body = await request.json();
      const date = body.date || getTodayKST();
      const key = `alerts:${date}`;
      const raw = await env.LOGISTICS_KV.get(key);
      const alerts = raw ? JSON.parse(raw) : [];

      const items = body.alerts || [];
      let added = 0;
      for (const item of items) {
        // 중복 방지: source + sourceId 동일하면 스킵
        const exists = alerts.some(a => a.source === item.source && a.sourceId === item.sourceId);
        if (!exists) {
          alerts.push({
            source: item.source || "",
            sourceId: item.sourceId || "",
            text: item.text || "",
            priority: item.priority || "warning",
            timestamp: item.timestamp || new Date().toISOString(),
            active: true,
          });
          added++;
        }
      }

      // 자동 해제: deactivate 목록 처리
      const deactivateIds = body.deactivate || [];
      for (const id of deactivateIds) {
        const found = alerts.find(a => a.sourceId === id && a.active);
        if (found) found.active = false;
      }

      await env.LOGISTICS_KV.put(key, JSON.stringify(alerts));
      return json(200, { ok: true, date, added, total: alerts.length });
    } catch { return json(400, { message: "Invalid JSON" }); }
  }

  // ── DELETE /api/alerts/:date/:idx (경고 확인 처리 — idx는 active 항목 기준) ──
  const alertDelMatch = p.match(/^\/api\/alerts\/(\d{4}-\d{2}-\d{2})\/(\d+)$/);
  if (method === "DELETE" && alertDelMatch) {
    const [, alertDate, idxStr] = alertDelMatch;
    const activeIdx = parseInt(idxStr);
    const key = `alerts:${alertDate}`;
    const raw = await env.LOGISTICS_KV.get(key);
    const alerts = raw ? JSON.parse(raw) : [];
    // active 항목 중 N번째를 찾아 비활성화
    let count = 0;
    for (let i = 0; i < alerts.length; i++) {
      if (alerts[i].active !== false) {
        if (count === activeIdx) {
          alerts[i].active = false;
          break;
        }
        count++;
      }
    }
    await env.LOGISTICS_KV.put(key, JSON.stringify(alerts));
    return json(200, { ok: true });
  }

  // ── POST /api/handover (인수인계 추가 — 팀별) ──
  if (method === "POST" && p === "/api/handover") {
    try {
      const body = await request.json();
      const team = body.team;
      const text = (body.text || "").trim();
      if (!team || !text) return json(400, { message: "team, text 필수" });

      const date = body.date || getTodayKST();
      const key = `handover:${date}`;
      const raw = await env.LOGISTICS_KV.get(key);
      const handover = raw ? JSON.parse(raw) : { "권선": [], "사출": [], "전장": [] };
      if (!handover[team]) handover[team] = [];

      const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const time = now.toISOString().slice(11, 16);
      handover[team].unshift({ time, text, author: body.author || "", shift: body.shift || "" });

      await env.LOGISTICS_KV.put(key, JSON.stringify(handover));
      return json(201, { ok: true, handover });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── POST /api/handover/:date/:team/:idx/ack (인수인계 확인) ──
  const handoverAckMatch = p.match(/^\/api\/handover\/([^/]+)\/([^/]+)\/(\d+)\/ack$/);
  if (method === "POST" && handoverAckMatch) {
    const [, hDate, team, idxStr] = handoverAckMatch;
    const decodedTeam = decodeURIComponent(team);
    const idx = parseInt(idxStr);
    try {
      const body = await request.json();
      const key = `handover:${hDate}`;
      const raw = await env.LOGISTICS_KV.get(key);
      const handover = raw ? JSON.parse(raw) : {};
      if (handover[decodedTeam] && idx >= 0 && idx < handover[decodedTeam].length) {
        handover[decodedTeam][idx].acked = true;
        handover[decodedTeam][idx].ackedBy = body.ackedBy || "";
        handover[decodedTeam][idx].ackedAt = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
      }
      await env.LOGISTICS_KV.put(key, JSON.stringify(handover));
      return json(200, { ok: true, handover });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── DELETE /api/handover/:date/:team/:idx ──
  const handoverDelMatch = p.match(/^\/api\/handover\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (method === "DELETE" && handoverDelMatch) {
    const [, hDate, team, idxStr] = handoverDelMatch;
    const decodedTeam = decodeURIComponent(team);
    const idx = parseInt(idxStr);
    const key = `handover:${hDate}`;
    const raw = await env.LOGISTICS_KV.get(key);
    const handover = raw ? JSON.parse(raw) : {};
    if (handover[decodedTeam] && idx >= 0 && idx < handover[decodedTeam].length) {
      handover[decodedTeam].splice(idx, 1);
      await env.LOGISTICS_KV.put(key, JSON.stringify(handover));
    }
    return json(200, { ok: true, handover });
  }

  // ── POST /api/handover/push (API_KEY 인증 — 자동 연동용) ──
  if (method === "POST" && p === "/api/handover/push") {
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return json(401, { message: "Invalid API key" });
    }
    try {
      const body = await request.json();
      const date = body.date || getTodayKST();
      const key = `handover:${date}`;
      const raw = await env.LOGISTICS_KV.get(key);
      const handover = raw ? JSON.parse(raw) : { "권선": [], "사출": [], "전장": [] };

      // entries에 team 필드가 있으면 해당 팀에 추가
      const entries = body.entries || [];
      for (const entry of entries) {
        const team = entry.team || "권선";
        if (!handover[team]) handover[team] = [];
        const text = entry.items ? entry.items.join(" / ") : (entry.text || "");
        if (text) {
          const dup = handover[team].some(h => h.text === text);
          if (!dup) {
            handover[team].unshift({
              time: entry.time || "",
              text,
              author: entry.author || "",
            });
          }
        }
      }

      await env.LOGISTICS_KV.put(key, JSON.stringify(handover));
      return json(200, { ok: true, date });
    } catch { return json(400, { message: "Invalid JSON" }); }
  }

  // ── POST /api/report/upload (API_KEY 인증 — 주간보고서 업로드) ──
  if (method === "POST" && p === "/api/report/upload") {
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return json(401, { message: "Invalid API key" });
    }
    try {
      const body = await request.json();
      const key = `report:${body.weekStart || "latest"}`;
      await env.LOGISTICS_KV.put(key, JSON.stringify({
        filename: body.filename || "주간업무보고.xlsx",
        data: body.data,
        weekStart: body.weekStart,
        weekEnd: body.weekEnd,
        createdAt: body.createdAt || new Date().toISOString(),
      }));
      // 최신 키도 갱신
      await env.LOGISTICS_KV.put("report:latest", JSON.stringify({
        filename: body.filename,
        weekStart: body.weekStart,
        weekEnd: body.weekEnd,
        createdAt: body.createdAt || new Date().toISOString(),
      }));
      return json(200, { ok: true, key });
    } catch { return json(400, { message: "Invalid request" }); }
  }

  // ── GET /api/report/latest (최신 보고서 메타) ──
  if (method === "GET" && p === "/api/report/latest") {
    const raw = await env.LOGISTICS_KV.get("report:latest");
    if (!raw) return json(404, { message: "보고서 없음" });
    return json(200, JSON.parse(raw));
  }

  // ── GET /api/report/download/:weekStart (보고서 다운로드) ──
  const reportDlMatch = p.match(/^\/api\/report\/download\/(.+)$/);
  if (method === "GET" && reportDlMatch) {
    const weekStart = reportDlMatch[1];
    const raw = await env.LOGISTICS_KV.get(`report:${weekStart}`);
    if (!raw) return json(404, { message: "해당 보고서 없음" });
    const report = JSON.parse(raw);
    const binary = Uint8Array.from(atob(report.data), c => c.charCodeAt(0));
    return new Response(binary, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(report.filename)}`,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // ── GET /api/report/list (보고서 목록) ──
  if (method === "GET" && p === "/api/report/list") {
    const list = await env.LOGISTICS_KV.list({ prefix: "report:" });
    const reports = [];
    for (const k of list.keys) {
      if (k.name === "report:latest") continue;
      const raw = await env.LOGISTICS_KV.get(k.name);
      if (raw) {
        const r = JSON.parse(raw);
        reports.push({ weekStart: r.weekStart, weekEnd: r.weekEnd, filename: r.filename, createdAt: r.createdAt });
      }
    }
    reports.sort((a, b) => (b.weekStart || "").localeCompare(a.weekStart || ""));
    return json(200, { reports });
  }

  // ── GET /api/history ──
  if (method === "GET" && p === "/api/history") {
    const list = await env.LOGISTICS_KV.list({ prefix: "history:" });
    const dates = list.keys.map(k => k.name.replace("history:", "")).sort().reverse();
    return json(200, { dates });
  }

  // ── GET /api/history/:date ──
  const histMatch = p.match(/^\/api\/history\/(\d{4}-\d{2}-\d{2})$/);
  if (method === "GET" && histMatch) {
    const raw = await env.LOGISTICS_KV.get(`history:${histMatch[1]}`);
    if (!raw) return json(404, { message: "해당 날짜 기록 없음" });
    return json(200, JSON.parse(raw));
  }

  return json(404, { message: "Not found" });
}

/* ── 날짜 → 해당 주 월요일 키 ── */
function getWeekKey(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() - ((dow === 0 ? 7 : dow) - 1));
  return monday.toISOString().slice(0, 10);
}

/* ── 주말이면 직전 금요일 날짜 반환 ── */
function getWeekdayDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=일, 6=토
  if (dow === 0) { // 일요일 → 금요일(-2)
    d.setUTCDate(d.getUTCDate() - 2);
    return d.toISOString().slice(0, 10);
  }
  if (dow === 6) { // 토요일 → 금요일(-1)
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return null; // 평일
}

/* ── 대시보드 데이터 통합 조회 ── */
async function serveDashboard(env, date) {
  const [planRaw, notesRaw, staffRaw, bomRaw, chatRaw, commRaw, commonRaw, alertsRaw, handoverRaw, materialRaw] = await Promise.all([
    env.LOGISTICS_KV.get(`plan:${date}`),
    env.LOGISTICS_KV.get("notes:persistent"),
    env.LOGISTICS_KV.get("staff:latest"),
    env.LOGISTICS_KV.get("bom:latest"),
    env.LOGISTICS_KV.get(`chat:${date}`),
    env.LOGISTICS_KV.get(`comm:${date}`),
    env.LOGISTICS_KV.get("notices:common"),
    env.LOGISTICS_KV.get(`alerts:${date}`),
    env.LOGISTICS_KV.get(`handover:${date}`),
    env.LOGISTICS_KV.get(`material:${date}`),
  ]);

  // 당일 plan이 없으면: 주말→금요일, 아니면 최대 7일 전까지 fallback
  let plan = planRaw ? JSON.parse(planRaw) : null;
  let fallbackDate = null;
  if (!plan) {
    const fridayDate = getWeekdayDate(date);
    if (fridayDate) {
      const fridayPlan = await env.LOGISTICS_KV.get(`plan:${fridayDate}`);
      if (fridayPlan) {
        plan = JSON.parse(fridayPlan);
        fallbackDate = fridayDate;
      }
    }
    if (!plan) {
      let prev = date;
      for (let i = 0; i < 7; i++) {
        prev = getPrevDateKST(prev);
        const prevPlan = await env.LOGISTICS_KV.get(`plan:${prev}`);
        if (prevPlan) {
          plan = JSON.parse(prevPlan);
          fallbackDate = prev;
          break;
        }
      }
    }
  }

  // 해당 주의 월~금 plan 존재 여부 + 캘린더 이벤트 조회
  const weekKey = getWeekKey(date);
  const calRaw = await env.LOGISTICS_KV.get(`calendar:${weekKey}`);
  const calendarEvents = calRaw ? JSON.parse(calRaw) : {};

  const baseD = new Date(date + "T12:00:00Z");
  const dow = baseD.getUTCDay();
  const monday = new Date(baseD);
  monday.setUTCDate(monday.getUTCDate() - ((dow === 0 ? 7 : dow) - 1));
  const weekPlanDates = [];
  for (let i = 0; i < 5; i++) {
    const wd = new Date(monday);
    wd.setUTCDate(wd.getUTCDate() + i);
    const wdStr = wd.toISOString().slice(0, 10);
    const exists = await env.LOGISTICS_KV.get(`plan:${wdStr}`);
    if (exists) weekPlanDates.push(wdStr);
  }

  // plan notices: 연속 3일 이상 중복 항목 필터링
  if (plan && plan.teams) {
    const prev1 = getPrevDateKST(date);
    const prev2 = getPrevDateKST(prev1);
    const [prev1Raw, prev2Raw] = await Promise.all([
      env.LOGISTICS_KV.get(`plan:${prev1}`),
      env.LOGISTICS_KV.get(`plan:${prev2}`),
    ]);
    const prev1Plan = prev1Raw ? JSON.parse(prev1Raw) : null;
    const prev2Plan = prev2Raw ? JSON.parse(prev2Raw) : null;

    for (const team of Object.keys(plan.teams)) {
      const notices = plan.teams[team]?.notices;
      if (!notices || notices.length === 0) continue;
      const prev1Notices = prev1Plan?.teams?.[team]?.notices || [];
      const prev2Notices = prev2Plan?.teams?.[team]?.notices || [];
      const prev1Texts = new Set(prev1Notices.map(n => n.text));
      const prev2Texts = new Set(prev2Notices.map(n => n.text));
      // 3일 연속 존재하는 항목 제거
      plan.teams[team].notices = notices.filter(n =>
        !(prev1Texts.has(n.text) && prev2Texts.has(n.text))
      );
    }
  }

  // alerts: active 항목만 필터
  const allAlerts = alertsRaw ? JSON.parse(alertsRaw) : [];
  const activeAlerts = allAlerts.filter(a => a.active !== false);

  return json(200, {
    date,
    plan,
    fallbackDate,
    notes: notesRaw ? JSON.parse(notesRaw) : { "권선": [], "사출": [], "전장": [] },
    staff: staffRaw ? JSON.parse(staffRaw) : null,
    bom: bomRaw ? JSON.parse(bomRaw) : null,
    chat: chatRaw ? JSON.parse(chatRaw) : null,
    comm: commRaw ? JSON.parse(commRaw) : null,
    commonNotices: commonRaw ? JSON.parse(commonRaw) : [],
    weekPlanDates,
    calendarEvents,
    alerts: activeAlerts,
    handover: handoverRaw ? JSON.parse(handoverRaw) : { "권선": [], "사출": [], "전장": [] },
    material: materialRaw ? JSON.parse(materialRaw) : null,
  });
}

/* ── 히스토리 스냅샷 ── */
async function snapshotHistory(env, date) {
  const [planRaw, notesRaw, staffRaw, bomRaw, chatRaw, commRaw] = await Promise.all([
    env.LOGISTICS_KV.get(`plan:${date}`),
    env.LOGISTICS_KV.get("notes:persistent"),
    env.LOGISTICS_KV.get("staff:latest"),
    env.LOGISTICS_KV.get("bom:latest"),
    env.LOGISTICS_KV.get(`chat:${date}`),
    env.LOGISTICS_KV.get(`comm:${date}`),
  ]);
  const snapshot = {
    date,
    plan: planRaw ? JSON.parse(planRaw) : null,
    notes: notesRaw ? JSON.parse(notesRaw) : null,
    staff: staffRaw ? JSON.parse(staffRaw) : null,
    bom: bomRaw ? JSON.parse(bomRaw) : null,
    chat: chatRaw ? JSON.parse(chatRaw) : null,
    comm: commRaw ? JSON.parse(commRaw) : null,
    savedAt: new Date().toISOString(),
  };
  await env.LOGISTICS_KV.put(`history:${date}`, JSON.stringify(snapshot));
}

/* ── 스케줄러: 매일 09시(KST) 인수인계 리셋 ── */
async function handleScheduled(env) {
  const today = getTodayKST();
  const yesterday = getPrevDateKST(today);
  // 전일 인수인계 중 미확인 항목은 유지, 전부 확인이면 삭제
  const raw = await env.LOGISTICS_KV.get(`handover:${yesterday}`);
  if (raw) {
    const handover = JSON.parse(raw);
    let allAcked = true;
    for (const team of Object.keys(handover)) {
      if (handover[team].some(item => !item.acked)) {
        allAcked = false;
        break;
      }
    }
    if (allAcked) {
      await env.LOGISTICS_KV.delete(`handover:${yesterday}`);
      console.log(`[cron] handover:${yesterday} 전체 확인됨 → 삭제`);
    } else {
      console.log(`[cron] handover:${yesterday} 미확인 항목 존재 → 유지`);
    }
  }
  // 3일 이상 경과된 전달사항 중 done인 항목 자동 정리
  const notesRaw = await env.LOGISTICS_KV.get("notes:persistent");
  if (notesRaw) {
    const notes = JSON.parse(notesRaw);
    let changed = false;
    for (const team of Object.keys(notes)) {
      const before = notes[team].length;
      notes[team] = notes[team].filter(n => !n.done || !n.doneAt || (Date.now() - new Date(n.doneAt).getTime()) < 3 * 24 * 60 * 60 * 1000);
      if (notes[team].length !== before) changed = true;
    }
    if (changed) {
      await env.LOGISTICS_KV.put("notes:persistent", JSON.stringify(notes));
      console.log(`[cron] 완료된 전달사항 정리됨`);
    }
  }
}

/* ── 메인 핸들러 ── */
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // API 라우트
    if (url.pathname.startsWith("/api/")) {
      return handleAPI(url, request.method, request, env);
    }

    // 정적 파일 (Workers Sites)
    try {
      return await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
      );
    } catch {
      try {
        const fallbackReq = new Request(new URL("/index.html", url.origin), request);
        return await getAssetFromKV(
          { request: fallbackReq, waitUntil: ctx.waitUntil.bind(ctx) },
          { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
        );
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
  },
};
