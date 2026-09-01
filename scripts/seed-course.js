// 커리큘럼(js/assignments.js 의 COURSES)을 RTDB /courses 에 반영합니다.
//
// /courses 는 운영 데이터이고 웹 '커리큘럼 관리'에서 편집됩니다(CLAUDE.md 불변식 4).
// 그래서 기본 동작은 **덮어쓰기가 아니라 병합**입니다:
//   - 시드에만 있고 RTDB 에 없는 과제 → 추가
//   - 양쪽에 있는 과제       → 그대로 둠 (웹에서 손본 제목·키워드·마감일을 지키기 위해)
//   - RTDB 에만 있는 과제     → 그대로 둠 (관리자가 직접 추가한 과제를 지우지 않음)
// 과제 id 는 assignments/<이름>/<과제id> 체크 기록과 연결되므로 절대 새로 만들지 않습니다.
//
// 환경변수:
//   COURSE=<id>  특정 과정만 (예: disciple11, ministry). 비우면 전체
//   FORCE=1      양쪽에 있는 과제도 시드 값으로 덮어씀 (제목·종류·그룹·순서·키워드·마감일)
//   PRUNE=1      시드에 없는 과제를 삭제 (FORCE 와 함께 쓸 때만 의미 있음 — 기본 꺼짐)
//   DRY=1        쓰지 않고 무엇이 바뀌는지만 출력
import { initDb } from "./lib/firebase.js";
import { COURSES, courseSeed } from "../js/assignments.js";

const only = (process.env.COURSE || "").trim();
const FORCE = process.env.FORCE === "1";
const PRUNE = process.env.PRUNE === "1";
const DRY = process.env.DRY === "1";

// 시드와 RTDB 과제가 실질적으로 같은지 (배열은 순서까지 비교)
function sameTask(a, b) {
  if (!a || !b) return false;
  const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
  return a.title === b.title && a.kind === b.kind && a.group === b.group
    && (a.due || "") === (b.due || "") && a.order === b.order
    && arr(a.m) === arr(b.m) && arr(a.x) === arr(b.x);
}

async function main() {
  const db = initDb();
  const targets = only ? COURSES.filter((c) => c.id === only) : COURSES;
  if (!targets.length) {
    throw new Error(`COURSE='${only}' 에 해당하는 과정이 없습니다. (${COURSES.map((c) => c.id).join(", ")})`);
  }
  if (DRY) console.log("── DRY=1: 실제로 쓰지 않고 비교만 합니다 ──");

  for (const course of targets) {
    const seed = courseSeed(course);
    const ref = db.ref(`courses/${course.id}`);
    const cur = (await ref.get()).val() || {};
    const curTasks = cur.tasks || {};

    const updates = {};
    const added = [];
    const changed = [];
    const kept = [];

    for (const [id, task] of Object.entries(seed.tasks)) {
      if (!curTasks[id]) { updates[`tasks/${id}`] = task; added.push(id); continue; }
      if (!FORCE) { kept.push(id); continue; }
      if (sameTask(task, curTasks[id])) { kept.push(id); continue; }
      updates[`tasks/${id}`] = task;
      changed.push(id);
    }

    const extra = Object.keys(curTasks).filter((id) => !seed.tasks[id]);
    if (PRUNE) for (const id of extra) updates[`tasks/${id}`] = null;

    if (!cur.label) updates.label = seed.label;

    console.log(`\n[${course.id}] ${seed.label}`);
    console.log(`  RTDB ${Object.keys(curTasks).length}개 / 시드 ${Object.keys(seed.tasks).length}개`);
    console.log(`  추가 ${added.length} · 갱신 ${changed.length} · 유지 ${kept.length} · 시드에 없는 항목 ${extra.length}${PRUNE ? " (삭제함)" : " (그대로 둠)"}`);
    if (added.length) console.log(`  + ${added.slice(0, 8).join(", ")}${added.length > 8 ? ` … 외 ${added.length - 8}개` : ""}`);
    if (changed.length) console.log(`  ~ ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ` … 외 ${changed.length - 8}개` : ""}`);
    if (extra.length && !PRUNE) console.log(`  ? ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? ` … 외 ${extra.length - 8}개` : ""}`);

    const n = Object.keys(updates).length;
    if (!n) { console.log("  → 바뀔 내용이 없습니다."); continue; }
    if (DRY) { console.log(`  → DRY 모드라 쓰지 않았습니다 (${n}건 예정).`); continue; }
    await ref.update(updates);
    console.log(`  → ${n}건 반영했습니다.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
