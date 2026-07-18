/* ── 물류 파트 현황판 — 클라이언트 ── */

const TEAMS = ["권선", "사출", "전장"];
const TEAM_COLORS = { "권선": "team-1", "사출": "team-2", "전장": "team-3" };
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

let currentDate = todayKST();
let dashData = null;
let refreshTimer = null;

/* ── 유틸 ── */
function todayKST() {
  const d = new Date(Date.now() + 9 * 3600000);
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}/${d}(${DAY_NAMES[dt.getDay()]})`;
}

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function flashStatus(msg) {
  const el = document.getElementById("note-status");
  el.textContent = msg;
  setTimeout(() => { el.textContent = ""; }, 3000);
}

/* ── 데이터 로드 ── */
async function loadDashboard(date) {
  try {
    const res = await fetch(`api/dashboard/${date}`);
    if (!res.ok) throw new Error("fetch failed");
    dashData = await res.json();
    render();
  } catch (e) {
    console.error("Dashboard load error:", e);
    document.getElementById("board-container").innerHTML =
      '<div class="loading-overlay">데이터 연동 실패 — 네트워크 상태를 확인하세요.</div>';
  }
}

/* ── 메인 렌더 ── */
function render() {
  if (!dashData) return;
  renderMeta();
  renderStatusStrip();
  renderKPI();
  renderStaff();
  renderSidebar();
  renderBoard();
}

/* ── 상단 메타 ── */
function renderMeta() {
  const plan = dashData.plan;
  const dateLabel = formatDateLabel(dashData.date);
  let extra = "";
  if (dashData.fallbackDate) {
    extra = ` · ${formatDateLabel(dashData.fallbackDate)} 계획 이월 적용`;
  }
  if (plan && plan.pushedAt) {
    const t = new Date(plan.pushedAt);
    extra += ` · 업데이트 ${t.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
  }
  const dow = DAY_NAMES[new Date(dashData.date + "T12:00:00+09:00").getDay()];
  document.getElementById("meta-info").textContent =
    `${dashData.date}(${dow}) · 권선·사출·전장 생산계획 기준${extra}`;
  document.getElementById("tab-date").textContent = dateLabel;
}

/* ── 데이터 소스 상태 ── */
function renderStatusStrip() {
  const plan = dashData.plan;
  const comm = dashData.comm;
  const chat = dashData.chat;
  let html = "";
  html += plan
    ? '<span><span class="ok">●</span> 생산계획 연동</span>'
    : '<span><span class="pending">○</span> 생산계획 미연동</span>';
  html += comm
    ? '<span><span class="ok">●</span> 인수인계 연동</span>'
    : '<span><span class="pending">○</span> 인수인계 대기</span>';
  html += chat
    ? '<span><span class="ok">●</span> 팀 커뮤니케이션 연동</span>'
    : '<span><span class="pending">○</span> 팀 커뮤니케이션 대기</span>';
  document.getElementById("status-strip").innerHTML = html;
}

/* ── KPI ── */
function renderKPI() {
  const plan = dashData.plan;
  if (plan && plan.kpi) {
    document.getElementById("kpi-day").textContent = plan.kpi.linesDay || 0;
    document.getElementById("kpi-night").textContent = plan.kpi.linesNight || 0;
    document.getElementById("kpi-switch").textContent = plan.kpi.switchCount || 0;
    document.getElementById("kpi-resume").textContent = plan.kpi.resumeCount || 0;
  } else {
    ["kpi-day", "kpi-night", "kpi-switch", "kpi-resume"].forEach(id => {
      document.getElementById(id).textContent = "-";
    });
  }
}

/* ── 인원현황 ── */
function renderStaff() {
  const staff = dashData.staff;
  const el = document.getElementById("staff-strip");
  if (!staff || !staff.teams) {
    el.innerHTML = '<div class="staff-label">투입인원</div><div class="staff-team"><span class="staff-team-name">미등록</span></div>';
    return;
  }
  let html = '<div class="staff-label">투입인원</div>';
  for (const t of Object.keys(staff.teams)) {
    const s = staff.teams[t];
    const vacancy = (s.total || 0) - (s.current || 0);
    html += `<div class="staff-team">
      <span class="staff-team-name">${escHtml(t)}</span>
      <span class="staff-count">${s.current || 0}<span class="staff-count-total">/${s.total || 0}명</span></span>
      ${vacancy > 0 ? `<span class="staff-vacancy">결원 ${vacancy}</span>` : ""}
    </div>`;
  }
  el.innerHTML = html;
}

/* ── 사이드바: 경고 + 공통 공지 + 주간 캘린더 + 인수인계 ── */
function renderSidebar() {
  renderAlerts();
  renderCommonNotices();
  renderWeekCalendar();
  renderHandover();
  bindCommonNoteInput();
}

