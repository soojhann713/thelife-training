// 출석·과제현황표(주차별 체크리스트) 테스트.
// 실제로 커밋된 빈 양식을 읽어 씁니다 — 양식이 바뀌면(주차·멤버 열·병합) 여기서 먼저 걸립니다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import { findElements, tableCells, cellCharPr, setCellCharPr, applyEdits } from "../../js/hwpx/owpml.js";
import {
  readStatusForm, compileStatusSection, setStatusTitle, statusPreviewText,
  CHAR_DONE, CHAR_MISS, CHAR_NA,
} from "../../js/hwpx/status.js";
import { buildStatusHwpx } from "../../js/hwpx/build.js";
import { statusValues, titleParts, isoAdd } from "../../js/hwpx/status-data.js";
import { COURSES, courseAssignments, sermonItems } from "../../js/assignments.js";

const TEMPLATE = fileURLToPath(new URL("../../assets/templates/출석과제현황-빈양식.hwpx", import.meta.url));
const templateBytes = readFileSync(TEMPLATE);
const YEAR = 2026;

async function section() {
  const zip = await JSZip.loadAsync(templateBytes);
  return zip.file("Contents/section0.xml").async("string");
}

// 채워진 XML 에서 (주차키, 멤버순번) 의 여섯 칸 서식·글자를 읽어옵니다.
function cellsOf(xml, key, slot) {
  const form = readStatusForm(xml, YEAR);
  for (const t of form.tables) {
    for (const w of t.weeks) {
      if (w.key !== key) continue;
      const read = (c) => ({ text: c.text, charPr: cellCharPr(xml.slice(c.start, c.end)) });
      const g = w.task[slot];
      const a = w.attend ? w.attend[slot] : null;
      return {
        life: read(g[0]), qt: read(g[1]), read: read(g[2]),
        att: a && read(a[0]), fri: a && read(a[1]), sun: a && read(a[2]),
      };
    }
  }
  throw new Error(`주차 '${key}' 를 찾지 못했습니다`);
}

const MEMBERS = ["가나다", "라마바", "사아자", "차카타", "파하가", "나다라", "마바사",
  "아자차", "카타파", "하가나", "다라마", "바사아", "자차카"];

/* ---------- 양식 읽기 ---------- */

test("readStatusForm: 커밋된 빈 양식의 멤버 열·주차 수", async () => {
  const form = readStatusForm(await section(), YEAR);
  assert.equal(form.slots, 13);
  assert.equal(form.tables.length, 2);
  assert.equal(form.keys.length, 27);
  assert.ok(form.keys.includes("개강과제"));
  assert.ok(form.keys.includes("방학과제"));
  // 날짜 칸 '3/8' 은 3월 8일, 그 다음 '15' 는 같은 3월 15일로 이어집니다.
  assert.ok(form.keys.includes("2026-03-08"));
  assert.ok(form.keys.includes("2026-03-15"));
  assert.ok(form.keys.includes("2026-11-15"));
});

test("readStatusForm: 주차 번호를 날짜로 잘못 읽지 않는다", async () => {
  const form = readStatusForm(await section(), YEAR);
  // 날짜 칸이 빈 마지막 주차가 '11월 26일'(주차 번호 26) 로 새지 않아야 합니다.
  assert.ok(!form.keys.includes("2026-11-26"));
  assert.ok(!form.keys.includes("2026-11-27"));
});

test("readStatusForm: 멤버 열 수와 안 맞는 행을 경고로 알린다", async () => {
  const form = readStatusForm(await section(), YEAR);
  // 양식의 6/7·6/14 출석 행은 셀 병합이 어긋나 13칸이 안 나옵니다.
  assert.equal(form.warnings.length, 2);
  assert.ok(form.warnings.every((w) => w.includes("출석 행")));
  const bad = form.tables[0].weeks.filter((w) => !w.attendOk && w.attend);
  assert.equal(bad.length, 2);
  assert.ok(bad.every((w) => w.taskOk)); // 과제 행은 정상이라 그건 채웁니다
});

