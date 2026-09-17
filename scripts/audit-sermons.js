// 설교간증(예배은혜나눔) 자동 매칭 점검 — **출력 전용, 아무것도 쓰지 않습니다.**
//
// 대시보드의 자동 체크는 저장되지 않고 화면을 그릴 때마다 계산됩니다. 그래서 "그동안 자동으로
// 등록된 예배나눔"을 되짚으려면 저장된 글에 매칭 로직을 다시 돌려 보는 수밖에 없습니다.
// 이 도구는 수집된 [예배은혜나눔] 글에 대해
//   (1) 고치기 전 로직(게시일 우선) 과 (2) 지금 로직(제목 날짜 우선) 의 결과를 비교하고,
//   (3) 어디에도 붙지 못한 글을 모아 보여 줍니다.
//
// 실행: Actions → Admin Tools → audit-sermons  (MEMBER 로 한 명만 볼 수 있음)
import { initDb } from "./lib/firebase.js";
import { categorize } from "../js/config.js";
import {
  COURSES, courseSeed, isSermonTask, sermonFields, matchSermonPosts,
  sermonDateFromTitle, hasTitleDate, SERMON_CATEGORY,
} from "../js/assignments.js";

/* ---- 고치기 전(2026-09 이전) 매칭 로직. 비교용으로만 남겨 둡니다. ---- */
const DAY_MS = 86400000;
const addDays = (s, n) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
function matchSermonPostsLegacy(tasks, posts) {
  const sermons = tasks.map((t) => { const f = sermonFields(t); return f ? { ...t, ...f } : null; }).filter(Boolean);
  if (!sermons.length || !posts.length) return {};
  const norm = (s) => String(s ?? "").replace(/\s+/g, "");
  const toISO = (d) => String(d ?? "").replace(/\./g, "-").slice(0, 10);
  const oldTitleDate = (title, year) => {   // 구분자 형태(9월4일·9.4·9/4)만 알던 시절의 파서
    const m = norm(title).match(/(?<!\d)(\d{1,2})[월./-](\d{1,2})/);
    if (!m) return "";
    const mm = +m[1], dd = +m[2];
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
    return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  };
  const cands = [];
  for (const task of sermons) {
    const from = addDays(task.serviceDate, -1), to = task.due;
    const year = task.serviceDate.slice(0, 4);
    for (const post of posts) {
      const title = norm(post.title), posted = toISO(post.postDate);
      let score = 0;
      if (oldTitleDate(post.title, year) === task.serviceDate) score = 3;
      else if (posted >= from && posted <= to) score = title.includes(task.service) ? 2 : 1;
      if (score) cands.push({ score, task, post, posted });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.posted.localeCompare(b.posted));
  const byTask = {}; const used = new Set();
  for (const c of cands) {
    if (byTask[c.task.id] || used.has(c.post)) continue;
    byTask[c.task.id] = c.post; used.add(c.post);
  }
  return byTask;
}

/* ---- 커리큘럼/반 로드 (대시보드 loadCoursesMap 과 같은 규칙: 코드 시드 → RTDB 로 덮어씀) ---- */
function tasksFromObj(obj) {
  return Object.entries(obj || {}).map(([id, t]) => ({
    id, title: (t && t.title) || "", kind: (t && t.kind) || "기타",
    due: (t && t.due) || "", service: (t && t.service) || "", serviceDate: (t && t.serviceDate) || "",
    order: (t && typeof t.order === "number") ? t.order : 0,
  })).sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

async function loadCourses(db) {
  const map = {};
  for (const c of COURSES) {
    const seed = courseSeed(c);
    map[c.id] = { id: c.id, label: seed.label, tasks: tasksFromObj(seed.tasks) };
  }
  const snap = await db.ref("courses").get();
  if (snap.exists()) {
    for (const [id, c] of Object.entries(snap.val() || {})) {
      if (!c || typeof c !== "object") continue;
      map[id] = { id, label: c.label || id, tasks: tasksFromObj(c.tasks || {}) };
    }
  }
  return map;
}

async function main() {
  const db = initDb();
  const only = (process.env.MEMBER || "").trim();

  const [memSnap, clsSnap, courses] = await Promise.all([
    db.ref("members").get(), db.ref("classes").get(), loadCourses(db),
  ]);
  const classesById = clsSnap.exists() ? (clsSnap.val() || {}) : {};
  const members = Object.entries(memSnap.exists() ? (memSnap.val() || {}) : {})
    .map(([key, m]) => ({ name: (m && m.name) || key, class: (m && m.class) || (m && m.course) || "" }))
    .filter((m) => m.name && (!only || m.name === only))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  const changed = [];   // 고치기 전과 결과가 달라진 글
  const orphan = [];    // 제목에 날짜는 있는데 붙을 예배 과제가 없는 글
  const noDate = [];    // 제목에 날짜가 없어 게시일로 붙인 글(사람 확인 권장)
  let totalPosts = 0, totalMatched = 0;

  for (const m of members) {
    const cls = classesById[m.class] || {};
    const course = courses[cls.courseId || m.class];
    if (!course) continue;
    const dueMap = cls.due || {};
    const tasks = course.tasks.map((t) => ({ ...t, due: dueMap[t.id] || t.due || "" })).filter(isSermonTask);
    if (!tasks.length) continue;
    const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));

    const snap = await db.ref(`posts/${m.name}`).get();
    if (!snap.exists()) continue;
    const posts = Object.values(snap.val() || {})
      .filter((p) => p && p.title && categorize(p.title) === SERMON_CATEGORY)
      .sort((a, b) => String(a.postDate).localeCompare(String(b.postDate)));
    if (!posts.length) continue;
    totalPosts += posts.length;

    const now = matchSermonPosts(tasks, posts);
    const before = matchSermonPostsLegacy(tasks, posts);
    totalMatched += Object.keys(now).length;

    const taskOf = (map, post) => Object.keys(map).find((id) => map[id] === post) || "";
    const label = (id) => (id ? `${taskById[id] ? taskById[id].title : id}` : "(없음)");

    for (const post of posts) {
      const a = taskOf(before, post), b = taskOf(now, post);
      const line = `${m.name} | 올린날 ${String(post.postDate).slice(0, 10)} | ${post.title}`;
      if (a !== b) changed.push(`${line}\n      전: ${label(a)}\n      후: ${label(b)}`);
      if (!b) {
        const titleDate = sermonDateFromTitle(post.title, String(post.postDate).slice(0, 4));
        if (titleDate) orphan.push(`${line}\n      제목 날짜 ${titleDate} 에 해당하는 예배 과제가 없습니다.`);
      } else if (!hasTitleDate(post.title)) {
        noDate.push(`${line}\n      제목에 날짜가 없어 올린 날짜로 '${label(b)}' 에 붙였습니다.`);
      }
    }
  }

  const dump = (title, rows) => {
    console.log(`\n=== ${title} (${rows.length}건) ===`);
    for (const r of rows) console.log("  " + r);
    if (!rows.length) console.log("  (없음)");
  };

  console.log(`대상 멤버 ${members.length}명 · [${SERMON_CATEGORY}] 글 ${totalPosts}건 · 자동 매칭 ${totalMatched}건`);
  dump("① 수정 전후 배정이 달라진 글 — 예전 화면에서 잘못 붙어 있던 것들", changed);
  dump("② 제목 날짜에 해당하는 예배 과제가 없어 붙지 않는 글 — 제목 오타/특별예배 확인", orphan);
  dump("③ 제목에 날짜가 없어 올린 날짜로 붙인 글 — 늦게 올렸다면 틀릴 수 있으니 확인", noDate);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
