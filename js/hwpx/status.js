// 출석·과제현황표(주차별 체크리스트) 컴파일러.
//
// 과제 취합문서(compile.js)와는 방식이 완전히 다릅니다. 취합문서는 멤버마다 표 블록을 복제하지만,
// 현황표는 **양식이 이미 갖고 있는 칸의 서식만 바꿉니다.** 표 구조(주차 수·멤버 열 수·날짜)는
// 양식이 정하고, 우리는 거기에 값만 얹습니다. 그래서 양식은 한 글자도 고치지 않아도 됩니다.
//
// 완료/미완료는 글자모양 id 로만 나타납니다(양식 header.xml 의 charPr):
//   13 = 6pt 진하게 검정      → 완료
//   20 = 6pt 회색             → 미완료
//   32 = 6pt 회색 + 취소선    → 해당 없음(그 주차엔 그 과제가 없음)
// 32 는 교회가 양식에 직접 적어 둔 '그 주엔 없음' 표시라서 **절대 건드리지 않습니다.**
//
// 표 읽는 법 (좌표를 박아 두지 않고 라벨을 앵커로 씁니다 — 양식의 셀 주소가 어긋난 구간이 있어서):
//   이름 행   : colSpan=4 셀이 2개 이상인 행. 그 셀들이 멤버 열 순서입니다.
//   과제 행   : '생' 라벨이 있는 행. 멤버당 [생] [큐티일수] [독] 3칸.
//   출석 행   : '출'(또는 'MT') 라벨이 있는 행. 멤버당 [출] [금] [주] 3칸.
//   주차 날짜 : 그 행에서 첫 라벨 셀 바로 앞 셀
//               ('3/8' → 3월 8일, '15' → 앞에서 본 월의 15일, '개강과제'/'방학과제' → 라벨 그대로)

import {
  findElements, tableCells, setCellText, cellCharPr, setCellCharPr, applyEdits, escapeXml,
} from "./owpml.js";

export const CHAR_DONE = 13;
export const CHAR_MISS = 20;
export const CHAR_NA = 32;

const HEAD_TASK = "생";
const HEAD_ATTEND = new Set(["출", "MT"]);
const norm = (s) => String(s ?? "").replace(/\s+/g, "");
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function rowKind(cells) {
  let four = 0, task = false, attend = false;
  for (const c of cells) {
    const t = norm(c.text);
    if (t === HEAD_TASK) task = true;
    if (HEAD_ATTEND.has(t)) attend = true;
    if (c.colSpan === 4) four++;
  }
  if (task) return "task";
  if (attend) return "attend";
  if (four >= 2) return "name";
  return "other";
}

// 한 행의 셀들을 멤버 묶음(3칸씩)으로 자릅니다. 라벨 셀이 묶음의 시작입니다.
// 셀 주소(cellAddr)가 아니라 순서를 쓰기 때문에, 양식의 병합으로 열이 한 칸 밀린 구간도 그대로 따릅니다.
function memberGroups(cells, kind) {
  const isHead = (t) => (kind === "task" ? t === HEAD_TASK : HEAD_ATTEND.has(t));
  const out = [];
  for (const c of cells) {
    if (isHead(norm(c.text))) out.push([c]);
    else if (out.length) {
      const g = out[out.length - 1];
      if (g.length < 3) g.push(c);
    }
  }
  return out.filter((g) => g.length === 3);
}

// 첫 라벨 셀 **바로 앞** 셀의 텍스트(= 주차 날짜 칸).
// '마지막 비어있지 않은 셀'로 하면 날짜가 빈 행에서 주차 번호를 날짜로 잘못 읽습니다.
function prefixLabel(cells, groups) {
  if (!groups.length) return "";
  const headStart = groups[0][0].start;
  let prev = null;
  for (const c of cells) {
    if (c.start >= headStart) break;
    prev = c;
  }
  return prev ? norm(prev.text) : "";
}

// '3/8' → 3월 시작, '15' → 앞에서 본 월의 15일. 월은 표 안에서 이어집니다.
function resolveKeys(weeks, year) {
  let month = 0;
  for (const w of weeks) {
    const md = w.label.match(/^(\d{1,2})[/.\-](\d{1,2})$/);
    if (md) { month = +md[1]; w.date = isoOf(year, month, +md[2]); }
    else {
      const dd = w.label.match(/^(\d{1,2})$/);
      w.date = (dd && month) ? isoOf(year, month, +dd[1]) : "";
    }
    w.key = w.date || w.label;
  }
}

/**
 * 양식(section0.xml)에서 이름 행과 주차 행들을 읽어냅니다.
 * 반환값의 셀은 원본 XML 안의 절대 위치(start/end)를 들고 있어 그대로 갈아끼울 수 있습니다.
 */