test("빈 양식에는 이름과 완료 표시가 남아 있지 않다", async () => {
  const xml = await section();
  const form = readStatusForm(xml, YEAR);
  for (const t of form.tables) {
    for (const c of t.nameCells) assert.equal(c.text, "");
    for (const w of t.weeks) {
      for (const g of [...w.task, ...(w.attend || [])]) {
        for (const c of g) {
          const cp = cellCharPr(xml.slice(c.start, c.end));
          assert.ok(cp === CHAR_MISS || cp === CHAR_NA, `${w.key} 칸의 글자모양이 ${cp}`);
        }
      }
    }
  }
});

/* ---------- 채우기 ---------- */

test("compileStatusSection: 이름 행을 멤버 순서대로 채운다", async () => {
  const out = compileStatusSection(await section(), { year: YEAR, members: MEMBERS });
  const form = readStatusForm(out, YEAR);
  for (const t of form.tables) {
    assert.deepEqual(t.nameCells.map((c) => c.text), MEMBERS);
  }
});

test("compileStatusSection: 멤버가 열보다 적으면 남는 열은 비운다", async () => {
  const out = compileStatusSection(await section(), { year: YEAR, members: ["가나다", "라마바"] });
  const names = readStatusForm(out, YEAR).tables[0].nameCells.map((c) => c.text);
  assert.deepEqual(names, ["가나다", "라마바", "", "", "", "", "", "", "", "", "", "", ""]);
});

test("compileStatusSection: 완료/미완료를 글자모양으로 표시한다", async () => {
  const doc = {
    year: YEAR, members: MEMBERS,
    values: {
      "2026-05-03": {
        가나다: { life: true, read: false, fri: true, sun: false, qt: 6 },
        라마바: { life: false, read: false, fri: false, sun: false, qt: 0 },
      },
    },
  };
  const out = compileStatusSection(await section(), doc);

  const a = cellsOf(out, "2026-05-03", 0);
  assert.equal(a.life.charPr, CHAR_DONE);
  assert.equal(a.read.charPr, CHAR_MISS);
  assert.equal(a.fri.charPr, CHAR_DONE);
  assert.equal(a.sun.charPr, CHAR_MISS);
  assert.equal(a.qt.text, "6");
  assert.equal(a.qt.charPr, CHAR_DONE);
  assert.equal(a.life.text, "생"); // 라벨 글자는 그대로
  assert.equal(a.fri.text, "금");

  const b = cellsOf(out, "2026-05-03", 1);
  assert.equal(b.qt.text, "0");
  assert.equal(b.qt.charPr, CHAR_MISS); // 0일은 회색

  // 값을 안 준 멤버(3번째)는 양식 그대로
  const c = cellsOf(out, "2026-05-03", 2);
  assert.equal(c.qt.text, "큐");
  assert.equal(c.life.charPr, CHAR_MISS);
});

test("compileStatusSection: 강의 출석('출')은 절대 건드리지 않는다", async () => {
  const xml = await section();
  const before = cellsOf(xml, "2026-05-03", 0).att;
  const out = compileStatusSection(xml, {
    year: YEAR, members: MEMBERS,
    values: { "2026-05-03": { 가나다: { life: true, read: true, fri: true, sun: true, qt: 7 } } },
  });
  const after = cellsOf(out, "2026-05-03", 0).att;
  assert.deepEqual(after, before);
});

test("compileStatusSection: '해당 없음'(취소선) 칸은 건드리지 않는다", async () => {
  const xml = await section();
  // 양식이 3/15 주차의 '독' 을 취소선으로 표시해 뒀습니다(그 주엔 독서 과제 없음).
  assert.equal(cellsOf(xml, "2026-03-15", 0).read.charPr, CHAR_NA);
  const out = compileStatusSection(xml, {
    year: YEAR, members: MEMBERS,
    values: { "2026-03-15": { 가나다: { life: true, read: true, qt: 3 } } },
  });
  assert.equal(cellsOf(out, "2026-03-15", 0).read.charPr, CHAR_NA);
  assert.equal(cellsOf(out, "2026-03-15", 0).life.charPr, CHAR_DONE);
});

