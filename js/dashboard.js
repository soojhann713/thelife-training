// 메인 화면 컨트롤러: RTDB(/posts/<이름>)를 한 번 읽어
//   - 대시보드(이번 달 큐티 완주 현황 + 최근 글 피드)
//   - 멤버별(접이식 사이드바 탭): 글 목록 + 카테고리 필터 + 색상
//   - 글 클릭 시 본문 모달(저장된 content 표시, 없으면 원문 링크 안내)
// 를 렌더링합니다.
import { db } from "./firebase-config.js";
import { ref, get, set, update, remove } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  QT_TARGET_NAMES,
  TARGET_NAMES,
  extractQtDays,
  rateColor,
  categorize,
  categoryColor,
  isNotice,
  postNum,
} from "./config.js";
import {
  COURSES,
  courseSeed,
  assignKindColor,
  SERMON_CATEGORY,
  isSermonTask,
  matchSermonPosts,
} from "./assignments.js";
import { initExport, cohortOf, docTitleFor, fileNameFor } from "./hwpx/export-ui.js";
import { toParagraphs } from "./hwpx/compile.js";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function catBadge(cat) {
  const [bg, fg] = categoryColor(cat);
  return `<span class="post-cat" style="background:${bg}; color:${fg};">${esc(cat)}</span>`;
}

let postsByName = {}; // { name: [post, ...] }
let assignStatus = {}; // { name: { assignmentId: true } }
let qtManual = {}; // { name: { "YYYY-MM-DD": true } } — 글 없이 직접 기록한 큐티 완주일(관리자만 편집)
let expandedQt = new Set(); // 현재 펼쳐진 큐티 행(이름) — 재렌더 후 펼침 유지
let wired = false; // 사이드바/모달 등 1회성 배선 완료 여부
let currentIdentity = null; // 현재 로그인 계정 식별자(classId|admin) — 바뀌면 재초기화
let activeKey = "__dash"; // 현재 보고 있는 탭 (__dash / __admin / 멤버 이름)
let isAdmin = false;
let myClassId = ""; // 로그인한 반 id (관리자는 전체 열람이므로 미사용)
let classesById = {}; // { classId: { id, label, courseId, active, due } } — 훈련 반(로그인 단위)
let coursesById = {}; // { courseId: { id, label, tasks: [{id,title,kind,group,order,due,m,x}] } } — 커리큘럼
let courseSel = ""; // 커리큘럼 관리에서 선택된 courseId
let dueTargetSel = ""; // 마감일 편집 대상: "" = 커리큘럼 기본, 아니면 classId(반별)
let memberList = []; // [{name, qt, active, class}] — 스코프 적용된 목록
let memberNames = []; // 수집/표시 대상 (active)
let qtNames = []; // 큐티 집계 대상 (qt)

// RTDB /classes 로드 → classesById. 반(로그인 단위)이며 courseId 로 커리큘럼(과제) 연결.
async function loadClassesMap() {
  const map = {};
  try {
    const snap = await get(ref(db, "classes"));
    if (snap.exists()) {
      for (const [id, c] of Object.entries(snap.val())) {
        if (!c || typeof c !== "object") continue;
        map[id] = {
          id,
          label: c.label || id,
          courseId: c.courseId || "",
          active: !(c.active === false),
          due: (c.due && typeof c.due === "object") ? c.due : {}, // 반별 마감일 오버레이 {taskId: "YYYY-MM-DD"}
        };
      }
    }
  } catch (_) { /* 없으면 빈 맵 */ }
  return map;
}

// RTDB /courses 로드 → coursesById. 없는 코스는 코드 시드(COURSES)로 폴백.
async function loadCoursesMap() {
  const map = {};
  // 1) 코드 시드로 기본 채움 (RTDB 미시드 코스도 동작)
  for (const c of COURSES) {
    const seed = courseSeed(c);
    map[c.id] = { id: c.id, label: seed.label, tasks: tasksFromObj(seed.tasks) };
  }
  // 2) RTDB 값으로 덮어씀 (편집된 커리큘럼이 우선)
  try {
    const snap = await get(ref(db, "courses"));
    if (snap.exists()) {
      for (const [id, c] of Object.entries(snap.val())) {
        if (!c || typeof c !== "object") continue;
        map[id] = { id, label: c.label || id, tasks: tasksFromObj(c.tasks || {}) };
      }
    }
  } catch (_) { /* 시드만 사용 */ }
  return map;
}

// tasks 객체({id:{...}}) → 배열(order 정렬), 필드 보정.
function tasksFromObj(obj) {
  return Object.entries(obj || {})
    .map(([id, t]) => ({
      id,
      title: (t && t.title) || "",
      kind: (t && t.kind) || "기타",
      group: (t && t.group) || "",
      order: (t && typeof t.order === "number") ? t.order : 0,
      due: (t && t.due) || "",
      m: (t && Array.isArray(t.m)) ? t.m : [],
      x: (t && Array.isArray(t.x)) ? t.x : [],
      // 설교간증 매칭용. 없으면 assignments.js 가 id 에서 되살립니다.
      service: (t && t.service) || "",
      serviceDate: (t && t.serviceDate) || "",
    }))
    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

// 멤버의 소속 반 id. class 우선, 없으면 예전 course 값을 반 id 로 간주(마이그레이션 호환).
function memberClassId(m) {
  return (m && m.class) || (m && m.course) || "";
}
// 멤버의 채점 커리큘럼(course) id — 반의 courseId, 없으면 예전 course 값 폴백.
function memberCourseId(m) {
  const cid = memberClassId(m);
  const cls = classesById[cid];
  return (cls && cls.courseId) || (m && m.course) || "";
}

// (courseId, classId) → 과제 목록에 그 반의 마감일 오버레이를 적용한 배열.
function effectiveTasks(courseId, classId) {
  const c = coursesById[courseId];
  if (!c) return [];
  const dueMap = (classesById[classId] && classesById[classId].due) || {};
  return c.tasks.map((t) => ({ ...t, due: dueMap[t.id] || t.due || "" }));
}

// RTDB /members 로드 → [{name, qt, active, class}]. 없으면 config 기본값으로 폴백.
async function loadMemberListRaw() {
  try {
    const snap = await get(ref(db, "members"));
    if (snap.exists()) {
      const val = snap.val();
      const list = Object.entries(val)
        .map(([key, m]) => ({
          name: (m && m.name) || key,
          qt: !(m && m.qt === false),
          active: !(m && m.active === false),
          // class 우선, 없으면 예전 course 를 반 id 로 간주
          class: (m && typeof m.class === "string") ? m.class
            : (m && typeof m.course === "string") ? m.course : "",
        }))
        .filter((m) => m.name)
        .sort((a, b) => a.name.localeCompare(b.name, "ko"));
      if (list.length) return list;
    }
  } catch (_) { /* 폴백 */ }
  const defClass = COURSES[0] ? COURSES[0].id : "";
  return TARGET_NAMES.map((n) => ({
    name: n,
    qt: QT_TARGET_NAMES.includes(n),
    active: true,
    class: QT_TARGET_NAMES.includes(n) ? defClass : "",
  }));
}

// 로그인한 반으로 스코프: 관리자는 전체, 일반 반은 자기 반 멤버만.
function scopeMembers(all) {
  if (isAdmin) return all;
  return all.filter((m) => memberClassId(m) === myClassId);
}

// 공지글 제거 + 게시글 번호(num) 기준 중복 제거(본문 있는 항목 우선).
function cleanPosts(arr) {
  const byNum = new Map();
  const noNum = [];
  for (const p of arr) {
    if (!p || !p.title || isNotice(p.title)) continue;
    const num = postNum(p.link);
    if (!num) { noNum.push(p); continue; }
    const prev = byNum.get(num);
    if (!prev || (!prev.content && p.content)) byNum.set(num, p);
  }
  return [...byNum.values(), ...noNum];
}

async function loadAllPosts(names) {
  const result = {};
  let firstError = null;
  await Promise.all(
    names.map(async (name) => {
      try {
        const snap = await get(ref(db, `posts/${name}`));
        result[name] = snap.exists() ? cleanPosts(Object.values(snap.val())) : [];
      } catch (e) {
        result[name] = [];
        if (!firstError) firstError = e;
      }
    })
  );
  return { result, firstError };
}

function showNotice(html) {
  const el = document.getElementById("notice");
  el.innerHTML = html;
  el.hidden = false;
}

/* ===================== 글 보기 모달 ===================== */
function openPostModal(post) {
  const cat = post.category || categorize(post.title);
  const [bg, fg] = categoryColor(cat);
  const catEl = document.getElementById("modal-cat");
  catEl.textContent = cat;
  catEl.style.background = bg;
  catEl.style.color = fg;
  document.getElementById("modal-title").textContent = post.title || "";
  document.getElementById("modal-meta").textContent =
    [post.name, post.postDate].filter(Boolean).join(" · ");

  const body = document.getElementById("modal-body");
  if (post.content && post.content.trim()) {
    body.className = "modal-body";
    body.textContent = post.content; // pre-wrap CSS로 줄바꿈 유지 (안전: 텍스트로 삽입)
  } else {
    body.className = "modal-body empty";
    body.textContent = post.link
      ? "본문이 아직 저장되지 않았습니다. 아래 ‘원문 열기’로 확인하세요."
      : "저장된 내용이 없습니다.";
  }

  // 원문 링크가 있는 글에만 '원문 열기' 노출 (수동 기록은 링크 없음)
  const link = document.getElementById("modal-link");
  if (post.link) {
    link.href = post.link;
    link.hidden = false;
  } else {
    link.removeAttribute("href");
    link.hidden = true;
  }

  const modal = document.getElementById("post-modal");
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  document.getElementById("post-modal").hidden = true;
  // 주차 목록 모달이 아직 열려 있으면 스크롤 잠금 유지
  if (document.getElementById("week-modal").hidden) document.body.style.overflow = "";
}

// 클릭 시 모달을 여는 글 링크 HTML (data-key 로 위치 식별)
function postLinkHtml(listId, idx, title) {
  return `<a class="post-title" href="#" data-list="${listId}" data-idx="${idx}">${esc(title)}</a>`;
}

// 컨테이너 내 .post-title 클릭 → 모달 (이벤트 위임)
function wirePostClicks(container, list) {
  container.querySelectorAll(".post-title").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const idx = Number(a.dataset.idx);
      if (!Number.isNaN(idx) && list[idx]) openPostModal(list[idx]);
    });
  });
}

