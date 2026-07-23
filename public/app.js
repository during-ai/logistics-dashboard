/* ── 물류 파트 현황판 — 클라이언트 ── */

const TEAMS = ["사출", "전장", "권선"];
const TEAM_COLORS = { "권선": "team-1", "사출": "team-2", "전장": "team-3" };
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

let currentDate = todayKST();
let dashData = null;
let refreshTimer = null;
let prevAlertCount = 0;
let prevNoteCount = 0;
let prevCommonCount = 0;
let lastRefreshTime = null;

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

/* ── 사용자가 입력/선택 중인지 판별 (자동 새로고침이 입력창을 지우는 것 방지) ── */
function isUserTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

/* ── 경고 알림음 (Web Audio API) ── */
function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // 3회 비프음
    [0, 0.3, 0.6].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.value = 0.3;
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.15);
    });
  } catch {}
}

function blinkTitle(message) {
  let blink = 0;
  const orig = document.title;
  const iv = setInterval(() => {
    document.title = blink % 2 === 0 ? message : orig;
    blink++;
    if (blink > 10) { clearInterval(iv); document.title = orig; }
  }, 500);
}

function checkAlertNotification() {
  const alerts = dashData?.alerts || [];
  const criticalCount = alerts.filter(a => a.priority === "critical").length;
  if (criticalCount > 0 && alerts.length > prevAlertCount) {
    playAlertSound();
    blinkTitle("!! 긴급 경고 발생 !!");
  }
  prevAlertCount = alerts.length;
}

function checkNoteNotification() {
  const notes = dashData?.notes || {};
  const common = dashData?.commonNotices || [];
  let noteCount = 0;
  for (const team of Object.keys(notes)) {
    noteCount += (notes[team] || []).length;
  }
  const commonCount = common.length;
  if (prevNoteCount > 0 && noteCount > prevNoteCount) {
    playAlertSound();
    blinkTitle("** 새 전달사항 **");
  }
  if (prevCommonCount > 0 && commonCount > prevCommonCount) {
    playAlertSound();
    blinkTitle("** 새 공지사항 **");
  }
  prevNoteCount = noteCount;
  prevCommonCount = commonCount;
}

/* ── 데이터 로드 ── */
async function loadDashboard(date) {
  try {
    const res = await fetch(`api/dashboard/${date}`);
    if (!res.ok) throw new Error("fetch failed");
    dashData = await res.json();
    lastRefreshTime = new Date();
    render();
  } catch (e) {
    console.error("Dashboard load error:", e);
    document.getElementById("board-container").innerHTML =
      '<div class="loading-overlay">데이터 연동 실패 — 5초 후 재시도합니다.</div>';
    setTimeout(() => loadDashboard(date), 5000);
  }
}

/* ── 메인 렌더 ── */
function render() {
  if (!dashData) return;
  renderHeader();
  renderSidebar();
  renderBoard();
  checkAlertNotification();
  checkNoteNotification();
}