test("compileStatusSection: 칸 수가 어긋난 출석 행은 채우지 않는다", async () => {
  const xml = await section();
  const out = compileStatusSection(xml, {
    year: YEAR, members: MEMBERS,
    values: { "2026-06-07": { 가나다: { life: true, read: true, fri: true, sun: true, qt: 7 } } },
  });
  const cells = cellsOf(out, "2026-06-07", 0);
  assert.equal(cells.life.charPr, CHAR_DONE);   // 과제 행은 정상
  assert.equal(cells.fri.charPr, CHAR_MISS);    // 출석 행은 손대지 않음
  assert.equal(cells.sun.charPr, CHAR_MISS);
});

test("compileStatusSection: 값이 없는 주차는 양식 그대로", async () => {
  const xml = await section();
  const out = compileStatusSection(xml, { year: YEAR, members: MEMBERS, values: {} });
  // 이름 행만 바뀌므로 주차 칸의 글자모양 합은 같아야 합니다.
  const sum = (s) => (s.match(/charPrIDRef="13"/g) || []).length;
  assert.equal(sum(out), sum(xml));
});

/* ---------- 제목 ---------- */

test("setStatusTitle: 연도·기수·과정·요일·시작일을 갈아끼운다", () => {
  const para = '<hp:p><hp:run charPrIDRef="11"><hp:t>  2026년 제11기</hp:t></hp:run>'
    + '<hp:run charPrIDRef="23"><hp:t> 제자</hp:t></hp:run>'
    + '<hp:run charPrIDRef="12"><hp:t>반(주일) </hp:t></hp:run>'
    + '<hp:run charPrIDRef="11"><hp:t>출석과 과제현황(2026.3.8.~  )</hp:t></hp:run></hp:p>';
  const out = setStatusTitle(para, { year: 2027, cohort: "9", course: "사역", day: "토요", start: "2027-03-07" });
  assert.ok(out.includes("2027년 제9기"));
  assert.ok(out.includes("<hp:t> 사역</hp:t>"));
  assert.ok(out.includes("반(토요)"));
  assert.ok(out.includes("(2027.3.7.~"));
  // run 이 4개 그대로 남아 서식이 유지됩니다.
  assert.equal(findElements(out, "hp:run").length, 4);
  assert.ok(out.includes('charPrIDRef="23"'));
});

test("compileStatusSection: 표 위 제목 문단을 반 정보로 바꾼다", async () => {
  const out = compileStatusSection(await section(), {
    year: 2027, members: MEMBERS,
    title: { year: 2027, cohort: "12", course: "제자", day: "주일", start: "2027-03-07" },
  });
  const head = out.slice(0, out.indexOf("<hp:tbl"));
  assert.ok(head.includes("2027년 제12기"));
  assert.ok(head.includes("(2027.3.7.~"));
  assert.ok(!head.includes("2026년"));
});

/* ---------- 파일로 묶기 ---------- */

test("buildStatusHwpx: 양식의 엔트리를 그대로 지키고 본문만 갈아끼운다", async () => {
  const doc = {
    year: YEAR, members: MEMBERS,
    title: { year: YEAR, cohort: "11", course: "제자", day: "주일", start: "2026-03-08", text: "테스트" },
    values: { "2026-05-03": { 가나다: { life: true, read: true, fri: true, sun: false, qt: 5 } } },
  };
  const bytes = await buildStatusHwpx(JSZip, templateBytes, doc, { type: "uint8array" });
  const src = await JSZip.loadAsync(templateBytes);
  const out = await JSZip.loadAsync(bytes);

  const names = (z) => Object.keys(z.files).filter((n) => !z.files[n].dir);
  assert.deepEqual(names(out), names(src));
  assert.equal(names(out)[0], "mimetype");
  assert.equal(await out.file("mimetype").async("string"), await src.file("mimetype").async("string"));
  assert.equal(await out.file("Contents/header.xml").async("string"),
    await src.file("Contents/header.xml").async("string")); // 서식은 손대지 않습니다

  const xml = await out.file("Contents/section0.xml").async("string");
  assert.equal(cellsOf(xml, "2026-05-03", 0).life.charPr, CHAR_DONE);
  assert.equal(readStatusForm(xml, YEAR).tables[0].nameCells[0].text, "가나다");
  assert.equal(await out.file("Preview/PrvText.txt").async("string"), statusPreviewText(doc));
});