/* ===================== 대시보드 ===================== */
let selectedYM = null; // 보고 있는 달 "YYYY-MM" (기본: 이번 달)

function ymKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// 글의 등록일(postDate)로부터 선택 가능한 달 목록(내림차순). 이번 달은 항상 포함.
function availableMonths() {
  const set = new Set();
  for (const arr of Object.values(postsByName)) {
    for (const p of arr || []) {
      const m = String((p && p.postDate) || "").match(/^(\d{4})\.(\d{2})/);
      if (m && m[1] !== "0000") set.add(`${m[1]}-${m[2]}`);
    }
  }
  set.add(ymKey(new Date()));
  return [...set].sort().reverse();
}

function populateMonthDropdown() {
  const sel = document.getElementById("qt-month");
  if (!sel) return;
  const months = availableMonths();
  if (!selectedYM || !months.includes(selectedYM)) selectedYM = months[0];
  sel.innerHTML = months
    .map((ym) => {
      const [y, m] = ym.split("-");
      return `<option value="${ym}"${ym === selectedYM ? " selected" : ""}>${y}년 ${Number(m)}월</option>`;
    })
    .join("");
  if (!sel.dataset.wired) {
    sel.dataset.wired = "1";
    sel.addEventListener("change", () => {
      selectedYM = sel.value;
      renderQtTable();
    });
  }
}

// 그 달을 일요일~토요일 기준 주차로 분할. 1일이 속한 주가 1주차.
function buildWeeks(year, month, daysInMonth) {
  const weeks = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay(); // 0=일
    if (d === 1 || dow === 0) weeks.push({ idx: weeks.length + 1, start: d, end: d, count: 0 });
    weeks[weeks.length - 1].end = d;
  }
  return weeks;
}

// 수동 완주 기록의 내용(본문) 추출. 값은 true(레거시) 또는 { content, createdAt }.
function manualContent(v) {
  return (v && typeof v === "object" && typeof v.content === "string") ? v.content : "";
}

// 수동 완주 기록(YYYY-MM-DD, 내용 포함)을 글 보기 모달과 같은 형태의 유사(pseudo) 글로 변환.
// 스크래핑 글과 동일한 postDate 표기(YYYY.MM.DD)로 맞춰 목록 정렬이 자연스럽게 섞이게 함.
function manualToPost(name, date, v) {
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const postDate = m ? `${m[1]}.${m[2]}.${m[3]}` : String(date);
  return {
    name,
    date,
    postDate,
    title: `큐티 완주 (수동 기록)`,
    content: manualContent(v),
    link: "", // 원문 없음 → 모달에서 '원문 열기' 숨김
    category: "수동",
    isManual: true,
  };
}

// 특정 멤버의 그달 수동 완주 기록 목록: [{ day, date, post }]. qtManual/<이름>/<YYYY-MM-DD>.
function manualEntriesFor(name, year, month, daysInMonth) {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const obj = qtManual[name] || {};
  const out = [];
  for (const key of Object.keys(obj)) {
    if (!obj[key] || !key.startsWith(prefix)) continue;
    const d = parseInt(key.slice(prefix.length), 10);
    if (d >= 1 && d <= daysInMonth) out.push({ day: d, date: key, post: manualToPost(name, key, obj[key]) });
  }
  out.sort((a, b) => a.day - b.day);
  return out;
}