export function readStatusForm(xml, year) {
  const tables = [];
  for (const t of findElements(xml, "hp:tbl")) {
    const info = { start: t.start, end: t.end, nameCells: [], weeks: [] };
    let pending = null;
    for (const r of findElements(xml, "hp:tr", t.start, t.end)) {
      const cells = tableCells(xml, r.start, r.end);
      const kind = rowKind(cells);
      if (kind === "name") {
        if (!info.nameCells.length) info.nameCells = cells.filter((c) => c.colSpan === 4);
      } else if (kind === "task") {
        const groups = memberGroups(cells, "task");
        if (!groups.length) continue;
        pending = { label: prefixLabel(cells, groups), task: groups, taskCells: cells, attend: null, attendCells: null };
        info.weeks.push(pending);
      } else if (kind === "attend") {
        const groups = memberGroups(cells, "attend");
        if (pending && !pending.attend && groups.length) { pending.attend = groups; pending.attendCells = cells; }
      }
    }
    resolveKeys(info.weeks, year);
    tables.push(info);
  }

  // 멤버 열 수와 묶음 수가 다른 행은 채우지 않습니다.
  // 양식에 셀 병합이 어긋난 구간이 있어(예: 6/7·6/14 주차의 출석 행) 순서대로 맞추면 남의 칸에 쓰게 됩니다.
  const slots = Math.max(0, ...tables.map((t) => t.nameCells.length));
  const warnings = [];
  for (const t of tables) {
    for (const w of t.weeks) {
      w.taskOk = w.task.length === slots;
      w.attendOk = !!w.attend && w.attend.length === slots;
      if (!w.key) continue;
      if (!w.taskOk) warnings.push(`${w.key} 과제 행(칸 ${w.task.length}/${slots})`);
      if (w.attend && !w.attendOk) warnings.push(`${w.key} 출석 행(칸 ${w.attend.length}/${slots})`);
    }
  }
  return {
    tables, slots, warnings,
    keys: tables.flatMap((t) => t.weeks.map((w) => w.key)).filter(Boolean),
  };
}

function flagEdit(xml, cell, flag) {
  if (flag !== true && flag !== false) return null;
  const tc = xml.slice(cell.start, cell.end);
  if (cellCharPr(tc) === CHAR_NA) return null; // 양식이 '해당 없음'으로 표시해 둔 칸
  return { start: cell.start, end: cell.end, xml: setCellCharPr(tc, flag ? CHAR_DONE : CHAR_MISS) };
}

function qtEdit(xml, cell, n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const tc = xml.slice(cell.start, cell.end);
  if (cellCharPr(tc) === CHAR_NA) return null;
  const done = n > 0;
  return {
    start: cell.start, end: cell.end,
    xml: setCellCharPr(setCellText(tc, String(n)), done ? CHAR_DONE : CHAR_MISS),
  };
}

/** 표 위 제목 문단의 연도·기수·과정·기간을 반 정보로 갈아끼웁니다. */
export function setStatusTitle(paraXml, t) {
  let out = paraXml;
  if (t.year) out = out.replace(/\d{4}년/, `${t.year}년`);
  if (t.cohort) out = out.replace(/제\s*\d+\s*기/, `제${escapeXml(t.cohort)}기`);
  if (t.course) out = out.replace(/(<hp:t>\s*)(여성제자|제자|사역)(<\/hp:t>)/, `$1${escapeXml(t.course)}$3`);
  out = out.replace(/반\([^)]*\)/, t.day ? `반(${escapeXml(t.day)})` : "반");
  if (t.start) {
    const [y, m, d] = t.start.split("-").map(Number);
    if (y && m && d) out = out.replace(/\(\s*\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.\s*~/, `(${y}.${m}.${d}.~`);
  }
  return out;
}

const TITLE_RE = /출석과?\s*과제\s*현황/;

function titleEdit(xml, title) {
  if (!title) return null;
  const firstTbl = xml.indexOf("<hp:tbl");
  const to = firstTbl < 0 ? xml.length : firstTbl;
  for (const p of findElements(xml, "hp:p", 0, to)) {
    const para = xml.slice(p.start, p.end);
    if (!TITLE_RE.test(para)) continue;
    return { start: p.start, end: p.end, xml: setStatusTitle(para, title) };
  }
  return null;
}

/**
 * 양식 section0.xml + 집계값 → 채워진 section0.xml.
 *
 * doc = {
 *   year, title: { year, cohort, course, day, start },
 *   members: ["강성건", ...],                       // 표의 멤버 열 순서
 *   values: { "<주차키>": { "<이름>": { life, read, qt, fri, sun } } }
 * }
 * 값이 `undefined` 인 항목은 **그 칸을 건드리지 않습니다** (아직 모르는 주차 = 양식 그대로).
 * 출석('출')은 늘 그대로 둡니다 — 관리자가 마지막에 직접 체크합니다.
 */
export function compileStatusSection(xml, doc) {
  const year = doc.year || (doc.title && doc.title.year) || new Date().getFullYear();
  const form = readStatusForm(xml, year);
  const members = doc.members || [];
  const values = doc.values || {};
  const edits = [];

  const t = titleEdit(xml, doc.title);
  if (t) edits.push(t);

  for (const tbl of form.tables) {
    tbl.nameCells.forEach((c, i) => {
      const name = members[i] || "";
      edits.push({ start: c.start, end: c.end, xml: setCellText(xml.slice(c.start, c.end), name) });
    });

    for (const w of tbl.weeks) {
      const v = values[w.key];
      if (!v) continue;
      if (w.taskOk) w.task.forEach((g, i) => {
        const mv = v[members[i]];
        if (!mv) return;
        edits.push(flagEdit(xml, g[0], mv.life), qtEdit(xml, g[1], mv.qt), flagEdit(xml, g[2], mv.read));
      });
      if (w.attendOk) {
        w.attend.forEach((g, i) => {
          const mv = v[members[i]];
          if (!mv) return;
          // g[0] = '출' — 강의 출석은 자동으로 알 수 없어 그대로 둡니다.
          edits.push(flagEdit(xml, g[1], mv.fri), flagEdit(xml, g[2], mv.sun));
        });
      }
    }
  }

  return applyEdits(xml, edits.filter(Boolean));
}

/** 미리보기 텍스트(Preview/PrvText.txt). 한글이 다시 저장하면 알아서 갱신합니다. */
export function statusPreviewText(doc) {
  const head = (doc.title && doc.title.text) || "출석과 과제현황";
  return `${head}\n${(doc.members || []).join(" ")}\n`;
}
