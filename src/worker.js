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

  // ── POST /api/plan/push (API_KEY 인증) ──
  if (method === "POST" && p === "/api/plan/push") {
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return json(401, { message: "Invalid API key" });
    }
    try {
      const body = await request.json();
      const date = body.date || getTodayKST();
      await env.LOGISTICS_KV.put(`plan:${date}`, JSON.stringify(body));
      await snapshotHistory(env, date);
      return json(200, { ok: true, date });
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

  // ── POST /api/handover/push (API_KEY 인증) ──
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
      const existing = raw ? JSON.parse(raw) : { date, entries: [] };

      const newEntries = body.entries || [];
      for (const entry of newEntries) {
        // 중복 방지: shift + author + time 동일하면 스킵
        const dup = existing.entries.some(e =>
          e.shift === entry.shift && e.author === entry.author && e.time === entry.time
        );
        if (!dup) {
          existing.entries.push(entry);
        }
      }

      await env.LOGISTICS_KV.put(key, JSON.stringify(existing));
      return json(200, { ok: true, date, total: existing.entries.length });
    } catch { return json(400, { message: "Invalid JSON" }); }
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
  const [planRaw, notesRaw, staffRaw, bomRaw, chatRaw, commRaw, commonRaw, alertsRaw, handoverRaw] = await Promise.all([
    env.LOGISTICS_KV.get(`plan:${date}`),
    env.LOGISTICS_KV.get("notes:persistent"),
    env.LOGISTICS_KV.get("staff:latest"),
    env.LOGISTICS_KV.get("bom:latest"),
    env.LOGISTICS_KV.get(`chat:${date}`),
    env.LOGISTICS_KV.get(`comm:${date}`),
    env.LOGISTICS_KV.get("notices:common"),
    env.LOGISTICS_KV.get(`alerts:${date}`),
    env.LOGISTICS_KV.get(`handover:${date}`),
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
    handover: handoverRaw ? JSON.parse(handoverRaw) : null,
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

/* ── 메인 핸들러 ── */
export default {
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