// 한 멤버의 모든(월 무관) 수동 완주 기록을 유사 글 배열로 (멤버 글 목록용).
function manualAllPosts(name) {
  const obj = qtManual[name] || {};
  const out = [];
  for (const key of Object.keys(obj)) {
    if (!obj[key] || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    out.push(manualToPost(name, key, obj[key]));
  }
  return out;
}

// 한 멤버의 선택한 달 '큐티나눔' 글과 각 글의 큐티 날짜 추출 + 수동 완주일 병합.
function memberQtData(name, year, month, daysInMonth) {
  const items = []; // { post, days: [d,...] }
  const uniqueDays = new Set();
  for (const p of postsByName[name] || []) {
    const title = (p && p.title) || "";
    if (title.replace(/\s+/g, "").indexOf("큐티나눔") === -1) continue;
    const days = [...new Set(extractQtDays(title, year, month, daysInMonth))];
    if (!days.length) continue;
    for (const d of days) uniqueDays.add(d);
    items.push({ post: { ...p, name, category: categorize(title) }, days });
  }
  // 글 없이 직접 기록한 완주일도 집계에 포함(글 날짜와 겹치면 Set이 자동 중복 제거)
  const manualEntries = manualEntriesFor(name, year, month, daysInMonth);
  const manualDays = new Set(manualEntries.map((e) => e.day));
  for (const d of manualDays) uniqueDays.add(d);
  return { items, uniqueDays, manualDays, manualEntries };
}

// 주차별 클릭 시 보여줄 글 목록 저장소 ("이름|주차" → [post, ...])
let weekPostIndex = {};

function weeklyBreakdownHtml(name, year, month, daysInMonth, qtData) {
  const weeks = buildWeeks(year, month, daysInMonth);
  for (const w of weeks) {
    const daysInWeek = new Set();
    const posts = [];
    const seen = new Set();
    for (const it of qtData.items) {
      if (!it.days.some((d) => d >= w.start && d <= w.end)) continue;
      for (const d of it.days) if (d >= w.start && d <= w.end) daysInWeek.add(d);
      const key = it.post.link || it.post.title;
      if (!seen.has(key)) { seen.add(key); posts.push(it.post); }
    }
    // 수동 완주 기록도 주차 횟수에 포함(클릭 시 내용 모달로 볼 수 있게 유사 글로 보관)
    const manualPosts = [];
    for (const e of qtData.manualEntries || []) {
      if (e.day >= w.start && e.day <= w.end) { daysInWeek.add(e.day); manualPosts.push(e.post); }
    }
    w.count = daysInWeek.size;
    weekPostIndex[`${name}|${w.idx}`] = { posts, manualPosts };
  }
  return (
    `<div class="week-grid">` +
    weeks
      .map((w) => {
        const clickable = w.count > 0;
        const attrs = clickable
          ? ` data-name="${esc(name)}" data-week="${w.idx}" role="button" tabindex="0"`
          : "";
        return `<div class="week-item">
          <span class="week-label">${month}월 ${w.idx}주차 <span class="week-range">(${month}월${w.start}일~${month}월${w.end}일)</span></span>
          <span class="week-count${w.count ? "" : " zero"}${clickable ? " clickable" : ""}"${attrs}>${w.count}회</span>
        </div>`;
      })
      .join("") +
    `</div>`
  );
}

// 관리자용: 글을 올리지 않는 멤버의 큐티 완주일(+내용)을 직접 추가/삭제하는 패널.
function manualEditorHtml(name, year, month, daysInMonth) {
  const mm = String(month).padStart(2, "0");
  const min = `${year}-${mm}-01`;
  const max = `${year}-${mm}-${String(daysInMonth).padStart(2, "0")}`;
  const entries = manualEntriesFor(name, year, month, daysInMonth);
  const chips = entries.length
    ? entries.map((e) => {
        const hasContent = !!e.post.content;
        return `<span class="manual-day${hasContent ? " has-content" : ""}">
          <button class="manual-view" data-name="${esc(name)}" data-date="${e.date}" title="${hasContent ? "내용 보기" : "내용 없음"}">${month}월 ${e.day}일${hasContent ? " 📄" : ""}</button>
          <button class="manual-del" data-name="${esc(name)}" data-date="${e.date}" title="삭제" aria-label="삭제">✕</button>
        </span>`;
      }).join("")
    : `<span class="muted">직접 추가한 완주일이 없습니다.</span>`;
  return `<div class="manual-qt">
    <div class="manual-qt-h">✋ 수동 완주일 <span class="muted">(글을 올리지 않는 멤버의 완주일을 직접 추가 · 내용은 선택)</span></div>
    <div class="manual-qt-add">
      <input type="date" class="manual-date" min="${min}" max="${max}" />
      <textarea class="manual-content" rows="2" placeholder="내용(선택) — 적어두면 클릭해서 볼 수 있어요"></textarea>
      <button class="btn btn-primary manual-add" data-name="${esc(name)}">추가</button>
    </div>
    <div class="manual-qt-list">${chips}</div>
  </div>`;
}

// 수동 완주 기록 저장/삭제 후 표를 다시 그림(펼침 상태는 expandedQt 로 유지).
// 값: 내용이 있으면 { content, createdAt }, 없으면 true (레거시 호환).
async function saveManualDay(name, date, want, content) {
  const text = (content || "").trim();
  const value = want ? (text ? { content: text, createdAt: new Date().toISOString() } : true) : null;
  try {
    await set(ref(db, `qtManual/${name}/${date}`), value);
    if (!qtManual[name]) qtManual[name] = {};
    if (want) qtManual[name][date] = value; else delete qtManual[name][date];
    renderQtTable();
  } catch (e) {
    alert((want ? "추가" : "삭제") + " 실패: " + (e.message || e) +
      "\n(관리자 권한 + RTDB qtManual write 규칙이 필요합니다)");
  }
}

// 수동 기록 클릭 시 내용 모달 열기 (저장된 값에서 내용을 읽어 유사 글로 표시).
function openManualModal(name, date) {
  openPostModal(manualToPost(name, date, (qtManual[name] || {})[date]));
}

function renderQtTable() {
  populateMonthDropdown();
  const now = new Date();
  const [year, month] = selectedYM.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const dayToday = isCurrentMonth ? Math.min(now.getDate(), daysInMonth) : daysInMonth;

  document.getElementById("qt-title").textContent =
    `📊 ${year}년 ${month}월 큐티 완주 현황`;
  document.getElementById("qt-meta").textContent =
    isCurrentMonth ? `달성률 = 월 전체 (괄호: ${month}/${dayToday}까지)` : `달성률 = 월 전체`;

  weekPostIndex = {};
  const rows = memberList.filter((m) => m.qt).map((m) => {
    const name = m.name;
    const qtData = memberQtData(name, year, month, daysInMonth);
    const count = qtData.uniqueDays.size;
    const rate = (count / daysInMonth) * 100;
    const todayRate = dayToday > 0 ? Math.min((count / dayToday) * 100, 100) : 0;
    return { name, classId: memberClassId(m), count, rate, todayRate, qtData };
  });

  // 반(class)별 그룹핑 — 미배정은 '미등록'으로 묶어 맨 뒤에
  const groups = new Map();
  for (const r of rows) {
    const key = r.classId || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === "") return 1; // 미등록 맨 뒤
    if (b === "") return -1;
    return classLabelOf(a).localeCompare(classLabelOf(b), "ko");
  });

  const headRow = `<thead><tr>
      <th class="caret-cell"></th><th>순위</th><th>성함</th><th>큐티 횟수</th><th>달성률${isCurrentMonth ? " (오늘까지)" : ""}</th><th></th></tr></thead>`;
  const rowHtml = (r, i) => {
    const color = rateColor(r.rate);
    const todayColor = rateColor(r.todayRate);
    const sub = isCurrentMonth
      ? ` <span class="rate-sub" style="color:${todayColor};">(${r.todayRate.toFixed(1)}%)</span>`
      : "";
    return `<tr class="qt-row" data-name="${esc(r.name)}" title="클릭하면 주차별 큐티 횟수">
      <td class="caret-cell"><span class="caret">▸</span></td>
      <td class="rank">${i + 1}</td>
      <td class="name">${esc(r.name)}</td>
      <td>${r.count} / ${daysInMonth}</td>
      <td style="color:${color}; font-weight:700;">${r.rate.toFixed(1)}%${sub}</td>
      <td class="bar-cell"><div class="bar"><div class="bar-fill" style="width:${Math.min(r.rate, 100)}%; background:${color};"></div></div></td>
    </tr>
    <tr class="qt-detail" hidden><td colspan="6">${weeklyBreakdownHtml(r.name, year, month, daysInMonth, r.qtData)}${isAdmin ? manualEditorHtml(r.name, year, month, daysInMonth) : ""}</td></tr>`;
  };

  let html = "";
  if (!rows.length) {
    html = `<p class="muted">큐티 집계 대상 멤버가 없습니다.</p>`;
  } else {
    for (const key of orderedKeys) {
      const grp = groups.get(key);
      grp.sort((a, b) => (b.rate !== a.rate ? b.rate - a.rate : a.name.localeCompare(b.name, "ko")));
      const label = key ? classLabelOf(key) : "미등록";
      html += `<div class="assign-course">
        <h3 class="assign-course-h">${esc(label)} <span class="card-meta">${grp.length}명</span></h3>
        <table class="qt-table">${headRow}<tbody>` +
        grp.map((r, i) => rowHtml(r, i)).join("") +
        `</tbody></table></div>`;
    }
  }
  const wrap = document.getElementById("qt-table-wrap");
  wrap.innerHTML = html;

  wrap.querySelectorAll(".qt-row").forEach((tr) => {
    // 재렌더 후 이전에 펼쳐둔 행 복원
    if (expandedQt.has(tr.dataset.name)) {
      tr.classList.add("expanded");
      const detail = tr.nextElementSibling;
      if (detail && detail.classList.contains("qt-detail")) detail.hidden = false;
    }
    tr.addEventListener("click", () => {
      const detail = tr.nextElementSibling;
      if (!detail || !detail.classList.contains("qt-detail")) return;
      const open = detail.hidden;
      detail.hidden = !open;
      tr.classList.toggle("expanded", open);
      if (open) expandedQt.add(tr.dataset.name); else expandedQt.delete(tr.dataset.name);
    });
  });

  wrap.querySelectorAll(".week-count.clickable").forEach((el) => {
    const open = () => openWeekModal(el.dataset.name, Number(el.dataset.week));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });

  // 관리자 수동 완주일 추가/삭제/보기
  wrap.querySelectorAll(".manual-add").forEach((btn) => {
    btn.addEventListener("click", () => {
      const box = btn.closest(".manual-qt-add");
      const input = box.querySelector(".manual-date");
      const ta = box.querySelector(".manual-content");
      const date = input && input.value;
      if (!date) { alert("추가할 날짜를 선택하세요."); return; }
      saveManualDay(btn.dataset.name, date, true, ta ? ta.value : "");
    });
  });
  wrap.querySelectorAll(".manual-del").forEach((btn) => {
    btn.addEventListener("click", () => saveManualDay(btn.dataset.name, btn.dataset.date, false));
  });
  wrap.querySelectorAll(".manual-view").forEach((btn) => {
    btn.addEventListener("click", () => openManualModal(btn.dataset.name, btn.dataset.date));
  });
}