function renderAlerts() {
  const section = document.getElementById("alerts-section");
  const listEl = document.getElementById("alerts-list");
  const titleEl = document.getElementById("alerts-title");
  const alerts = dashData.alerts || [];

  if (alerts.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  titleEl.textContent = `시스템 경고 (${alerts.length}건)`;

  // critical이 하나라도 있으면 섹션 강조
  const hasCritical = alerts.some(a => a.priority === "critical");
  section.style.borderColor = hasCritical ? "#ef4444" : "#f97316";

  let html = '<div class="alert-list">';
  alerts.forEach((alert, idx) => {
    const time = alert.timestamp ? new Date(alert.timestamp).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "";
    html += `<div class="alert-item ${alert.priority || 'warning'}">
      <span class="alert-text">${escHtml(alert.text || "")}</span>
      <span class="alert-time">${time}</span>
      <span class="alert-ack" data-idx="${idx}" data-date="${dashData.date}">확인</span>
    </div>`;
  });
  html += '</div>';
  listEl.innerHTML = html;

  // 확인 버튼 바인딩
  listEl.querySelectorAll(".alert-ack").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        const res = await fetch(`api/alerts/${btn.dataset.date}/${btn.dataset.idx}`, { method: "DELETE" });
        if (res.ok) { flashStatus("경고 확인됨"); await loadDashboard(currentDate); }
      } catch { flashStatus("처리 실패"); }
    });
  });
}

function renderHandover() {
  const el = document.getElementById("handover-content");
  const handover = dashData.handover;

  if (!handover || !handover.entries || handover.entries.length === 0) {
    el.innerHTML = '<div class="sidebar-empty">인수인계 내용 없음</div>';
    return;
  }

  let html = '';
  handover.entries.forEach(entry => {
    html += `<div class="handover-entry">
      <div class="handover-header">
        <span class="handover-shift">${escHtml(entry.shift || "")}</span>
        <span class="handover-meta">${escHtml(entry.author || "")} ${escHtml(entry.time || "")}</span>
      </div>
      <ul class="handover-items">`;
    (entry.items || []).forEach(item => {
      html += `<li>${escHtml(item)}</li>`;
    });
    html += `</ul></div>`;
  });
  el.innerHTML = html;
}