/* ── 통합 헤더 ── */
function renderHeader() {
  const plan = dashData.plan;
  document.getElementById("tab-date").textContent = formatDateLabel(dashData.date);

  // 연동 상태
  document.getElementById("hdr-status").innerHTML = plan
    ? '<span class="ok">●</span> 연동'
    : '<span class="pending">○</span> 미연동';

  // 메타 (업데이트 시각)
  const parts = [];
  if (dashData.fallbackDate) {
    parts.push(`${formatDateLabel(dashData.fallbackDate)} 이월`);
  }
  if (plan && plan.pushedAt) {
    const t = new Date(plan.pushedAt);
    parts.push(`업데이트 ${t.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`);
  }
  if (lastRefreshTime && currentDate === todayKST()) {
    parts.push(`갱신 ${lastRefreshTime.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
  }
  document.getElementById("meta-info").textContent = parts.join(" · ");

  // KPI
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

  // 인원현황
  const staffEl = document.getElementById("hdr-staff");
  const staff = dashData.staff;
  if (staff && staff.teams) {
    let shtml = "";
    for (const t of Object.keys(staff.teams)) {
      const s = staff.teams[t];
      if (!s) continue;
      const vacancy = (s.total || 0) - (s.current || 0);
      shtml += `<span class="hdr-staff-team"><span class="hdr-staff-name">${escHtml(t)}</span>${s.current || 0}<span class="hdr-staff-total">/${s.total || 0}</span>${vacancy > 0 ? `<span class="staff-vacancy">결원${vacancy}</span>` : ""}</span>`;
    }
    staffEl.innerHTML = shtml;
  } else {
    staffEl.innerHTML = "";
  }
}

/* ── 사이드바: 경고 + 공통 공지 + 주간 캘린더 ── */
function renderSidebar() {
  renderAlerts();
  renderMaterial();
  renderCommonNotices();
  renderWeekCalendar();
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

function renderMaterial() {
  const section = document.getElementById("material-section");
  const listEl = document.getElementById("material-list");
  const titleEl = document.getElementById("material-title");
  const material = dashData.material;

  if (!material || !material.items) {
    section.style.display = "none";
    return;
  }
  if (material.items.length === 0) {
    section.style.display = "";
    titleEl.textContent = "자재 부족 현황";
    listEl.innerHTML = '<div class="material-ok">자재 정상</div>';
    if (material.checkedAt) {
      listEl.innerHTML += `<div class="material-footer">마지막 점검: ${material.checkedAt}</div>`;
    }
    return;
  }

  section.style.display = "";
  const summary = material.summary || {};
  const total = summary.total || material.items.length;
  const critical = summary.critical || 0;
  titleEl.textContent = `자재 부족 현황 (${total}건)`;
  section.style.borderColor = critical > 0 ? "#ef4444" : "#f97316";

  let html = '<div class="material-list">';
  material.items.forEach((item, idx) => {
    const priority = item.priority || "warning";
    const receivedClass = item.received ? " received" : "";
    const processes = (item.담당공정 || []).join("/");
    const shortage = item.부족수량 || 0;
    const stock = item.현재재고 || 0;
    const unit = item.단위 || "";
    html += `<div class="material-item ${priority}${receivedClass}">
      <div class="material-item-header">
        <input type="checkbox" class="material-received-check" data-idx="${idx}" data-date="${dashData.date}" ${item.received ? "checked" : ""} title="입고 확인">
        <span class="material-item-name" title="${escHtml(item.자재품번 || "")}">${escHtml(item.자재품명 || "")}</span>
        ${processes ? `<span class="material-item-process">${escHtml(processes)}</span>` : ""}
      </div>
      <div class="material-item-detail">
        <span class="material-shortage">부족 ${Number(shortage).toLocaleString()}${unit}</span>
        <span class="material-stock">재고 ${Number(stock).toLocaleString()}${unit}</span>
        ${item.MOQ ? `<span class="material-moq">MOQ: ${Number(item.MOQ).toLocaleString()}${unit}</span>` : ""}
        ${item.업체 ? `<span class="material-vendor">${escHtml(item.업체)}</span>` : ""}
      </div>
    </div>`;
  });
  html += '</div>';
  if (material.checkedAt) {
    html += `<div class="material-footer">마지막 점검: ${material.checkedAt}</div>`;
  }
  listEl.innerHTML = html;

  // 입고 확인 체크박스 바인딩
  bindMaterialReceived();
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
      <span class="cn-move-wrap">
        ${idx > 0 ? `<span class="cn-move" data-from="${idx}" data-to="${idx - 1}" title="위로">▲</span>` : '<span class="cn-move disabled">▲</span>'}
        ${idx < notices.length - 1 ? `<span class="cn-move" data-from="${idx}" data-to="${idx + 1}" title="아래로">▼</span>` : '<span class="cn-move disabled">▼</span>'}
      </span>
      <span class="cn-text">${escHtml(entry.text || "")}</span>
      <span class="cn-del" data-idx="${idx}" title="삭제">×</span>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;

  // 순서 변경 바인딩
  el.querySelectorAll(".cn-move:not(.disabled)").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        const res = await fetch("api/notices/common/reorder", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: parseInt(btn.dataset.from), to: parseInt(btn.dataset.to) }),
        });
        if (res.ok) { flashStatus("순서 변경됨"); await loadDashboard(currentDate); }
      } catch { flashStatus("변경 실패"); }
    });
  });

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

  // 하단 통합 입력 (날짜 선택기로 미래 날짜도 등록 가능)
  html += `<div class="week-cal-add">
    <input type="date" class="week-cal-date-pick" id="cal-day-select" value="${today}">
    <input type="text" class="week-cal-input" id="cal-event-input" placeholder="일정 입력 후 Enter">
  </div>`;
  html += `<div class="week-cal-preview" id="cal-preview"></div>`;

  el.innerHTML = html;

  // 날짜 선택 시 미리보기
  const calSelect = document.getElementById("cal-day-select");
  const calPreview = document.getElementById("cal-preview");

  async function loadCalPreview(dateStr) {
    if (!dateStr) { calPreview.innerHTML = ""; return; }
    // 현재 주 내 날짜면 이미 위에 표시되므로 미리보기 불필요
    const isThisWeek = weekDates.some(w => w.dateStr === dateStr);
    if (isThisWeek) { calPreview.innerHTML = ""; return; }
    try {
      const res = await fetch(`api/calendar/events/${dateStr}`);
      if (!res.ok) { calPreview.innerHTML = ""; return; }
      const data = await res.json();
      const events = data.events || [];
      if (events.length === 0) {
        calPreview.innerHTML = `<div class="cal-preview-empty">${dateStr} — 등록된 일정 없음</div>`;
      } else {
        let ph = `<div class="cal-preview-title">${dateStr} 등록 일정 (${events.length}건)</div>`;
        events.forEach((ev, idx) => {
          ph += `<div class="cal-preview-item">
            <span>${escHtml(ev)}</span>
            <span class="cal-preview-del" data-date="${dateStr}" data-idx="${idx}">×</span>
          </div>`;
        });
        calPreview.innerHTML = ph;
        // 미리보기 삭제 바인딩
        calPreview.querySelectorAll(".cal-preview-del").forEach(btn => {
          btn.addEventListener("click", async () => {
            try {
              const r = await fetch(`api/calendar/event/${btn.dataset.date}/${btn.dataset.idx}`, { method: "DELETE" });
              if (r.ok) { flashStatus("삭제됨"); loadCalPreview(dateStr); }
            } catch { flashStatus("삭제 실패"); }
          });
        });
      }
    } catch { calPreview.innerHTML = ""; }
  }

  if (calSelect) {
    calSelect.addEventListener("change", () => loadCalPreview(calSelect.value));
  }

  // 입력 바인딩
  const calInput = document.getElementById("cal-event-input");
  if (calInput) {
    calInput.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const text = calInput.value.trim();
      if (!text) return;
      const selectedDay = calSelect.value;
      calInput.disabled = true;
      try {
        const res = await fetch("api/calendar/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: selectedDay, text }),
        });
        if (res.ok) {
          flashStatus("저장됨");
          calInput.value = "";
          calInput.disabled = false;
          // 현재 주 날짜면 전체 새로고침, 미래 날짜면 미리보기만 갱신
          const isThisWeek = weekDates.some(w => w.dateStr === selectedDay);
          if (isThisWeek) {
            await loadDashboard(currentDate);
            const newInput = document.getElementById("cal-event-input");
            if (newInput) newInput.focus();
          } else {
            loadCalPreview(selectedDay);
            calInput.focus();
          }
        } else { flashStatus("저장 실패"); calInput.disabled = false; }
      } catch { flashStatus("네트워크 오류"); calInput.disabled = false; }
    });
  }

  // 삭제 바인딩 (현재 주 이벤트)
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
  const handover = dashData.handover || {};

  let html = '<div class="board">';
  TEAMS.forEach((team, idx) => {
    const teamPlan = plan && plan.teams ? plan.teams[team] : null;
    html += `<div class="team-col">`;
    html += renderTeamHeader(team, idx, teamPlan);
    html += renderNotices(teamPlan);
    html += renderSwitches(team, teamPlan);
    html += renderCombinedNotes(team, notes[team] || [], handover[team] || []);
    html += `</div>`;
  });
  html += "</div>";
  container.innerHTML = html;

  // 이벤트 바인딩
  bindNoteInputs();
  bindNoteDeletes();
  bindNoteChecks();
  bindHandoverInputs();
  bindHandoverDeletes();
  bindHandoverAcks();
  bindSwitchChecks();
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

function isNoticePassed(text) {
  // 텍스트에서 날짜 패턴 추출: (7/14), 7/18, 7월 15일 등
  const patterns = [
    /\((\d{1,2})\/(\d{1,2})\)/g,     // (7/14)
    /(\d{1,2})\/(\d{1,2})/g,          // 7/14
    /(\d{1,2})월\s*(\d{1,2})일/g,     // 7월 14일
  ];
  const today = dashData ? new Date(dashData.date + "T12:00:00+09:00") : new Date();
  const year = today.getFullYear();
  let found = false;
  let allPassed = true;
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      found = true;
      const d = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
      if (d >= today) allPassed = false;
    }
  }
  return found && allPassed;
}

function renderNotices(teamPlan) {
  if (!teamPlan || !teamPlan.notices || teamPlan.notices.length === 0) {
    return '<ul class="notice-mini"><li class="empty">특이사항 없음</li></ul>';
  }
  // 중복 제거 (같은 text)
  const seen = new Set();
  const unique = [];
  for (const n of teamPlan.notices) {
    const key = (n.text || "").trim();
    if (!seen.has(key)) { seen.add(key); unique.push(n); }
  }
  let html = '<ul class="notice-mini">';
  unique.forEach(n => {
    const passed = isNoticePassed(n.text || "");
    html += `<li class="${passed ? 'notice-passed' : ''}"><span class="ntag">${escHtml(n.tag)}</span>${escHtml(n.text)}</li>`;
  });
  html += "</ul>";
  return html;
}

function renderSwitches(team, teamPlan) {
  let html = '<div class="day-panel"><div class="day-section-title">ITEM 변경</div>';
  if (!teamPlan || !teamPlan.switches || teamPlan.switches.length === 0) {
    html += '<div class="mini-empty">ITEM 변경 없음</div>';
  } else {
    // 같은 라인끼리 그룹핑 (순서 유지)
    const lineGroups = [];
    const lineMap = {};
    teamPlan.switches.forEach(sw => {
      const key = String(sw.line || "");
      if (!(key in lineMap)) {
        lineMap[key] = lineGroups.length;
        lineGroups.push({ line: key, equip: sw.equip || "", items: [] });
      }
      lineGroups[lineMap[key]].items.push(sw);
    });

    lineGroups.forEach(grp => {
      const isRestart = grp.items.some(sw => sw.type === "restart");
      const allDone = grp.items.every(sw => sw.done);
      const equipHtml = grp.equip && grp.equip !== grp.line ? `<span class="switch-equip">${escHtml(grp.equip)}</span>` : "";
      const typeTag = isRestart ? `<span class="switch-restart-tag">재가동</span>` : "";

      html += `<div class="switch-card${isRestart ? ' restart' : ''}${allDone ? ' all-done' : ''}">
        <div class="switch-header">
          <span class="switch-line">${escHtml(grp.line)}</span>
          ${equipHtml}${typeTag}
        </div>`;

      grp.items.forEach(sw => {
        const timing = sw.shift || "";
        const midTag = sw.midCount ? `<span class="switch-mid-count">${sw.midCount}회</span>` : "";
        let resinHtml = "";
        if (sw.resin) {
          const resinName = sw.resinGrade ? `${escHtml(sw.resinGrade)}` : escHtml(sw.resin);
          const fromR = sw.fromResin ? `${sw.fromResinGrade ? escHtml(sw.fromResinGrade) : escHtml(sw.fromResin)}→` : "";
          const cond = sw.temp ? ` (${escHtml(sw.temp)}/${escHtml(sw.time)})` : "";
          resinHtml = `<span class="switch-resin-inline">🔸${fromR}${resinName}${cond}</span>`;
        }
        const sig = sw._sig || "";
        const doneAtHtml = sw.done && sw.doneAt ? `<span class="switch-done-at">✓ ${escHtml(sw.doneAt)}</span>` : "";
        html += `<div class="switch-flow-row${sw.done ? ' done' : ''}">
          <input type="checkbox" class="switch-check" data-team="${escHtml(team)}" data-sig="${escHtml(sig)}" ${sw.done ? "checked" : ""} title="변경 완료 체크">
          ${timing ? `<span class="switch-timing${timing.includes('중') ? ' mid-shift' : ''}">${timing}</span>` : ""}
          ${midTag}
          <span class="switch-from-name">${escHtml(sw.from || "")}</span>
          <span class="switch-arrow">→</span>
          <span class="switch-to-name">${escHtml(sw.to || "")}</span>
          ${resinHtml}
          ${doneAtHtml}
        </div>`;
      });

      html += `</div>`;
    });
  }
  html += '</div>';
  return html;
}

function renderCombinedNotes(team, notesList, handoverList) {
  let html = `<div class="combined-notes">
    <div class="combined-notes-title">전달 / 인수인계</div>
    <div class="combined-log">`;
  // 전달사항
  if (notesList.length > 0) {
    notesList.forEach((entry, idx) => {
      const doneClass = entry.done ? " done" : "";
      html += `<div class="manual-log-item${doneClass}">
        <input type="checkbox" class="mlog-check" data-team="${team}" data-idx="${idx}" ${entry.done ? "checked" : ""}>
        <span class="mlog-time">${escHtml(entry.time || "")}</span>
        <span class="mlog-text">${escHtml(entry.text || "")}</span>
        <span class="mlog-del" data-team="${team}" data-idx="${idx}" title="삭제">×</span>
      </div>`;
    });
  }
  // 인수인계
  if (handoverList.length > 0) {
    handoverList.forEach((entry, idx) => {
      const authorTag = entry.author ? `<span class="ho-author">${escHtml(entry.author)}</span>` : "";
      const shiftTag = entry.shift ? `<span class="ho-shift">${escHtml(entry.shift)}</span>` : "";
      const ackedClass = entry.acked ? " acked" : "";
      const ackInfo = entry.acked
        ? `<span class="ho-ack-done">✓ ${escHtml(entry.ackedBy || "")} ${escHtml(entry.ackedAt || "")}</span>`
        : `<button class="ho-ack-btn" data-team="${team}" data-idx="${idx}">확인</button>`;
      html += `<div class="handover-log-item${ackedClass}">
        <div class="ho-meta">${authorTag}${shiftTag}<span class="ho-time">${escHtml(entry.time || "")}</span>${ackInfo}</div>
        <div class="ho-text">${escHtml(entry.text || "")}</div>
        <span class="hlog-del" data-team="${team}" data-idx="${idx}" title="삭제">×</span>
      </div>`;
    });
  }
  html += `</div>
    <div class="combined-inputs">
      <input type="text" class="manual-note-input" data-team="${team}" placeholder="전달사항 입력 후 Enter...">
      <div class="combined-ho-row">
        <input type="text" class="handover-author-input" data-team="${team}" placeholder="이름" id="ho-author-${team}">
        <select class="handover-shift-select" data-team="${team}" id="ho-shift-${team}">
          <option value="주간→야간">주간→야간</option>
          <option value="야간→주간">야간→주간</option>
        </select>
        <input type="text" class="handover-note-input" data-team="${team}" placeholder="인수인계 입력 후 Enter...">
      </div>
    </div>
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

function bindNoteChecks() {
  document.querySelectorAll(".mlog-check").forEach(chk => {
    chk.addEventListener("change", async () => {
      const team = chk.dataset.team;
      const idx = chk.dataset.idx;
      try {
        const res = await fetch(`api/notes/persistent/${encodeURIComponent(team)}/${idx}/done`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (res.ok) { flashStatus("처리됨"); await loadDashboard(currentDate); }
      } catch { flashStatus("처리 실패"); }
    });
  });
}

function bindHandoverAcks() {
  document.querySelectorAll(".ho-ack-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      // 이미 입력 폼이 열려있으면 무시
      if (btn.parentElement.querySelector(".ho-ack-inline")) return;
      const team = btn.dataset.team;
      const idx = btn.dataset.idx;
      // 인라인 입력 폼 생성
      const wrap = document.createElement("span");
      wrap.className = "ho-ack-inline";
      wrap.innerHTML = `<input type="text" class="ho-ack-name-input" placeholder="이름" maxlength="10">
        <button type="button" class="ho-ack-confirm">확인</button>
        <button type="button" class="ho-ack-cancel">취소</button>`;
      btn.style.display = "none";
      btn.parentElement.appendChild(wrap);
      const nameInput = wrap.querySelector(".ho-ack-name-input");
      nameInput.focus();
      async function doAck() {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        try {
          const res = await fetch(`api/handover/${currentDate}/${encodeURIComponent(team)}/${idx}/ack`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ackedBy: name }),
          });
          if (res.ok) { flashStatus("확인 완료"); await loadDashboard(currentDate); }
        } catch { flashStatus("처리 실패"); }
      }
      wrap.querySelector(".ho-ack-confirm").addEventListener("click", doAck);
      nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doAck(); });
      wrap.querySelector(".ho-ack-cancel").addEventListener("click", () => {
        wrap.remove();
        btn.style.display = "";
      });
    });
  });
}