/* ===================== 주차별 글 목록 모달 ===================== */
function openWeekModal(name, weekIdx) {
  const entry = weekPostIndex[`${name}|${weekIdx}`] || { posts: [], manualPosts: [] };
  const posts = entry.posts || [];
  const manualPosts = entry.manualPosts || [];
  const all = [...posts, ...manualPosts]; // 스크래핑 글 + 수동 기록 (둘 다 클릭 시 내용 모달)
  const [, month] = selectedYM.split("-").map(Number);
  document.getElementById("week-modal-title").textContent =
    `${name} · ${month}월 ${weekIdx}주차 큐티 글`;
  document.getElementById("week-modal-meta").textContent =
    `글 ${posts.length}건` + (manualPosts.length ? ` · 수동 ${manualPosts.length}건` : "");

  const body = document.getElementById("week-modal-body");
  if (!all.length) {
    body.innerHTML = `<p class="muted" style="padding:8px 0;">표시할 글이 없습니다.</p>`;
  } else {
    body.innerHTML =
      `<ul class="post-list">` +
      all.map((p, i) => `<li>
          <span class="post-date">${esc(p.postDate || "")}</span>
          ${catBadge(p.category || categorize(p.title))}
          ${postLinkHtml("week", i, p.title)}
        </li>`).join("") +
      `</ul>`;
    wirePostClicks(body, all);
  }

  document.getElementById("week-modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeWeekModal() {
  document.getElementById("week-modal").hidden = true;
  if (document.getElementById("post-modal").hidden) document.body.style.overflow = "";
}

/* ===================== 과제 완주 현황 ===================== */
let autoAssign = {}; // { name: { assignmentId: matchedPost } } — 수집 글로 자동 매칭된 과제
let expandedAssign = new Set(); // 펼쳐진 과제 행(이름) — 재렌더 후 유지
let assignModalTarget = null; // 과제 모달 대상 { name, taskId }

// 수동 과제 체크 값의 내용. 값은 true(내용 없음) 또는 { content, createdAt }.
function assignContent(v) {
  return (v && typeof v === "object" && typeof v.content === "string") ? v.content : "";
}

function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

// 매칭용 정규화: 맨 앞 분류 태그([훈련나눔] 등)를 떼고 공백 제거·소문자.
// (태그의 "훈련나눔"이 키워드 "나눔" 등과 충돌하지 않도록 제거)
function normTitle(s) {
  return String(s ?? "")
    .replace(/^\s*[\[\(【][^\]\)】]*[\]\)】]\s*/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// 멤버의 [훈련나눔] 글 목록(정규화 포함)
function trainingPosts(name) {
  return (postsByName[name] || [])
    .filter((p) => p && p.title && categorize(p.title) === "훈련나눔")
    .map((p) => ({ post: { ...p, name, category: "훈련나눔" }, n: normTitle(p.title) }));
}

// 멤버의 [예배은혜나눔] 글 목록 — 설교간증은 이 카테고리에서 날짜로 맞춥니다.
function sermonPosts(name) {
  return (postsByName[name] || [])
    .filter((p) => p && p.title && categorize(p.title) === SERMON_CATEGORY)
    .map((p) => ({ ...p, name, category: SERMON_CATEGORY }));
}

// 반별 섹션({tasks, names})을 받아 멤버별 자동 매칭(autoAssign) 구성.
function buildAutoAssign(sections) {
  autoAssign = {};
  for (const { tasks, names } of sections) {
    const sermonTasks = tasks.filter(isSermonTask);
    for (const name of names) {
      const tps = trainingPosts(name);
      const map = {};
      for (const it of tasks) {
        if (!it.m || !it.m.length) continue;
        for (const tp of tps) {
          if (it.x && it.x.some((xk) => tp.n.includes(xk))) continue;
          if (it.m.some((k) => tp.n.includes(k))) { map[it.id] = tp.post; break; }
        }
      }
      // 설교간증은 제목이 매주 달라 키워드가 없으므로 카테고리+날짜로 따로 맞춥니다.
      if (sermonTasks.length) Object.assign(map, matchSermonPosts(sermonTasks, sermonPosts(name)));
      autoAssign[name] = map;
    }
  }
}

function assignKindBadge(kind) {
  const [bg, fg] = assignKindColor(kind);
  return `<span class="assign-kind" style="background:${bg}; color:${fg};">${esc(kind)}</span>`;
}

// tasks(효과 적용된 과제 배열)를 그룹별로 렌더. 마감일 미정 항목은 '미정' 표시(연체 아님).
function assignChecklistHtml(name, tasks, today) {
  const st = assignStatus[name] || {};
  const auto = autoAssign[name] || {};
  const order = [];
  const byGroup = new Map();
  for (const it of tasks) {
    const g = it.group || "";
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    byGroup.get(g).push(it);
  }
  return order.map((g) => {
    const items = byGroup.get(g).map((it) => {
      const autoPost = auto[it.id];
      const manual = !!st[it.id];
      const done = !!autoPost || manual;
      const hasDue = !!it.due;
      const overdue = hasDue && !done && it.due < today;
      const dueLabel = hasDue ? it.due.slice(5).replace("-", "/") : "미정";
      if (autoPost) {
        return `<div class="assign-item auto" data-name="${esc(name)}" data-id="${esc(it.id)}" title="수집된 글로 자동 완료 · 클릭하면 글 보기">
          <span class="assign-box done">✓</span>
          ${assignKindBadge(it.kind)}
          <span class="assign-text">${esc(it.title)}</span>
          <span class="assign-auto">자동 ↗</span>
          <span class="assign-due">~${dueLabel}</span>
        </div>`;
      }
      // 수동 과제: 클릭하면 내용 입력/확인 모달 (체크 상태면 ✓, 내용 있으면 📄)
      const hasContent = manual && !!assignContent(st[it.id]);
      return `<div class="assign-item manual${overdue ? " overdue" : ""}${manual ? " done" : ""}" data-name="${esc(name)}" data-id="${esc(it.id)}" title="클릭하면 내용 입력/확인">
        <span class="assign-box${manual ? " done" : ""}">${manual ? "✓" : ""}</span>
        ${assignKindBadge(it.kind)}
        <span class="assign-text">${esc(it.title)}</span>
        ${hasContent ? `<span class="assign-auto">내용 📄</span>` : ""}
        <span class="assign-due">~${dueLabel}</span>
      </div>`;
    }).join("");
    return `<div class="assign-group"><div class="assign-group-h">${esc(g || "과제")}</div>${items}</div>`;
  }).join("");
}

function assignCounts(name, tasks, today) {
  const st = assignStatus[name] || {};
  const auto = autoAssign[name] || {};
  let done = 0, doneDue = 0;
  for (const it of tasks) {
    if (auto[it.id] || st[it.id]) { done++; if (it.due && it.due <= today) doneDue++; }
  }
  return { done, doneDue };
}

function updateAssignRow(name, today) {
  const wrap = document.getElementById("assign-table-wrap");
  const m = memberList.find((x) => x.name === name);
  if (!m) return;
  const tasks = effectiveTasks(memberCourseId(m), memberClassId(m));
  if (!tasks.length) return;
  const dueSoFar = tasks.filter((it) => it.due && it.due <= today).length;
  const total = tasks.length;
  const { done, doneDue } = assignCounts(name, tasks, today);
  const rate = dueSoFar > 0 ? (doneDue / dueSoFar) * 100 : 0;
  const totalRate = total > 0 ? (done / total) * 100 : 0;
  for (const tr of wrap.querySelectorAll(".assign-row")) {
    if (tr.dataset.name !== name) continue;
    const doneCell = tr.querySelector(".assign-done");
    const rateCell = tr.querySelector(".assign-rate");
    if (doneCell) doneCell.textContent = `${doneDue} / ${dueSoFar}`;
    if (rateCell) {
      rateCell.style.color = rateColor(rate);
      rateCell.innerHTML = `${rate.toFixed(0)}% <span class="rate-sub">(${totalRate.toFixed(0)}%)</span>`;
    }
    break;
  }
}

// 수동 과제 클릭 → 내용 입력/확인 모달 열기.
function openAssignModal(name, taskId) {
  const m = memberList.find((x) => x.name === name);
  if (!m) return;
  const t = effectiveTasks(memberCourseId(m), memberClassId(m)).find((x) => x.id === taskId);
  if (!t) return;
  const v = (assignStatus[name] || {})[taskId];
  const done = !!v;
  assignModalTarget = { name, taskId };

  const kindEl = document.getElementById("assign-modal-kind");
  const [bg, fg] = assignKindColor(t.kind);
  kindEl.textContent = t.kind; kindEl.style.background = bg; kindEl.style.color = fg;
  document.getElementById("assign-modal-title").textContent = t.title || "";
  document.getElementById("assign-modal-meta").textContent =
    [name, t.due ? `~${t.due.slice(5).replace("-", "/")}` : "마감일 미정"].join(" · ");
  document.getElementById("assign-modal-content").value = assignContent(v);
  document.getElementById("assign-modal-save").textContent = done ? "내용 저장" : "완료 체크";
  document.getElementById("assign-modal-uncheck").hidden = !done;

  document.getElementById("assign-modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeAssignModal() {
  document.getElementById("assign-modal").hidden = true;
  assignModalTarget = null;
  if (document.getElementById("post-modal").hidden && document.getElementById("week-modal").hidden) {
    document.body.style.overflow = "";
  }
}

// 완료 체크(내용 있으면 { content, createdAt }, 없으면 true) 저장.
async function saveAssign() {
  if (!assignModalTarget) return;
  const { name, taskId } = assignModalTarget;
  const content = (document.getElementById("assign-modal-content").value || "").trim();
  const value = content ? { content, createdAt: new Date().toISOString() } : true;
  try {
    await set(ref(db, `assignments/${name}/${taskId}`), value);
    if (!assignStatus[name]) assignStatus[name] = {};
    assignStatus[name][taskId] = value;
    closeAssignModal();
    renderAssignTable();
  } catch (e) {
    alert("저장 실패: " + (e.message || e) + "\n(RTDB 규칙에 assignments write 권한이 필요합니다)");
  }
}

// 체크 해제(내용까지 삭제).
async function uncheckAssign() {
  if (!assignModalTarget) return;
  const { name, taskId } = assignModalTarget;
  try {
    await set(ref(db, `assignments/${name}/${taskId}`), null);
    if (assignStatus[name]) delete assignStatus[name][taskId];
    closeAssignModal();
    renderAssignTable();
  } catch (e) {
    alert("해제 실패: " + (e.message || e));
  }
}

function renderAssignTable() {
  const wrap = document.getElementById("assign-table-wrap");
  if (!wrap) return;
  const today = todayISO();

  // 수집 대상(active) 멤버를 반(class)별로 묶고, 반의 커리큘럼(course)으로 채점.
  const active = memberList.filter((m) => m.active);
  const byClass = new Map();
  for (const m of active) {
    const cid = memberClassId(m);
    if (!byClass.has(cid)) byClass.set(cid, []);
    byClass.get(cid).push(m.name);
  }
  const sections = [];
  for (const [cid, names] of byClass) {
    const cls = classesById[cid];
    // 반이 등록돼 있으면 반의 courseId, 아니면 예전 course id(cid) 를 커리큘럼으로 폴백
    const courseId = cls ? cls.courseId : cid;
    const tasks = effectiveTasks(courseId, cid);
    if (!tasks.length) continue; // 커리큘럼 없는 반은 과제 채점 대상 아님(큐티엔 계속 표시)
    const course = coursesById[courseId];
    sections.push({ tasks, names, label: (cls && cls.label) || cid, courseLabel: (course && course.label) || courseId });
  }
  sections.sort((a, b) => a.label.localeCompare(b.label, "ko"));

  if (!sections.length) {
    document.getElementById("assign-meta").textContent = "";
    wrap.innerHTML = `<p class="muted">과제를 채점할 반이 없습니다. ‘⚙️ 멤버 관리’에서 멤버의 반을 지정하고, 반에 커리큘럼(과정)이 연결돼 있는지 확인하세요.</p>`;
    return;
  }
  document.getElementById("assign-meta").textContent =
    "수집된 [훈련나눔] 글로 자동 체크 · 완주율은 마감 도래 기준(괄호: 전체)";

  buildAutoAssign(sections);

  let html = "";
  for (const { tasks, names, label, courseLabel } of sections) {
    const dueSoFar = tasks.filter((it) => it.due && it.due <= today).length;
    const total = tasks.length;

    const rows = names.map((name) => {
      const { done, doneDue } = assignCounts(name, tasks, today);
      const rate = dueSoFar > 0 ? (doneDue / dueSoFar) * 100 : 0;
      const totalRate = total > 0 ? (done / total) * 100 : 0;
      return { name, doneDue, rate, totalRate };
    });
    rows.sort((a, b) => a.name.localeCompare(b.name, "ko"));

    html += `<div class="assign-course">
      <h3 class="assign-course-h">${esc(label)} <span class="card-meta">${esc(courseLabel)} · 마감 도래 ${dueSoFar} / 전체 ${total}</span></h3>
      <table class="qt-table"><thead><tr>
        <th class="caret-cell"></th><th>번호</th><th>성함</th><th>완료(마감도래)</th><th>완주율 (전체)</th></tr></thead><tbody>`;
    rows.forEach((r, i) => {
      const color = rateColor(r.rate);
      html += `<tr class="qt-row assign-row" data-name="${esc(r.name)}" title="클릭하면 과제 체크">
        <td class="caret-cell"><span class="caret">▸</span></td>
        <td class="rank">${i + 1}</td>
        <td class="name">${esc(r.name)}</td>
        <td class="assign-done">${r.doneDue} / ${dueSoFar}</td>
        <td class="assign-rate" style="color:${color}; font-weight:700;">${r.rate.toFixed(0)}% <span class="rate-sub">(${r.totalRate.toFixed(0)}%)</span></td>
      </tr>
      <tr class="qt-detail" hidden><td colspan="5">${assignChecklistHtml(r.name, tasks, today)}</td></tr>`;
    });
    html += `</tbody></table></div>`;
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll(".assign-row").forEach((tr) => {
    if (expandedAssign.has(tr.dataset.name)) {
      tr.classList.add("expanded");
      const detail = tr.nextElementSibling;
      if (detail && detail.classList.contains("qt-detail")) detail.hidden = false;
    }
    tr.addEventListener("click", () => {
      const detail = tr.nextElementSibling;
      if (!detail || !detail.classList.contains("qt-detail")) return;
      const open = detail.hidden;
      detail.hidden = !open;
      tr.classList.toggle("expanded", open);
      if (open) expandedAssign.add(tr.dataset.name); else expandedAssign.delete(tr.dataset.name);
    });
  });
  wrap.querySelectorAll(".assign-item.auto").forEach((el) => {
    el.addEventListener("click", () => {
      const p = (autoAssign[el.dataset.name] || {})[el.dataset.id];
      if (p) openPostModal(p);
    });
  });
  wrap.querySelectorAll(".assign-item.manual").forEach((el) => {
    el.addEventListener("click", () => openAssignModal(el.dataset.name, el.dataset.id));
  });
}

let feedList = [];
function renderFeed() {
  feedList = [];
  for (const name of memberNames) {
    for (const p of postsByName[name] || []) {
      if (p && p.title) feedList.push({ name, category: categorize(p.title), ...p });
    }
  }
  feedList.sort((a, b) =>
    String(b.postDate || "").localeCompare(String(a.postDate || "")) ||
    String(b.collectedAt || "").localeCompare(String(a.collectedAt || ""))
  );
  feedList = feedList.slice(0, 20);

  const wrap = document.getElementById("feed-wrap");
  if (feedList.length === 0) {
    wrap.innerHTML = `<p class="muted">아직 수집된 글이 없습니다. (GitHub Actions 수집 실행 후 표시됩니다)</p>`;
    return;
  }
  wrap.innerHTML =
    `<ul class="feed">` +
    feedList.map((p, i) => `<li>
        <span class="feed-date">${esc(p.postDate || "")}</span>
        <span class="feed-name">${esc(p.name)}</span>
        ${catBadge(p.category)}
        ${postLinkHtml("feed", i, p.title)}
      </li>`).join("") +
    `</ul>`;
  wirePostClicks(wrap, feedList);
}

/* ===================== 멤버별 글 ===================== */
let memberPosts = [];
let currentCat = "__all";

function renderMember(name) {
  currentCat = "__all";
  document.getElementById("member-title").textContent = `🙋 ${name} 님의 글`;

  memberPosts = (postsByName[name] || [])
    .filter((p) => p && p.title)
    .map((p) => ({ ...p, name, category: categorize(p.title) }))
    // 수동 완주 기록도 '수동' 태그를 달아 함께 표시(클릭 시 내용 모달)
    .concat(manualAllPosts(name))
    .sort((a, b) =>
      String(b.postDate || "").localeCompare(String(a.postDate || "")) ||
      String(b.collectedAt || "").localeCompare(String(a.collectedAt || ""))
    );

  document.getElementById("member-meta").textContent = `총 ${memberPosts.length}건`;

  const counts = {};
  for (const p of memberPosts) counts[p.category] = (counts[p.category] || 0) + 1;
  const cats = Object.keys(counts).sort((a, b) => a.localeCompare(b, "ko"));

  const filterEl = document.getElementById("cat-filter");
  filterEl.innerHTML =
    `<button class="chip active" data-cat="__all">전체 (${memberPosts.length})</button>` +
    cats.map((c) => {
      const [bg, fg] = categoryColor(c);
      return `<button class="chip" data-cat="${esc(c)}" style="--chip-bg:${bg}; --chip-fg:${fg};">${esc(c)} (${counts[c]})</button>`;
    }).join("");

  filterEl.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentCat = btn.dataset.cat;
      filterEl.querySelectorAll(".chip").forEach((b) => b.classList.toggle("active", b === btn));
      paintMemberPosts();
    });
  });

  paintMemberPosts();
}

