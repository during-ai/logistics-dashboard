import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import manifestJSON from "__STATIC_CONTENT_MANIFEST";
const assetManifest = JSON.parse(manifestJSON);

/* ── 유틸 ── */
function getTodayKST() {
  const n = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return n.toISOString().slice(0, 10);
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

  // ── GET /api/notes/:date ──
  const notesGetMatch = p.match(/^\/api\/notes\/(\d{4}-\d{2}-\d{2})$/);
  if (method === "GET" && notesGetMatch) {
    const raw = await env.LOGISTICS_KV.get(`notes:${notesGetMatch[1]}`);
    return json(200, raw ? JSON.parse(raw) : { "권선": [], "사출": [], "전장": [] });
  }

  // ── POST /api/notes (전달사항 추가) ──
  if (method === "POST" && p === "/api/notes") {
    try {
      const body = await request.json();
      const date = body.date || getTodayKST();
      const team = body.team;
      const text = (body.text || "").trim();
      if (!team || !text) return json(400, { message: "team, text 필수" });

      const key = `notes:${date}`;
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

  // ── DELETE /api/notes/:date/:team/:idx ──
  const notesDelMatch = p.match(/^\/api\/notes\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/(\d+)$/);
  if (method === "DELETE" && notesDelMatch) {
    const [, date, team, idxStr] = notesDelMatch;
    const decodedTeam = decodeURIComponent(team);
    const idx = parseInt(idxStr);
    const key = `notes:${date}`;
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

/* ── 대시보드 데이터 통합 조회 ── */
async function serveDashboard(env, date) {
  const [planRaw, notesRaw, staffRaw, bomRaw, chatRaw, commRaw] = await Promise.all([
    env.LOGISTICS_KV.get(`plan:${date}`),
    env.LOGISTICS_KV.get(`notes:${date}`),
    env.LOGISTICS_KV.get("staff:latest"),
    env.LOGISTICS_KV.get("bom:latest"),
    env.LOGISTICS_KV.get(`chat:${date}`),
    env.LOGISTICS_KV.get(`comm:${date}`),
  ]);

  return json(200, {
    date,
    plan: planRaw ? JSON.parse(planRaw) : null,
    notes: notesRaw ? JSON.parse(notesRaw) : { "권선": [], "사출": [], "전장": [] },
    staff: staffRaw ? JSON.parse(staffRaw) : null,
    bom: bomRaw ? JSON.parse(bomRaw) : null,
    chat: chatRaw ? JSON.parse(chatRaw) : null,
    comm: commRaw ? JSON.parse(commRaw) : null,
  });
}

/* ── 히스토리 스냅샷 ── */
async function snapshotHistory(env, date) {
  const [planRaw, notesRaw, staffRaw, bomRaw, chatRaw, commRaw] = await Promise.all([
    env.LOGISTICS_KV.get(`plan:${date}`),
    env.LOGISTICS_KV.get(`notes:${date}`),
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
