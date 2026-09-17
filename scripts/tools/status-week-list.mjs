// 출석·과제현황표의 어느 줄에 어떤 과제가 들어가는지 목록으로 뽑습니다(사람이 눈으로 확인하는 용도).
//
//   node scripts/tools/status-week-list.mjs [코스id] [> 목록.md]
//   코스id 기본값: disciple11   (예: node scripts/tools/status-week-list.mjs ministry)
//
// 내보내기와 **같은 함수**(statusWeekPlan)를 써서 묶습니다. 그래서 이 목록이 맞으면
// 실제 문서도 같게 찍히고, 목록이 틀리면 커리큘럼 관리에서 마감일만 고치면 됩니다.
//
// 묶는 규칙: 한 줄 = 그 강의일에 내준 과제 (= 마감일 직전 강의일 줄에 붙음)
//            이 커리큘럼은 '마감 = 다음 강의일' 이라 1주차 과제는 3/15 에 걷지만 3/8 줄입니다.
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { findElements, tableCells } from "../../js/hwpx/owpml.js";
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

/** 양식에 인쇄된 주차 번호(과제 행 첫 칸) ↔ 주차 키. 종이 양식과 대조할 때 씁니다. */
function printedWeekNo(xml, year) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, "");
  const form = readStatusForm(xml, year);
  const byKey = new Map();
  const keys = form.tables.flatMap((t) => t.weeks.map((w) => w.key));
  let i = 0;
  for (const tbl of findElements(xml, "hp:tbl")) {
    for (const r of findElements(xml, "hp:tr", tbl.start, tbl.end)) {
      const cells = tableCells(xml, r.start, r.end);
      const head = cells.find((c) => norm(c.text) === "생");
      if (!head) continue;
      const before = cells.filter((c) => c.start < head.start).map((c) => norm(c.text));
      const key = keys[i++];
      if (key) byKey.set(key, before[0] || "");
    }
  }
  return byKey;
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

  const out = [];
  out.push(`# ${course.label} — 주차별 생/독 배정 점검`);
  out.push("");
  out.push(`양식: \`출석과제현황-빈양식.hwpx\` · 멤버 열 ${form.slots}개 · 주차 ${form.keys.length}개`);
  out.push("");
  out.push("한 줄 = **그 강의일에 내준 과제** (= 마감일 직전 강의일 줄).");
  out.push("이 커리큘럼은 '마감 = 다음 강의일' 이라, 1주차 과제는 3/15 에 걷지만 **3/8 줄**에 체크합니다.");
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

  const printed = printedWeekNo(section, year);

  out.push("## 주차별");
  out.push("");
  out.push("`주차` = 커리큘럼 주차(= 이 표의 순번). `양식#` = 종이 양식 왼쪽 끝에 인쇄된 번호.");
  out.push("1학기는 `개강과제` 가 1번이라 양식# 가 주차보다 1 큽니다(양식 구조상 어쩔 수 없음).");
  out.push("");
  out.push("| 주차 | 양식# | 강의일 | 생 (생활간증·기타) | 독 (독서) | 금 | 주 |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  plan.rows.forEach((r, i) => {
    const empty = !r.life.length && !r.read.length;
    const mark = empty ? " ⚠️" : "";
    out.push(`| ${i + 1} | ${printed.get(r.key) || "—"} | ${withDow(r.key)}${mark}`
      + ` | ${dash(r.life, taskLabel)} | ${dash(r.read, taskLabel)}`
      + ` | ${r.fri.length || "—"} | ${r.sun.length || "—"} |`);
  });
  out.push("");

  /* ---- 확인이 필요한 것들 ---- */
  const notes = [];

  const doubled = plan.rows.filter((r) => r.life.filter((t) => t.week).length > 1);
  if (doubled.length) {
    notes.push("**한 줄에 주차 과제가 2개 이상**(양식에 그 주차 줄이 없다는 뜻):\n"
      + doubled.map((r) => `  - ${r.key} ← ${r.life.filter((t) => t.week).map((t) => `${t.week}주`).join(", ")}`).join("\n"));
  }

  // 주차 과제가 아닌 것(서약서·종강 소감 등)이 주차 줄에 같이 올라탄 경우.
  const riders = plan.rows.filter((r) => r.life.some((t) => !t.week) && r.life.some((t) => t.week));
  if (riders.length) {
    notes.push("**주차 과제에 다른 과제가 같이 올라탄 줄**(그 줄은 둘 다 내야 완료로 찍힙니다):\n"
      + riders.map((r) => `  - ${r.key} ← ${r.life.map((t) => t.week ? `${t.week}주` : t.title).join(" + ")}`).join("\n"));
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

  const why = { late: "마지막 강의일 뒤", gap: "그 주에 강의가 없음(방학 등)" };
  for (const reason of ["gap", "late"]) {
    const list = plan.unplaced.filter((t) => t.why === reason);
    if (!list.length) continue;
    // 설교간증은 방학마다 수십 건이라 한 줄로 줄입니다 — 나머지는 그대로 보여줍니다.
    const sermon = list.filter((t) => t.kind === "설교간증");
    const rest = list.filter((t) => t.kind !== "설교간증");
    const lines = rest.map((t) => `  - ${t.due} · ${t.kind} · ${t.title}`);
    if (sermon.length) {
      const days = sermon.map((t) => t.due).sort();
      lines.push(`  - 설교간증 ${sermon.length}건 (제출일 ${days[0]} ~ ${days[days.length - 1]})`);
    }
    notes.push(`**놓일 줄이 없는 과제** — ${why[reason]} (문서에 안 찍힙니다):\n${lines.join("\n")}`);
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