function paintMemberPosts() {
  const list = currentCat === "__all" ? memberPosts : memberPosts.filter((p) => p.category === currentCat);
  const wrap = document.getElementById("member-posts");
  if (list.length === 0) {
    wrap.innerHTML = `<p class="muted">표시할 글이 없습니다.</p>`;
    return;
  }
  wrap.innerHTML =
    `<ul class="post-list">` +
    list.map((p, i) => `<li>
        <span class="post-date">${esc(p.postDate || "")}</span>
        ${catBadge(p.category)}
        ${postLinkHtml("member", i, p.title)}
      </li>`).join("") +
    `</ul>`;
  wirePostClicks(wrap, list);
}

/* ===================== 사이드바 / 탭 ===================== */
function setSidebar(open) {
  document.getElementById("sidebar").classList.toggle("open", open);
  document.getElementById("sidebar-backdrop").hidden = !open;
}

function showView(key) {
  const isSpecial = (k) => k === "__dash" || k === "__admin" || k === "__course";
  document.getElementById("dashboard-view").hidden = key !== "__dash";
  document.getElementById("member-view").hidden = isSpecial(key);
  document.getElementById("admin-view").hidden = key !== "__admin";
  document.getElementById("course-view").hidden = key !== "__course";
}

function buildTabs() {
  const nav = document.getElementById("tabs");

  const tabs = [{ key: "__dash", label: "📊 대시보드" }]
    .concat(memberNames.map((n) => ({ key: n, label: n })));
  // 멤버/커리큘럼 관리는 관리자 전용 (반 계정은 자기 반 데이터 열람만)
  if (isAdmin) {
    tabs.push({ key: "__admin", label: "⚙️ 멤버 관리" });
    tabs.push({ key: "__course", label: "📚 커리큘럼 관리" });
  }

  nav.innerHTML = tabs
    .map((t) =>
      `<button class="side-item${t.key === activeKey ? " active" : ""}" data-key="${esc(t.key)}">${esc(t.label)}</button>`
    ).join("");

  nav.querySelectorAll(".side-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      nav.querySelectorAll(".side-item").forEach((b) => b.classList.toggle("active", b === btn));
      const key = btn.dataset.key;
      activeKey = key;
      showView(key);
      if (key === "__admin") renderAdmin();
      else if (key === "__course") renderCourseAdmin();
      else if (key !== "__dash") renderMember(key);
      setSidebar(false); // 선택 후 닫기
    });
  });
}

