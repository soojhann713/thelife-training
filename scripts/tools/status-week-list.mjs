// 출석·과제현황표의 어느 줄에 어떤 과제가 들어가는지 목록으로 뽑습니다(사람이 눈으로 확인하는 용도).
//
//   node scripts/tools/status-week-list.mjs [코스id] [> 목록.md]
//   코스id 기본값: disciple11   (예: node scripts/tools/status-week-list.mjs ministry)
//
// 내보내기와 **같은 함수**(statusWeekPlan)를 써서 묶습니다. 그래서 이 목록이 맞으면
// 실제 문서도 같게 찍히고, 목록이 틀리면 커리큘럼 관리에서 마감일만 고치면 됩니다.
//
// 묶는 규칙: 한 줄 = 그 강의일까지 내야 하는 과제 전부
//            (= 직전 강의일 다음날 ~ 그 강의일 사이에 마감인 과제)
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readStatusForm } from "../../js/hwpx/status.js";
import { statusWeekPlan } from "../../js/hwpx/status-data.js";
import { COURSES, findCourse, courseAssignments } from "../../js/assignments.js";

const TEMPLATE = fileURLToPath(new URL("../../assets/templates/출석과제현황-빈양식.hwpx", import.meta.url));

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
const dash = (list, fmt) => (list.length ? list.map(fmt).join("<br>") : "—");
const dayName = ["일", "월", "화", "수", "목", "금", "토"];
const withDow = (iso) => `${iso} (${dayName[new Date(`${iso}T00:00:00Z`).getUTCDay()]})`;

/** 생활간증은 제목이 길어 앞부분만. 주차 번호가 있으면 같이 보여줍니다. */
function taskLabel(t) {
  const head = t.week ? `**${t.week}주** ` : "";
  return `${head}${esc(t.title)}${t.due ? ` <sub>~${t.due.slice(5)}</sub>` : ""}`;
}

async function main() {
  const courseId = process.argv[2] || "disciple11";
  const course = findCourse(courseId);
  if (!course) {
    throw new Error(`코스를 찾지 못했습니다: ${courseId} (있는 것: ${COURSES.map((c) => c.id).join(", ")})`);
  }
  const tasks = courseAssignments(course);

  const zip = await JSZip.loadAsync(await readFile(TEMPLATE));
  const section = await zip.file("Contents/section0.xml").async("string");
  const year = +(tasks.map((t) => t.due).filter(Boolean).sort()[0] || "").slice(0, 4);
  const form = readStatusForm(section, year);

  const plan = statusWeekPlan({ tasks, weekKeys: form.keys });

  // 커리큘럼이 말하는 강의일(주차 정의에 적힌 값) — 양식에 그 줄이 있는지 대조합니다.
  const lectureDays = new Set(tasks.filter((t) => t.week && t.lecture !== undefined)
    .map((t) => t.due).filter(Boolean));

  const out = [];
  out.push(`# ${course.label} — 주차별 생/독 배정 점검`);
  out.push("");
  out.push(`양식: \`출석과제현황-빈양식.hwpx\` · 멤버 열 ${form.slots}개 · 주차 ${form.keys.length}개`);
  out.push("");
  out.push("한 줄 = **그 강의일까지 내야 하는 과제 전부** (직전 강의일 다음날 ~ 그 강의일 사이 마감).");
  out.push("`~MM-DD` 는 그 과제의 마감일입니다. 어긋난 줄이 있으면 커리큘럼 관리에서 **마감일만** 고치면 됩니다.");
  out.push("");

  if (plan.groups.length) {
    out.push("## 날짜 없는 줄 (개강과제 · 방학과제)");
    out.push("");
    out.push("| 줄 | 생 (생활간증·기타) | 독 (독서) |");
    out.push("| --- | --- | --- |");
    for (const g of plan.groups) {
      out.push(`| **${g.key}** | ${dash(g.life, taskLabel)} | ${dash(g.read, taskLabel)} |`);
    }
    out.push("");
  }

  out.push("## 주차별");
  out.push("");
  out.push("| # | 강의일 | 생 (생활간증·기타) | 독 (독서) | 금 | 주 |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  plan.rows.forEach((r, i) => {
    const empty = !r.life.length && !r.read.length;
    const mark = empty ? " ⚠️" : "";
    out.push(`| ${i + 1} | ${withDow(r.key)}${mark} | ${dash(r.life, taskLabel)} | ${dash(r.read, taskLabel)}`
      + ` | ${r.fri.length || "—"} | ${r.sun.length || "—"} |`);
  });
  out.push("");

  /* ---- 확인이 필요한 것들 ---- */
  const notes = [];

  const missingRow = [...lectureDays].filter((d) => !plan.lectures.includes(d)).sort();
  if (missingRow.length) {
    notes.push(`**양식에 줄이 없는 강의일**: ${missingRow.join(", ")}\n`
      + "  → 그 날 마감인 과제는 *다음* 강의일 줄에 함께 들어갑니다(아래 '두 주치가 한 줄' 참고).");
  }

  const doubled = plan.rows.filter((r) => r.life.length > 1);
  if (doubled.length) {
    notes.push("**한 줄에 생활간증이 2개 이상**(양식에 줄이 모자란 구간):\n"
      + doubled.map((r) => `  - ${r.key} ← ${r.life.map((t) => t.week ? `${t.week}주` : t.title).join(", ")}`).join("\n"));
  }

  const blank = plan.rows.filter((r) => !r.life.length && !r.read.length);
  if (blank.length) {
    notes.push(`**생/독이 하나도 안 붙은 줄**: ${blank.map((r) => r.key).join(", ")}\n`
      + "  → 그 강의일까지 마감인 생활간증·독서가 커리큘럼에 없다는 뜻입니다(개강·종강 주면 정상).");
  }

  const manySermons = plan.rows.filter((r) => r.fri.length > 1 || r.sun.length > 1);
  if (manySermons.length) {
    notes.push("**한 줄에 예배가 2회 이상**(보통 금 1·주 1):\n"
      + manySermons.map((r) =>
        `  - ${r.key} ← 금 ${r.fri.length} · 주 ${r.sun.length}`
        + ` (${[...r.fri, ...r.sun].map((t) => t.title.replace(/예배 말씀$/, "")).join(", ")})`).join("\n")
      + "\n  → 방학 중 예배까지 커리큘럼에 들어 있으면 이렇게 됩니다. 그 줄은 전부 체크돼야 완료로 찍힙니다.");
  }

  const why = { late: "마지막 강의일보다 늦게 마감", gap: "그 주차 줄이 양식에 없음" };
  for (const reason of ["gap", "late"]) {
    const list = plan.unplaced.filter((t) => t.why === reason);
    if (!list.length) continue;
    notes.push(`**놓일 줄이 없는 과제** — ${why[reason]} (문서에 안 찍힙니다):\n`
      + list.map((t) => `  - ${t.due} · ${t.kind} · ${t.title}`).join("\n"));
  }

  if (form.warnings.length) {
    notes.push(`**양식에서 자동으로 채우지 않는 행**: ${form.warnings.join(" · ")}`);
  }

  out.push("## 확인이 필요한 것");
  out.push("");
  out.push(notes.length ? notes.map((n) => `- ${n}`).join("\n") : "- 없습니다.");
  out.push("");

  console.log(out.join("\n"));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