function renderCommonNotices() {
  const el = document.getElementById("common-notices");
  const notices = dashData.commonNotices || [];
  if (notices.length === 0) {
    el.innerHTML = '<div class="sidebar-empty">등록된 공지 없음</div>';
    return;
  }
  let html = '<div class="common-notice-list">';
  notices.forEach((entry, idx) => {
    html += `<div class="common-notice-item">
      <span class="cn-text">${escHtml(entry.text || "")}</span>
      <span class="cn-del" data-idx="${idx}" title="삭제">×</span>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;

  // 삭제 바인딩
  el.querySelectorAll(".cn-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        const res = await fetch(`api/notices/common/${btn.dataset.idx}`, { method: "DELETE" });
        if (res.ok) { flashStatus("삭제됨"); await loadDashboard(currentDate); }
      } catch { flashStatus("삭제 실패"); }
    });
  });
}

function renderWeekCalendar() {
  const el = document.getElementById("week-calendar");
  const today = todayKST();
  const baseDate = new Date(currentDate + "T12:00:00+09:00");
  const dow = baseDate.getUTCDay();
  const monday = new Date(baseDate);
  monday.setUTCDate(monday.getUTCDate() - ((dow === 0 ? 7 : dow) - 1));

  const planDates = dashData.weekPlanDates || [];
  const calEvents = dashData.calendarEvents || {};
  const weekDates = [];

  let html = '';
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayLabel = DAY_NAMES[d.getUTCDay()];
    const dateLabel = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    const isToday = dateStr === today;
    const hasPlan = planDates.includes(dateStr);
    const events = calEvents[dateStr] || [];
    weekDates.push({ dateStr, dayLabel, dateLabel });

    html += `<div class="week-cal-row${isToday ? ' is-today' : ''}">
      <div class="week-cal-header">
        <span class="week-cal-dot${hasPlan ? '' : ' empty'}"></span>
        <span class="week-cal-day">${dayLabel}</span>
        <span class="week-cal-date">${dateLabel}</span>
      </div>`;
    if (events.length > 0) {
      html += `<div class="week-cal-events">`;
      events.forEach((ev, idx) => {
        html += `<div class="week-cal-event">
          <span>${escHtml(ev)}</span>
          <span class="cal-del" data-date="${dateStr}" data-idx="${idx}">×</span>
        </div>`;
      });
      html += `</div>`;
    }
    html += `</div>`;
  }

  // 하단 통합 입력
  html += `<div class="week-cal-add">
    <select class="week-cal-select" id="cal-day-select">
      ${weekDates.map(w => `<option value="${w.dateStr}">${w.dayLabel} ${w.dateLabel}</option>`).join("")}
    </select>
    <input type="text" class="week-cal-input" id="cal-event-input" placeholder="일정 입력 후 Enter">
  </div>`;

  el.innerHTML = html;

  // 입력 바인딩
  const calInput = document.getElementById("cal-event-input");
  const calSelect = document.getElementById("cal-day-select");
  if (calInput) {
    calInput.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const text = calInput.value.trim();
      if (!text) return;
      calInput.disabled = true;
      try {
        const res = await fetch("api/calendar/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: calSelect.value, text }),
        });
        if (res.ok) { calInput.value = ""; flashStatus("저장됨"); await loadDashboard(currentDate); }
        else { flashStatus("저장 실패"); }
      } catch { flashStatus("네트워크 오류"); }
      calInput.disabled = false;
      calInput.focus();
    });
  }

  // 삭제 바인딩
  el.querySelectorAll(".cal-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        const res = await fetch(`api/calendar/event/${btn.dataset.date}/${btn.dataset.idx}`, { method: "DELETE" });
        if (res.ok) { flashStatus("삭제됨"); await loadDashboard(currentDate); }
      } catch { flashStatus("삭제 실패"); }
    });
  });
}

function bindCommonNoteInput() {
  const input = document.getElementById("common-note-input");
  if (!input || input._bound) return;
  input._bound = true;
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      const res = await fetch("api/notices/common", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) { input.value = ""; flashStatus("저장됨"); await loadDashboard(currentDate); }
      else { flashStatus("저장 실패"); }
    } catch { flashStatus("네트워크 오류"); }
    input.disabled = false;
    input.focus();
  });
}

/* ── 3컬럼 보드 ── */
function renderBoard() {
  const container = document.getElementById("board-container");
  const plan = dashData.plan;
  const notes = dashData.notes || {};
  const chat = dashData.chat || {};

  let html = '<div class="board">';
  TEAMS.forEach((team, idx) => {
    const teamPlan = plan && plan.teams ? plan.teams[team] : null;
    html += `<div class="team-col">`;
    html += renderTeamHeader(team, idx, teamPlan);
    html += renderNotices(teamPlan);
    html += renderSwitches(teamPlan);
    html += renderResumes(teamPlan);
    if (team === "사출") {
      html += renderResinChanges(teamPlan);
    } else {
      html += "</div>"; // close day-panel
    }
    html += renderChat(chat[team]);
    html += renderFutureSlot(chat[team]);
    html += renderManualNotes(team, notes[team] || []);
    html += `</div>`;
  });
  html += "</div>";
  container.innerHTML = html;

  // 이벤트 바인딩
  bindNoteInputs();
  bindNoteDeletes();
}

function renderTeamHeader(team, idx, teamPlan) {
  const lines = teamPlan && teamPlan.lines
    ? `주간 ${teamPlan.lines.day || 0} · 야간 ${teamPlan.lines.night || 0}`
    : "";
  return `<div class="team-col-head">
    <span class="dot ${TEAM_COLORS[team]}"></span><span class="team-name">${escHtml(team)}</span>
    <span class="team-lines">${lines}</span>
  </div>`;
}

function renderNotices(teamPlan) {
  if (!teamPlan || !teamPlan.notices || teamPlan.notices.length === 0) {
    return '<ul class="notice-mini"><li class="empty">특이사항 없음</li></ul>';
  }
  let html = '<ul class="notice-mini">';
  teamPlan.notices.forEach(n => {
    html += `<li><span class="ntag">${escHtml(n.tag)}</span>${escHtml(n.text)}</li>`;
  });
  html += "</ul>";
  return html;
}

function renderSwitches(teamPlan) {
  let html = '<div class="day-panel"><div class="day-section-title">ITEM 변경</div>';
  if (!teamPlan || !teamPlan.switches || teamPlan.switches.length === 0) {
    html += '<div class="mini-empty">ITEM 변경 없음</div>';
  } else {
    teamPlan.switches.forEach(sw => {
      const qty = sw.qty ? Number(sw.qty).toLocaleString() : "";
      html += `<div class="mini-row switch">
        <span class="mr-shift">${escHtml(sw.shift || "")}</span>
        <span class="mr-line">${escHtml(String(sw.line || ""))}</span>
        <span class="mr-flow"><span class="mr-from">${escHtml(sw.from || "")}</span>→<span class="mr-to">${escHtml(sw.to || "")}</span></span>
        <span class="mr-qty">${qty}</span>
      </div>`;
    });
  }
  return html;
}

function renderResumes(teamPlan) {
  let html = '<div class="day-section-title muted">재가동 현황</div>';
  if (!teamPlan || !teamPlan.resumes || teamPlan.resumes.length === 0) {
    html += '<div class="mini-empty">해당 없음</div>';
  } else {
    const chips = teamPlan.resumes.map(r => `<span class="chip">${escHtml(r)}</span>`).join(" ");
    html += `<div class="resume-summary"><b>${teamPlan.resumes.length}개 라인</b> ${chips}</div>`;
  }
  return html;
}

function renderResinChanges(teamPlan) {
  if (!teamPlan) return "</div>"; // close day-panel
  if (!teamPlan.resinChanges || teamPlan.resinChanges.length === 0) {
    return `<div class="resin-note empty">
      <div class="resin-note-title">건조기 사전준비 (수지 변경 · BOM 기준)</div>
      <div class="resin-empty-text">수지 변경 없음 — 기존 자재 유지</div>
    </div></div>`;
  }
  let html = `<div class="resin-note"><div class="resin-note-title">건조기 사전준비 (수지 변경 · BOM 기준)</div>`;
  teamPlan.resinChanges.forEach(rc => {
    html += `<div class="resin-row">
      <span class="rr-line">${escHtml(String(rc.line || ""))}</span>
      <span class="rr-item">${escHtml(rc.item || "")}</span>
      <span class="rr-resin">${escHtml(rc.resin || "")}</span>
    </div>`;
  });
  html += "</div></div>"; // close resin-note + day-panel
  return html;
}

function renderChat(chatText) {
  if (!chatText) return "";
  return `<div class="chat-section">
    <div class="chat-section-title">커뮤니케이션 요약</div>
    <div class="chat-bubble">${escHtml(chatText)}</div>
  </div>`;
}

function renderFutureSlot(chatText) {
  if (chatText) return ""; // 이미 톡방 데이터가 있으면 미표시
  return `<div class="future-slot">
    <span class="future-badge">연동 예정</span> 팀 커뮤니케이션(카카오톡) · 인수인계일지(플로우) 연동 시 자동 표시
  </div>`;
}

function renderManualNotes(team, notesList) {
  let html = `<div class="manual-note">
    <div class="manual-log" id="log-${team}">`;
  if (notesList.length > 0) {
    notesList.forEach((entry, idx) => {
      html += `<div class="manual-log-item">
        <span class="mlog-time">${escHtml(entry.time || "")}</span>
        <span class="mlog-text">${escHtml(entry.text || "")}</span>
        <span class="mlog-del" data-team="${team}" data-idx="${idx}" title="삭제">×</span>
      </div>`;
    });
  }
  html += `</div>
    <div class="manual-note-label">현장 전달사항 <span class="manual-hint">(Enter 입력)</span></div>
    <input type="text" class="manual-note-input" data-team="${team}" placeholder="전달사항 입력 후 Enter...">
  </div>`;
  return html;
}

/* ── 이벤트 바인딩 ── */
function bindNoteInputs() {
  document.querySelectorAll(".manual-note-input").forEach(input => {
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const team = input.dataset.team;
      input.disabled = true;
      try {
        const res = await fetch("api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: "persistent", team, text }),
        });
        if (res.ok) {
          input.value = "";
          flashStatus("저장됨");
          await loadDashboard(currentDate);
        } else {
          flashStatus("저장 실패");
        }
      } catch {
        flashStatus("네트워크 오류");
      }
      input.disabled = false;
      input.focus();
    });
  });
}

function bindNoteDeletes() {
  document.querySelectorAll(".mlog-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      const team = btn.dataset.team;
      const idx = btn.dataset.idx;
      try {
        const res = await fetch(`api/notes/persistent/${encodeURIComponent(team)}/${idx}`, {
          method: "DELETE",
        });
        if (res.ok) {
          flashStatus("삭제됨");
          await loadDashboard(currentDate);
        }
      } catch {
        flashStatus("삭제 실패");
      }
    });
  });
}

/* ── 날짜 네비게이션 ── */
function setupDateNav() {
  const picker = document.getElementById("date-picker");
  const btnToday = document.getElementById("btn-today");

  picker.value = currentDate;
  picker.addEventListener("change", () => {
    currentDate = picker.value;
    loadDashboard(currentDate);
  });

  btnToday.addEventListener("click", () => {
    currentDate = todayKST();
    picker.value = currentDate;
    loadDashboard(currentDate);
  });
}

/* ── 초기화 ── */
function init() {
  setupDateNav();
  loadDashboard(currentDate);
  // 30초마다 자동 새로고침 (오늘 날짜일 때만)
  refreshTimer = setInterval(() => {
    if (currentDate === todayKST()) {
      loadDashboard(currentDate);
    }
  }, 30000);
}

document.addEventListener("DOMContentLoaded", init);