// 사이드바/모달 등 1회성 배선
function wireChrome() {
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    const open = !document.getElementById("sidebar").classList.contains("open");
    setSidebar(open);
  });
  document.getElementById("sidebar-backdrop").addEventListener("click", () => setSidebar(false));
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("post-modal").addEventListener("click", (e) => {
    if (e.target.id === "post-modal") closeModal();
  });
  document.getElementById("week-modal-close").addEventListener("click", closeWeekModal);
  document.getElementById("week-modal").addEventListener("click", (e) => {
    if (e.target.id === "week-modal") closeWeekModal();
  });
  document.getElementById("assign-modal-close").addEventListener("click", closeAssignModal);
  document.getElementById("assign-modal").addEventListener("click", (e) => {
    if (e.target.id === "assign-modal") closeAssignModal();
  });
  document.getElementById("assign-modal-save").addEventListener("click", saveAssign);
  document.getElementById("assign-modal-uncheck").addEventListener("click", uncheckAssign);
  initExport(exportContext());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // 위에 떠 있는 모달부터 닫기
    const exportModal = document.getElementById("export-modal");
    if (exportModal && !exportModal.hidden) { exportModal.hidden = true; return; }
    if (!document.getElementById("assign-modal").hidden) { closeAssignModal(); return; }
    if (!document.getElementById("post-modal").hidden) { closeModal(); return; }
    if (!document.getElementById("week-modal").hidden) { closeWeekModal(); return; }
    setSidebar(false);
  });
}

/* ===================== 과제 취합문서 내보내기 ===================== */
// 글 제목 앞의 분류 태그([예배은혜나눔] 등)를 떼어냅니다 — 양식의 '제목' 칸에는 태그가 없습니다.
function stripCategoryTag(title) {
  return String(title ?? "").replace(/^\s*[[(【][^\])】]*[\])】]\s*/, "").trim();
}

// 내보내기 모달에 넘길 데이터 제공자. 대시보드가 이미 들고 있는 상태만 씁니다(추가 조회 없음).
function exportContext() {
  const activeOf = (classId) =>
    memberList.filter((m) => m.active && memberClassId(m) === classId)
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  const tasksOf = (classId) => {
    const cls = classesById[classId];
    return effectiveTasks(cls ? cls.courseId : classId, classId);
  };

  return {
    listClasses() {
      const ids = [...new Set(memberList.filter((m) => m.active).map(memberClassId))];
      return ids
        .filter((id) => tasksOf(id).length)
        .map((id) => ({ id, label: classLabelOf(id) }))
        .sort((a, b) => a.label.localeCompare(b.label, "ko"));
    },

    listTasks(classId) {
      return tasksOf(classId).filter((t) => t.due).sort((a, b) => (a.due < b.due ? 1 : -1));
    },

    buildDoc(classId, taskId) {
      const task = tasksOf(classId).find((t) => t.id === taskId);
      if (!task) throw new Error("과제를 찾지 못했습니다");
      const members = activeOf(classId);
      if (!members.length) throw new Error("이 반에 수집 대상 멤버가 없습니다");

      const cohort = cohortOf(classLabelOf(classId));
      const rows = members.map((m) => {
        const post = (autoAssign[m.name] || {})[taskId];
        const manual = assignContent((assignStatus[m.name] || {})[taskId]);
        const body = (post && post.content) || manual || "";
        // 설교간증만 멤버별 글 제목을 씁니다. 나머지는 과제명이 전원 동일합니다.
        const title = post
          ? (isSermonTask(task) ? stripCategoryTag(post.title) : task.title)
          : (manual ? task.title : "");
        return { 이름: m.name, 제목: title, 본문: body ? toParagraphs(body) : [] };
      });

      return {
        문서제목: docTitleFor(task.kind, cohort),
        제출일: task.due,
        rows,
        파일명: fileNameFor(cohort, task.kind, task.due),
      };
    },
  };
}

/* ===================== 멤버 관리 (관리자 = 전체 / 일반 반 = 자기 반) ===================== */
function classOptionsHtml(sel) {
  const list = Object.values(classesById).sort((a, b) => a.label.localeCompare(b.label, "ko"));
  return [`<option value=""${!sel ? " selected" : ""}>미배정</option>`]
    .concat(list.map((c) =>
      `<option value="${esc(c.id)}"${c.id === sel ? " selected" : ""}>${esc(c.label)}</option>`))
    .join("");
}

function classLabelOf(classId) {
  const c = classesById[classId];
  return (c && c.label) || classId || "미배정";
}

