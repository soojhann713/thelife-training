// 취합 데이터 → 채워진 section0.xml.
// ⚠️ owpml.js 와 마찬가지로 DOM·Firebase·JSZip 을 import 하지 않는 순수 모듈입니다.
import {
  splitSection, findElements, tableCells, valueCellAfterLabel, bodyCellIndex,
  setCellText, setCellParagraphs, replaceCells, reassignTableId, setPageBreak,
} from "./owpml.js";

// 양식의 라벨(앵커). 양식에서 이 문구가 바뀌면 내보내기가 에러로 멈춥니다.
export const LABEL_DUE = "제출일";
export const LABEL_TITLE = "제목";
export const LABEL_NAME = "제출자";

/**
 * 제출일 표기 — 양식 원본의 자릿수 맞춤을 그대로 재현합니다.
 * 예) 2026-05-03 → "2026년   5월  3일", 2026-04-26 → "2026년   4월 26일"
 */
export function formatDueDate(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const pad = (n) => String(+n).padStart(2, " ");
  return `${m[1]}년  ${pad(m[2])}월 ${pad(m[3])}일`;
}

/** 본문 텍스트 → 문단 배열. 빈 줄은 유지하되 3줄 이상 연속은 하나로 줄입니다. */
export function toParagraphs(content) {
  return String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((s) => s.trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n");
}

/**
 * 빈 양식의 section XML 에 취합 데이터를 채웁니다.
 *
 * doc = {
 *   문서제목: "생 활 간 증(11기 제자 훈련반)",
 *   제출일:   "2026-05-03",
 *   rows: [{ 이름, 제목, 본문 }]        // 본문은 문자열 또는 문단 배열, 미제출이면 빈 값
 * }
 */
export function compileSection(templateXml, doc) {
  const { head, body, tail } = splitSection(templateXml);

  const blocks = findElements(body, "hp:p");
  if (!blocks.length) throw new Error("양식에서 최상위 문단 블록을 찾지 못했습니다");
  const proto = body.slice(blocks[0].start, blocks[0].end);
  if (!proto.includes("<hp:tbl")) throw new Error("양식의 첫 블록에 표가 없습니다");

  const rows = doc.rows || [];
  if (!rows.length) throw new Error("취합할 멤버가 없습니다");

  const dueText = formatDueDate(doc.제출일);
  const out = rows.map((row, i) => fillBlock(proto, {
    문서제목: doc.문서제목,
    제출일: dueText,
    이름: row.이름,
    제목: row.제목,
    본문: Array.isArray(row.본문) ? row.본문 : toParagraphs(row.본문),
    // 표 id 는 문서 안에서 고유해야 하므로 블록마다 새로 발급합니다.
    tableId: 1000000000 + i,
    pageBreak: i > 0,
  }));

  return head + out.join("") + tail;
}

// 블록(표를 감싼 문단) 하나를 채웁니다.
function fillBlock(proto, v) {
  const cells = tableCells(proto);
  if (!cells.length) throw new Error("양식 블록에서 셀을 찾지 못했습니다");

  const iDue = valueCellAfterLabel(cells, LABEL_DUE);
  const iTitle = valueCellAfterLabel(cells, LABEL_TITLE);
  const iName = valueCellAfterLabel(cells, LABEL_NAME);
  const iBody = bodyCellIndex(cells);
  // 문서 제목은 라벨이 없어 앵커를 못 씁니다 — 표의 첫 셀입니다.
  const iHead = 0;
  for (const [what, idx] of [["제목", iTitle], ["제출자", iName], ["본문", iBody]]) {
    if (idx === iHead) throw new Error(`양식 해석 오류: '${what}' 칸이 문서 제목 칸과 겹칩니다`);
  }

  const cellXml = (i) => proto.slice(cells[i].start, cells[i].end);
  const edits = [
    { index: iHead, xml: setCellText(cellXml(iHead), v.문서제목) },
    { index: iDue, xml: setCellText(cellXml(iDue), v.제출일) },
    { index: iTitle, xml: setCellText(cellXml(iTitle), v.제목) },
    { index: iName, xml: setCellText(cellXml(iName), v.이름) },
    { index: iBody, xml: setCellParagraphs(cellXml(iBody), v.본문) },
  ];

  let block = replaceCells(proto, cells, edits);
  block = reassignTableId(block, v.tableId);
  block = setPageBreak(block, v.pageBreak);
  // 표를 감싼 문단 자체의 줄배치 캐시도 버립니다(표 위치가 밀릴 수 있으므로).
  block = block.replace(
    /(<\/hp:tbl>[\s\S]*?)<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/,
    "$1",
  );
  return block;
}

/** 생성 문서의 평문 (Preview/PrvText.txt 갱신용). */
export function previewText(doc) {
  const lines = [];
  for (const row of doc.rows || []) {
    lines.push(`${doc.문서제목}  제출일 ${formatDueDate(doc.제출일)}`);
    lines.push(`제목 ${row.제목 || ""}  제출자 ${row.이름 || ""}`);
    const body = Array.isArray(row.본문) ? row.본문 : toParagraphs(row.본문);
    lines.push(body.join("\n"));
    lines.push("");
  }
  return lines.join("\n");
}