/* ---------- 저수준 도구 ---------- */

test("setCellCharPr / cellCharPr: 셀 안 모든 run 의 글자모양을 바꾼다", () => {
  const tc = '<hp:tc><hp:subList><hp:p><hp:run charPrIDRef="20"><hp:t>가</hp:t></hp:run>'
    + '<hp:run charPrIDRef="20"><hp:t>나</hp:t></hp:run></hp:p></hp:subList></hp:tc>';
  assert.equal(cellCharPr(tc), 20);
  const out = setCellCharPr(tc, 13);
  assert.equal(cellCharPr(out), 13);
  assert.equal((out.match(/charPrIDRef="13"/g) || []).length, 2);
});

test("applyEdits: 여러 구간을 뒤에서부터 갈아끼운다", () => {
  const xml = "0123456789";
  assert.equal(applyEdits(xml, [{ start: 0, end: 2, xml: "AA" }, { start: 8, end: 10, xml: "ZZZ" }]), "AA234567ZZZ");
  assert.equal(applyEdits(xml, []), xml);
});

test("tableCells: 양식 표의 셀 수가 rowCnt·colCnt 와 맞는다", async () => {
  const xml = await section();
  const tbl = findElements(xml, "hp:tbl")[0];
  const head = xml.slice(tbl.start, xml.indexOf(">", tbl.start));
  assert.ok(head.includes('rowCnt="38"'));
  assert.ok(head.includes('colCnt="55"'));
  assert.equal(findElements(xml, "hp:tr", tbl.start, tbl.end).length, 38);
  assert.ok(tableCells(xml, tbl.start, tbl.end).length > 1000);
});

/* ---------- 값 집계 (status-data) ---------- */

const NEVER = () => false;
const NO_QT = () => new Set();

test("isoAdd: 달·해를 넘어가는 날짜 계산", () => {
  assert.equal(isoAdd("2026-03-01", -1), "2026-02-28");
  assert.equal(isoAdd("2026-01-01", -1), "2025-12-31");
  assert.equal(isoAdd("2026-05-03", -6), "2026-04-27");
});

test("statusValues: 마감일로 생·독을 맞춘다", () => {
  const tasks = [
    { id: "life1", kind: "생활간증", due: "2026-05-03", group: "1학기" },
    { id: "read1", kind: "독서", due: "2026-05-03", group: "1학기" },
    { id: "life2", kind: "생활간증", due: "2026-05-10", group: "1학기" },
  ];
  const done = new Set(["life1"]);
  const { values } = statusValues({
    names: ["갑"], tasks, today: "2026-05-31",
    isDone: (_n, id) => done.has(id), qtDays: NO_QT,
  });
  assert.equal(values["2026-05-03"].갑.life, true);
  assert.equal(values["2026-05-03"].갑.read, false);
  assert.equal(values["2026-05-10"].갑.life, false);
  // 해당 마감일에 독서 과제가 없는 주차는 undefined — 양식 칸을 건드리지 않습니다.
  assert.equal(values["2026-05-10"].갑.read, undefined);
});

test("statusValues: 설교간증을 금·주로 나눠 맞춘다", () => {
  // 5/1(금)·4/26(주일) 예배 → 둘 다 제출일 5/3
  const tasks = sermonItems("t", "2026-04-24", "2026-05-10").map((t) => ({ ...t, group: "예배은혜나눔" }));
  const fri = tasks.find((t) => t.due === "2026-05-03" && t.service === "금요");
  const sun = tasks.find((t) => t.due === "2026-05-03" && t.service === "주일");
  assert.equal(fri.serviceDate, "2026-05-01");
  assert.equal(sun.serviceDate, "2026-04-26");

  const { values } = statusValues({
    names: ["갑"], tasks, today: "2026-05-31",
    isDone: (_n, id) => id === sun.id, qtDays: NO_QT,
  });
  assert.equal(values["2026-05-03"].갑.sun, true);
  assert.equal(values["2026-05-03"].갑.fri, false);
});