function renderAdmin() {
  const wrap = document.getElementById("admin-view");
  // 반 셀: 관리자는 반 선택 드롭다운, 일반 반은 자기 반 고정 표시
  const classCell = (m) => isAdmin
    ? `<td><select class="class-select" data-name="${esc(m.name)}">${classOptionsHtml(memberClassId(m))}</select></td>`
    : `<td class="muted">${esc(classLabelOf(memberClassId(m)))}</td>`;

  const heading = isAdmin ? "⚙️ 멤버 관리 (전체 반)" : `⚙️ ${esc(classLabelOf(myClassId))} 멤버 관리`;
  const help = isAdmin
    ? `※ <b>큐티 집계</b>=월간 큐티 완주 현황 대상 · <b>수집 대상</b>=글 자동 수집 · <b>반</b>=소속 훈련 반(로그인 단위, 과제는 반의 커리큘럼으로 채점). 변경은 다음 수집부터 반영됩니다.`
    : `※ 우리 반 멤버만 표시됩니다. 추가하는 멤버는 자동으로 이 반에 소속됩니다. <b>큐티 집계</b>=큐티 현황 대상 · <b>수집 대상</b>=글 자동 수집.`;

  // 반 이름 편집 카드 (관리자만). 이름만 바꿈 — 로그인 id·비밀번호는 그대로.
  const classRows = Object.values(classesById).sort((a, b) => a.label.localeCompare(b.label, "ko"));
  const classCard = isAdmin ? `<section class="card">
      <div class="card-head"><h2>🏷️ 반 이름</h2><span class="card-meta">${classRows.length}개 반</span></div>
      <div id="class-msg" class="muted" style="margin:8px 0;"></div>
      ${classRows.length ? `<div class="table-wrap"><table class="qt-table"><thead><tr>
        <th>반 id</th><th>반 이름</th><th></th></tr></thead><tbody>` +
        classRows.map((c) => `<tr>
          <td class="muted">${esc(c.id)}</td>
          <td><input class="class-label" data-id="${esc(c.id)}" value="${esc(c.label)}" style="width:100%" /></td>
          <td><button class="btn btn-ghost class-label-save" data-id="${esc(c.id)}">저장</button></td>
        </tr>`).join("") + `</tbody></table></div>`
        : `<p class="muted">개설된 반이 없습니다. (Actions → Admin Tools 로 반 개설)</p>`}
      <p class="muted" style="margin-top:8px;">반 이름(표시 이름)만 바꿉니다. 반 개설/삭제·비밀번호 변경은 Actions → Admin Tools.</p>
    </section>` : "";

  wrap.innerHTML = classCard +
    `<section class="card">
      <div class="card-head"><h2>${heading}</h2>
        <span class="card-meta">총 ${memberList.length}명</span></div>
      <div class="add-row">
        <input id="new-member" type="text" placeholder="추가할 이름 (게시판 검색명과 동일)" />
        <button id="add-member" class="btn btn-primary">추가</button>
      </div>
      <div id="admin-msg" class="muted" style="margin:8px 0;"></div>
      <div class="table-wrap"><table class="qt-table"><thead><tr>
        <th>이름</th><th>큐티 집계</th><th>수집 대상</th><th>반</th><th></th>
      </tr></thead><tbody>` +
      memberList.map((m) => `<tr>
        <td class="name">${esc(m.name)}</td>
        <td><input type="checkbox" data-act="qt" data-name="${esc(m.name)}" ${m.qt ? "checked" : ""} /></td>
        <td><input type="checkbox" data-act="active" data-name="${esc(m.name)}" ${m.active ? "checked" : ""} /></td>
        ${classCell(m)}
        <td><button class="btn btn-ghost btn-del" data-name="${esc(m.name)}">삭제</button></td>
      </tr>`).join("") +
      `</tbody></table></div>
      <p class="muted" style="margin-top:12px;">${help} 권한 오류가 나면 로그인/규칙 설정을 확인하세요(README).</p>
    </section>`;

  const msg = (t, ok) => {
    const el = document.getElementById("admin-msg");
    el.textContent = t; el.style.color = ok ? "#1a8a3c" : "#d93025";
  };

  document.getElementById("add-member").addEventListener("click", async () => {
    const name = document.getElementById("new-member").value.trim();
    if (!name) return;
    if (memberList.some((m) => m.name === name)) { msg("이미 있는 이름입니다.", false); return; }
    try {
      await ensureSeeded();
      // 일반 반은 자기 반, 관리자는 미배정으로 추가(이후 반 선택으로 지정)
      const cls = isAdmin ? "" : myClassId;
      await set(ref(db, "members/" + name), { name, qt: true, active: true, class: cls, createdAt: new Date().toISOString() });
      msg(`'${name}' 추가됨`, true);
      await reloadMembersAndUi();
    } catch (e) { msg("추가 실패: " + (e.message || e), false); }
  });

  wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", async () => {
      const name = cb.dataset.name, field = cb.dataset.act;
      try {
        await ensureSeeded();
        await update(ref(db, "members/" + name), { [field]: cb.checked });
        await reloadMembersAndUi();
      } catch (e) { cb.checked = !cb.checked; msg("변경 실패: " + (e.message || e), false); }
    });
  });

  wrap.querySelectorAll(".class-select").forEach((sel) => {
    const prev = sel.value;
    sel.addEventListener("change", async () => {
      const name = sel.dataset.name;
      try {
        await ensureSeeded();
        await update(ref(db, "members/" + name), { class: sel.value });
        await reloadMembersAndUi();
      } catch (e) { sel.value = prev; msg("변경 실패: " + (e.message || e), false); }
    });
  });

  wrap.querySelectorAll(".btn-del").forEach((b) => {
    b.addEventListener("click", async () => {
      const name = b.dataset.name;
      if (!confirm(`'${name}' 멤버를 삭제할까요? (수집한 글 기록은 유지됩니다)`)) return;
      try {
        await ensureSeeded();
        await remove(ref(db, "members/" + name));
        msg(`'${name}' 삭제됨`, true);
        await reloadMembersAndUi();
      } catch (e) { msg("삭제 실패: " + (e.message || e), false); }
    });
  });

  // 반 이름 저장 (관리자)
  const cmsg = (t, ok) => {
    const el = document.getElementById("class-msg");
    if (el) { el.textContent = t; el.style.color = ok ? "#1a8a3c" : "#d93025"; }
  };
  const saveClassLabel = async (input) => {
    const id = input.dataset.id;
    const label = (input.value || "").trim();
    if (!label) { cmsg("반 이름을 입력하세요.", false); return; }
    if (label === classLabelOf(id)) return; // 변경 없음
    try {
      await set(ref(db, `classes/${id}/label`), label);
      cmsg(`'${id}' 반 이름을 '${label}' 로 변경했습니다.`, true);
      await reloadMembersAndUi();
    } catch (e) { cmsg("변경 실패: " + (e.message || e), false); }
  };
  wrap.querySelectorAll(".class-label-save").forEach((btn) => {
    btn.addEventListener("click", () => saveClassLabel(btn.closest("tr").querySelector(".class-label")));
  });
  wrap.querySelectorAll(".class-label").forEach((input) => {
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveClassLabel(input); } });
  });
}

/* ===================== 커리큘럼 관리 (관리자) ===================== */
// RTDB /courses/<id> 가 없으면 코드 시드(또는 빈 골격)로 먼저 만들어, 편집이 그 위에 얹히게 함.
async function ensureCourseSeeded(courseId) {
  const snap = await get(ref(db, `courses/${courseId}`));
  if (snap.exists()) return;
  const code = COURSES.find((c) => c.id === courseId);
  const seed = code ? courseSeed(code) : { label: (coursesById[courseId] && coursesById[courseId].label) || courseId, tasks: {} };
  await set(ref(db, `courses/${courseId}`), seed);
}