function bindHandoverInputs() {
  document.querySelectorAll(".handover-note-input").forEach(input => {
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const team = input.dataset.team;
      const authorEl = document.getElementById(`ho-author-${team}`);
      const shiftEl = document.getElementById(`ho-shift-${team}`);
      const author = authorEl ? authorEl.value.trim() : "";
      const shift = shiftEl ? shiftEl.value : "";
      input.disabled = true;
      try {
        const res = await fetch("api/handover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: currentDate, team, text, author, shift }),
        });
        if (res.ok) {
          flashStatus("저장됨");
          await loadDashboard(currentDate);
          // 새로 렌더된 DOM에서 해당 팀 입력란 찾아 focus + 값 복원
          const newInput = document.querySelector(`.handover-note-input[data-team="${team}"]`);
          if (newInput) newInput.focus();
          const newAuthor = document.getElementById(`ho-author-${team}`);
          if (newAuthor) newAuthor.value = author;
          const newShift = document.getElementById(`ho-shift-${team}`);
          if (newShift) newShift.value = shift;
        } else {
          flashStatus("저장 실패");
          input.disabled = false;
        }
      } catch {
        flashStatus("네트워크 오류");
        input.disabled = false;
      }
    });
  });
}

function bindHandoverDeletes() {
  document.querySelectorAll(".hlog-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      const team = btn.dataset.team;
      const idx = btn.dataset.idx;
      try {
        const res = await fetch(`api/handover/${currentDate}/${encodeURIComponent(team)}/${idx}`, {
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

function bindSwitchChecks() {
  document.querySelectorAll(".switch-check").forEach(chk => {
    chk.addEventListener("change", async () => {
      const team = chk.dataset.team;
      const sig = chk.dataset.sig;
      // plan의 실제 날짜(fallback 포함) 기준으로 저장
      const planDate = (dashData && dashData.fallbackDate) ? dashData.fallbackDate : currentDate;
      chk.disabled = true;
      try {
        const res = await fetch(`api/switch/${planDate}/${encodeURIComponent(team)}/done`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sig }),
        });
        if (res.ok) { flashStatus("완료 처리됨"); await loadDashboard(currentDate); }
        else { flashStatus("처리 실패"); chk.disabled = false; }
      } catch { flashStatus("처리 실패"); chk.disabled = false; }
    });
  });
}

function bindMaterialReceived() {
  document.querySelectorAll(".material-received-check").forEach(chk => {
    chk.addEventListener("change", async () => {
      const idx = chk.dataset.idx;
      const date = chk.dataset.date;
      try {
        const res = await fetch(`api/material/${date}/received/${idx}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (res.ok) { flashStatus("입고 확인 처리됨"); await loadDashboard(currentDate); }
      } catch { flashStatus("처리 실패"); }
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

/* ── 검색 기능 ── */
function setupSearch() {
  const panel = document.getElementById("search-panel");
  const btnSearch = document.getElementById("btn-search");
  const btnClose = document.getElementById("search-close");
  const input = document.getElementById("search-input");
  const btnGo = document.getElementById("search-go");
  const results = document.getElementById("search-results");

  btnSearch.addEventListener("click", () => {
    panel.style.display = "flex";
    input.focus();
  });
  btnClose.addEventListener("click", () => { panel.style.display = "none"; });
  panel.addEventListener("click", (e) => {
    if (e.target === panel) panel.style.display = "none";
  });

  async function doSearch() {
    const keyword = input.value.trim();
    if (!keyword) return;
    const searchDays = 30;
    results.innerHTML = `<div class="search-loading">검색 중... (0/${searchDays}일)</div>`;

    // 최근 30일간 데이터 검색
    const found = [];
    const today = todayKST();
    let d = today;
    for (let i = 0; i < searchDays; i++) {
      const prog = results.querySelector(".search-loading");
      if (prog) prog.textContent = `검색 중... (${i + 1}/${searchDays}일)`;
      try {
        const res = await fetch(`api/dashboard/${d}`);
        if (res.ok) {
          const data = await res.json();
          // 전달사항 검색
          const notes = data.notes || {};
          for (const team of Object.keys(notes)) {
            (notes[team] || []).forEach(n => {
              if (n.text && n.text.includes(keyword)) {
                found.push({ date: d, type: "전달사항", team, text: n.text, time: n.time });
              }
            });
          }
          // 인수인계 검색
          const ho = data.handover || {};
          for (const team of Object.keys(ho)) {
            (ho[team] || []).forEach(h => {
              if (h.text && h.text.includes(keyword)) {
                found.push({ date: d, type: "인수인계", team, text: h.text, author: h.author, time: h.time });
              }
            });
          }
          // 공통공지 검색
          (data.commonNotices || []).forEach(cn => {
            if (cn.text && cn.text.includes(keyword)) {
              found.push({ date: d, type: "공통공지", text: cn.text });
            }
          });
        }
      } catch {}
      // 이전 날짜로 이동
      const prev = new Date(d + "T12:00:00Z");
      prev.setUTCDate(prev.getUTCDate() - 1);
      d = prev.toISOString().slice(0, 10);
    }

    if (found.length === 0) {
      results.innerHTML = '<div class="search-empty">검색 결과 없음</div>';
      return;
    }
    let html = `<div class="search-count">${found.length}건 발견</div>`;
    found.forEach(item => {
      html += `<div class="search-result-item">
        <span class="sr-date">${item.date}</span>
        <span class="sr-type">${escHtml(item.type)}</span>
        ${item.team ? `<span class="sr-team">${escHtml(item.team)}</span>` : ""}
        <span class="sr-text">${escHtml(item.text)}</span>
      </div>`;
    });
    results.innerHTML = html;
  }

  btnGo.addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
}

/* ── 초기화 ── */
function init() {
  setupDateNav();
  setupSearch();
  loadDashboard(currentDate);
  // 30초마다 자동 새로고침 (오늘 날짜일 때만)
  // 단, 사용자가 인계사항/공지 등을 입력·선택 중이면 건너뜀 (입력값·포커스 유실 방지)
  refreshTimer = setInterval(() => {
    if (currentDate === todayKST() && !isUserTyping()) {
      loadDashboard(currentDate);
    }
  }, 30000);
}

document.addEventListener("DOMContentLoaded", init);