test("statusValues: 큐티는 강의일까지 7일 안의 서로 다른 날 수", () => {
  const tasks = [{ id: "l", kind: "생활간증", due: "2026-05-03", group: "1학기" }];
  const days = new Set(["2026-04-27", "2026-04-28", "2026-05-03", "2026-04-20"]); // 4/20 은 창 밖
  const { values } = statusValues({
    names: ["갑"], tasks, today: "2026-05-31", isDone: NEVER, qtDays: () => days,
  });
  assert.equal(values["2026-05-03"].갑.qt, 3);
});

test("statusValues: 개강·방학 그룹은 이름 없는 줄로 따로 모은다", () => {
  const tasks = [
    { id: "pre-read", kind: "독서", due: "2026-03-08", group: "개강 전" },
    { id: "pre-t", kind: "기타", due: "2026-03-08", group: "개강 전" },
    { id: "vac-read", kind: "독서", due: "2026-09-06", group: "방학" },
    { id: "vac-v1", kind: "기타", due: "2026-09-06", group: "방학" },
    { id: "vac-v2", kind: "기타", due: "2026-09-06", group: "방학" },
  ];
  const done = new Set(["pre-read", "pre-t", "vac-v1"]);
  const { values } = statusValues({
    names: ["갑"], tasks, today: "2026-12-31",
    isDone: (_n, id) => done.has(id), qtDays: NO_QT,
  });
  assert.deepEqual(values["개강과제"].갑, { life: true, read: true });
  assert.deepEqual(values["방학과제"].갑, { life: false, read: false }); // 영상 2개 중 1개만
  // 개강·방학 과제는 날짜 줄에서 중복으로 세지 않습니다.
  assert.equal(values["2026-03-08"].갑.read, undefined);
  assert.equal(values["2026-09-06"].갑.life, undefined);
});

test("statusValues: 아직 오지 않은 주차는 값을 만들지 않는다", () => {
  const tasks = [
    { id: "a", kind: "생활간증", due: "2026-05-03", group: "1학기" },
    { id: "b", kind: "생활간증", due: "2026-05-31", group: "1학기" },
  ];
  const { values } = statusValues({
    names: ["갑"], tasks, today: "2026-05-10", isDone: NEVER, qtDays: NO_QT,
  });
  assert.ok(values["2026-05-03"]);
  assert.ok(values["2026-05-10"]);
  assert.ok(!values["2026-05-17"]);
  assert.ok(!values["2026-05-31"]);
});

test("titleParts: 반 이름에서 기수·과정·요일을 뽑는다", () => {
  assert.deepEqual(titleParts("제자반 11기 (주일반)", 2026, "2026-03-08"), {
    year: 2026, cohort: "11", course: "제자", day: "주일", start: "2026-03-08",
    text: "2026년 제11기 제자반(주일) 출석과 과제현황",
  });
  const m = titleParts("사역반 9기", 2026, "2026-03-08");
  assert.equal(m.course, "사역");
  assert.equal(m.day, "");
  assert.equal(m.text, "2026년 제9기 사역반 출석과 과제현황");
});

test("실제 커리큘럼(제자반 11기)이 양식의 주차와 맞물린다", async () => {
  const course = COURSES.find((c) => c.id === "disciple11");
  const tasks = courseAssignments(course);
  const { values } = statusValues({
    names: ["갑"], tasks, today: "2026-12-31", isDone: () => true, qtDays: NO_QT,
  });
  const form = readStatusForm(await section(), YEAR);

  // 양식의 날짜 줄 가운데 값이 만들어지지 않은 줄이 없어야 합니다(날짜 해석이 어긋나면 여기서 걸립니다).
  const missing = form.keys.filter((k) => !values[k]);
  assert.deepEqual(missing, []);

  // 설교간증은 개강~종강 사이 모든 금·주일이라 양식의 거의 모든 주차에 금·주가 붙습니다.
  const dated = form.keys.filter((k) => /^\d{4}-/.test(k));
  const withSermon = dated.filter((k) => values[k].갑.fri === true && values[k].갑.sun === true);
  assert.ok(withSermon.length >= dated.length - 2, `금·주가 붙은 주차 ${withSermon.length}/${dated.length}`);
});