function renderCourseAdmin() {
  const wrap = document.getElementById("course-view");
  const courseIds = Object.keys(coursesById)
    .sort((a, b) => (coursesById[a].label || a).localeCompare(coursesById[b].label || b, "ko"));
  if (!courseSel || !coursesById[courseSel]) courseSel = courseIds[0] || "";
  const course = coursesById[courseSel];

  const classesUsing = Object.values(classesById).filter((c) => c.courseId === courseSel);
  if (dueTargetSel && !classesUsing.some((c) => c.id === dueTargetSel)) dueTargetSel = "";

  const courseOpts = courseIds
    .map((id) => `<option value="${esc(id)}"${id === courseSel ? " selected" : ""}>${esc(coursesById[id].label || id)}</option>`).join("");
  const dueOpts = [`<option value=""${!dueTargetSel ? " selected" : ""}>기본 마감일(공통)</option>`]
    .concat(classesUsing.map((c) => `<option value="${esc(c.id)}"${c.id === dueTargetSel ? " selected" : ""}>${esc(c.label)} (반별)</option>`)).join("");

  const dueOf = (t) => dueTargetSel ? (((classesById[dueTargetSel] || {}).due || {})[t.id] || "") : (t.due || "");
  const kindOpt = (sel) => ["생활간증", "독서", "기타"].map((k) => `<option${k === sel ? " selected" : ""}>${k}</option>`).join("");

  const rows = course ? course.tasks.map((t) => `<tr>
      <td><input class="c-order" data-id="${esc(t.id)}" type="number" value="${t.order}" style="width:52px" /></td>
      <td><input class="c-group" data-id="${esc(t.id)}" value="${esc(t.group)}" placeholder="그룹" style="width:110px" /></td>
      <td><select class="c-kind" data-id="${esc(t.id)}">${kindOpt(t.kind)}</select></td>
      <td><input class="c-title" data-id="${esc(t.id)}" value="${esc(t.title)}" placeholder="과제명" style="min-width:200px" /></td>
      <td><input class="c-kw" data-id="${esc(t.id)}" value="${esc((t.m || []).join(", "))}" placeholder="키워드,쉼표" style="width:150px" /></td>
      <td><input class="c-due" data-id="${esc(t.id)}" type="date" value="${esc(dueOf(t))}" /></td>
      <td><button class="btn btn-ghost c-del" data-id="${esc(t.id)}">삭제</button></td>
    </tr>`).join("") : "";

  wrap.innerHTML = `<section class="card">
    <div class="card-head"><h2>📚 커리큘럼 관리</h2><span class="card-meta">${course ? course.tasks.length : 0}개 과제</span></div>
    <div class="add-row">
      <select id="course-sel" class="course-mgr-sel">${courseOpts}</select>
      <span class="muted">| 새 커리큘럼</span>
      <input id="new-course-id" placeholder="id(영문/숫자)" style="width:130px" />
      <input id="new-course-label" placeholder="이름" />
      <button id="add-course" class="btn btn-primary">추가</button>
    </div>
    <div class="add-row">
      <span class="muted">마감일 편집 대상</span>
      <select id="due-target" class="course-mgr-sel">${dueOpts}</select>
      <span class="muted">과제명·종류·키워드·순서·그룹은 커리큘럼 공통 / 마감일만 선택 대상 기준</span>
    </div>
    <div id="course-msg" class="muted" style="margin:8px 0;"></div>
    <div class="table-wrap"><table class="qt-table"><thead><tr>
      <th>순서</th><th>그룹</th><th>종류</th><th>과제명</th><th>키워드(자동체크)</th><th>마감일</th><th></th>
    </tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted">과제가 없습니다. 아래 ‘과제 추가’로 시작하세요.</td></tr>`}</tbody></table></div>
    <div class="add-row"><button id="add-task" class="btn btn-ghost">+ 과제 추가</button></div>
    <p class="muted" style="margin-top:12px;">※ 같은 커리큘럼이라도 <b>마감일만 반별로 다르게</b> 지정할 수 있어요. 위 ‘마감일 편집 대상’에서 반을 고르면 그 반의 마감일을 입력합니다(비우면 커리큘럼 기본값 사용). 키워드는 수집된 [훈련나눔] 글 자동 체크에 쓰입니다.</p>
  </section>`;

  const msg = (t, ok) => { const el = document.getElementById("course-msg"); el.textContent = t; el.style.color = ok ? "#1a8a3c" : "#d93025"; };

  document.getElementById("course-sel").addEventListener("change", (e) => { courseSel = e.target.value; dueTargetSel = ""; renderCourseAdmin(); });
  document.getElementById("due-target").addEventListener("change", (e) => { dueTargetSel = e.target.value; renderCourseAdmin(); });

  document.getElementById("add-course").addEventListener("click", async () => {
    const id = (document.getElementById("new-course-id").value || "").trim();
    const label = (document.getElementById("new-course-label").value || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,30}$/.test(id)) { msg("커리큘럼 id는 영소문자/숫자로 시작, 2~31자여야 합니다.", false); return; }
    if (coursesById[id]) { msg("이미 있는 커리큘럼 id 입니다.", false); return; }
    try { await set(ref(db, `courses/${id}`), { label: label || id, tasks: {} }); courseSel = id; msg("커리큘럼 추가됨", true); await reloadMembersAndUi(); }
    catch (e) { msg("추가 실패: " + (e.message || e), false); }
  });

  document.getElementById("add-task").addEventListener("click", async () => {
    if (!courseSel) return;
    try {
      await ensureCourseSeeded(courseSel);
      const maxOrder = coursesById[courseSel].tasks.reduce((mx, t) => Math.max(mx, t.order || 0), 0);
      const id = `t${Date.now().toString(36)}`;
      await set(ref(db, `courses/${courseSel}/tasks/${id}`), { title: "새 과제", kind: "기타", group: "", order: maxOrder + 1, due: "", m: [], x: [] });
      msg("과제 추가됨", true); await reloadMembersAndUi();
    } catch (e) { msg("추가 실패: " + (e.message || e), false); }
  });

  const writeField = async (id, patch) => {
    try { await ensureCourseSeeded(courseSel); await update(ref(db, `courses/${courseSel}/tasks/${id}`), patch); await reloadMembersAndUi(); }
    catch (e) { msg("저장 실패: " + (e.message || e), false); }
  };
  wrap.querySelectorAll(".c-title").forEach((el) => el.addEventListener("change", () => writeField(el.dataset.id, { title: el.value })));
  wrap.querySelectorAll(".c-group").forEach((el) => el.addEventListener("change", () => writeField(el.dataset.id, { group: el.value })));
  wrap.querySelectorAll(".c-kind").forEach((el) => el.addEventListener("change", () => writeField(el.dataset.id, { kind: el.value })));
  wrap.querySelectorAll(".c-order").forEach((el) => el.addEventListener("change", () => writeField(el.dataset.id, { order: parseInt(el.value, 10) || 0 })));
  wrap.querySelectorAll(".c-kw").forEach((el) => el.addEventListener("change", () => {
    const arr = el.value.split(",").map((s) => s.replace(/\s+/g, "")).filter(Boolean);
    writeField(el.dataset.id, { m: arr });
  }));
  wrap.querySelectorAll(".c-due").forEach((el) => el.addEventListener("change", async () => {
    const id = el.dataset.id, val = el.value || "";
    try {
      if (dueTargetSel) { await set(ref(db, `classes/${dueTargetSel}/due/${id}`), val || null); }
      else { await ensureCourseSeeded(courseSel); await set(ref(db, `courses/${courseSel}/tasks/${id}/due`), val); }
      await reloadMembersAndUi();
    } catch (e) { msg("마감일 저장 실패: " + (e.message || e), false); }
  }));
  wrap.querySelectorAll(".c-del").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("이 과제를 삭제할까요? (기존 체크 기록은 남지만 화면에서 사라집니다)")) return;
    try { await ensureCourseSeeded(courseSel); await remove(ref(db, `courses/${courseSel}/tasks/${el.dataset.id}`)); msg("삭제됨", true); await reloadMembersAndUi(); }
    catch (e) { msg("삭제 실패: " + (e.message || e), false); }
  }));
}

// /members 가 비어 있으면(폴백 표시 중) 현재 전체 명단을 먼저 통째로 저장.
// 한 명만 토글했을 때 나머지가 사라지는 문제 방지.
async function ensureSeeded() {
  const snap = await get(ref(db, "members"));
  if (snap.exists()) return;
  const updates = {};
  for (const m of memberList) {
    updates[m.name] = { name: m.name, qt: m.qt, active: m.active, class: memberClassId(m) };
  }
  if (Object.keys(updates).length) await update(ref(db, "members"), updates);
}

// 멤버 목록을 다시 읽고(스코프 적용) 파생 목록/화면 갱신.
async function refreshMemberScope() {
  memberList = scopeMembers(await loadMemberListRaw());
  memberNames = memberList.filter((m) => m.active).map((m) => m.name);
  qtNames = memberList.filter((m) => m.qt).map((m) => m.name);
}

async function reloadMembersAndUi() {
  [classesById, coursesById] = await Promise.all([loadClassesMap(), loadCoursesMap()]);
  await refreshMemberScope();
  buildTabs();
  renderQtTable();
  renderAssignTable();
  if (activeKey === "__admin") renderAdmin();
  else if (activeKey === "__course") renderCourseAdmin();
}

// 데이터를 다시 읽어 현재 화면을 갱신
async function loadData() {
  document.getElementById("notice").hidden = true;

  [classesById, coursesById] = await Promise.all([loadClassesMap(), loadCoursesMap()]);
  await refreshMemberScope();

  const { result, firstError } = await loadAllPosts(memberNames);
  postsByName = result;

  try {
    const aSnap = await get(ref(db, "assignments"));
    assignStatus = aSnap.exists() ? aSnap.val() : {};
  } catch (_) { assignStatus = {}; }

  try {
    const qmSnap = await get(ref(db, "qtManual"));
    qtManual = qmSnap.exists() ? qmSnap.val() : {};
  } catch (_) { qtManual = {}; }

  const total = Object.values(result).reduce((s, a) => s + a.length, 0);
  if (firstError && total === 0) {
    const msg = String((firstError && firstError.message) || firstError);
    if (/permission|denied/i.test(msg)) {
      showNotice(
        "⚠️ 데이터 읽기 권한이 없습니다. <b>Realtime Database → 규칙</b>에서 " +
        "<code>posts</code>·<code>members</code> 의 <code>.read</code> 를 " +
        "<code>\"auth != null\"</code> 로, <code>classes</code> 는 공개 읽기로 설정해 게시하세요(README)."
      );
    } else {
      showNotice("⚠️ 데이터를 불러오지 못했습니다: " + esc(msg));
    }
  }

  buildTabs();
  renderQtTable();
  renderAssignTable();
  renderFeed();
  if (activeKey === "__admin") renderAdmin();
  else if (activeKey === "__course") renderCourseAdmin();
  else if (activeKey !== "__dash") renderMember(activeKey);
}

/** 로그인 성공 후 호출. 계정이 바뀌면(로그아웃→다른 반 로그인) 재초기화한다. */
export async function initDashboard(profile) {
  // 사이드바/모달 등 고정 UI 배선은 페이지당 한 번만(중복 리스너 방지).
  if (!wired) { wireChrome(); wired = true; }

  const identity = profile ? `${profile.classId}|${profile.admin ? 1 : 0}` : null;
  // 같은 계정 재호출(토큰 갱신 등)이면 다시 로드하지 않음.
  if (identity && identity === currentIdentity) return;
  currentIdentity = identity;

  // 계정 전환 시 이전 반의 잔여 상태 초기화.
  isAdmin = !!(profile && profile.admin);
  myClassId = (profile && profile.classId) || "";
  activeKey = "__dash";
  expandedQt = new Set();
  expandedAssign = new Set();
  postsByName = {};

  try {
    await loadData();
  } catch (e) {
    currentIdentity = null; // 실패 시 다음 시도에서 재초기화되도록
    showNotice("⚠️ 초기화 오류: " + esc(e.message));
  }
}
