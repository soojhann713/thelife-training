// OWPML(.hwpx 본문 XML) 조작 — 순수 문자열 함수만 둡니다.
// ⚠️ DOM·Firebase·JSZip 을 import 하지 않습니다. 그래야 Node 테스트가 이 파일을 그대로 import 합니다.
//
// 설계 원칙: XML 을 새로 쓰지 않고 **양식의 노드를 복제해 텍스트만 바꿉니다.**
// 서식(글꼴·문단모양·표 스타일)은 전부 header.xml 과 각 노드의 paraPrIDRef/charPrIDRef 에 있으므로,
// 노드를 복제하면 서식이 원본과 100% 같습니다.

// XML 1.0 이 금지하는 제어문자(탭/개행 제외)와 비문자.
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** XML 텍스트 이스케이프 + 허용되지 않는 제어문자 제거. */
export function escapeXml(s) {
  return String(s ?? "")
    .replace(BAD_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** XML 텍스트 언이스케이프 (셀 텍스트를 읽어 라벨과 비교할 때 사용). */
function unescapeXml(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// 태그 하나를 읽습니다. 속성값 안의 '>' 에 속지 않도록 따옴표를 추적합니다.
function readTag(xml, from) {
  const i = xml.indexOf("<", from);
  if (i < 0) return null;
  let j = i + 1, quote = null;
  while (j < xml.length) {
    const c = xml[j];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") break;
    j++;
  }
  if (j >= xml.length) return null;
  const raw = xml.slice(i, j + 1);
  const name = (raw.match(/^<\/?\s*([A-Za-z0-9_:.-]+)/) || [])[1] || "";
  return { start: i, end: j + 1, name, closing: raw[1] === "/", self: raw.endsWith("/>") };
}

/**
 * `from`~`to` 안에서 **가장 바깥 깊이**의 <tag>…</tag> 범위들을 찾습니다.
 * 셀 안에 중첩된 같은 이름의 태그(hp:p 안의 hp:p 등)는 건너뜁니다.
 */
export function findElements(xml, tag, from = 0, to = xml.length) {
  const out = [];
  let depth = 0, start = -1, pos = from;
  while (pos < to) {
    const t = readTag(xml, pos);
    if (!t || t.start >= to) break;
    pos = t.end;
    if (t.name !== tag) continue;
    if (t.self) { if (depth === 0) out.push({ start: t.start, end: t.end }); continue; }
    if (t.closing) {
      depth--;
      if (depth === 0 && start >= 0) { out.push({ start, end: t.end }); start = -1; }
    } else {
      if (depth === 0) start = t.start;
      depth++;
    }
  }
  return out;
}

/** findElements 결과를 문자열 조각으로. */
export function slice(xml, ranges) {
  return ranges.map((r) => xml.slice(r.start, r.end));
}

/** 표 셀(hp:tc) 하나의 메타 정보. */
export function parseCell(tc) {
  const a = tc.match(/<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"/);
  const s = tc.match(/<hp:cellSpan\s+colSpan="(\d+)"\s+rowSpan="(\d+)"/);
  const texts = [...tc.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)].map((m) => unescapeXml(m[1]));
  return {
    row: a ? +a[2] : -1,
    col: a ? +a[1] : -1,
    colSpan: s ? +s[1] : 1,
    rowSpan: s ? +s[2] : 1,
    text: texts.join(""),
  };
}

/** 한 표(또는 블록) 안의 셀 범위 + 메타를 문서 순서대로. */
export function tableCells(xml, from = 0, to = xml.length) {
  return findElements(xml, "hp:tc", from, to)
    .map((r) => ({ ...r, ...parseCell(xml.slice(r.start, r.end)) }));
}

// 줄배치 캐시. 텍스트를 바꾸면 값이 어긋나므로 제거하고 한글이 다시 계산하게 둡니다.
function stripLineSegs(x) {
  return x.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
}

/**
 * 문단 틀의 **첫 hp:run 내용을 텍스트로 갈아끼웁니다.**
 * run 의 속성(charPrIDRef)은 그대로 두므로 글자 서식이 유지됩니다.
 * 틀에 run 이 여럿이면 첫 개만 남깁니다 — 남겨두면 원본 텍스트가 딸려옵니다.
 */
function setParagraphText(paraXml, text) {
  const runs = findElements(paraXml, "hp:run");
  if (!runs.length) throw new Error("문단에 hp:run 이 없습니다");
  const first = runs[0];
  const openEnd = paraXml.indexOf(">", first.start) + 1;
  const openTag = paraXml.slice(first.start, openEnd);
  const attrs = openTag.replace(/^<hp:run/, "").replace(/\/?>$/, "");

  const before = paraXml.slice(0, first.start);
  // 첫 run 뒤에 남은 run 들은 버립니다.
  let after = paraXml.slice(first.end);
  for (const r of findElements(after, "hp:run").reverse()) {
    after = after.slice(0, r.start) + after.slice(r.end);
  }
  const inner = text ? `<hp:t>${escapeXml(text)}</hp:t>` : "";
  return `${before}<hp:run${attrs}>${inner}</hp:run>${after}`;
}

/**
 * 셀 안의 문단들을 `lines` 로 교체합니다.
 * 셀의 **첫 문단을 틀로 복제**하므로 paraPrIDRef/charPrIDRef 가 그대로 유지됩니다.
 * lines 가 비면 텍스트 없는 문단 하나만 남습니다(양식의 미제출 칸과 같은 모양).
 */
export function setCellParagraphs(tc, lines) {
  const subOpen = tc.indexOf("<hp:subList");
  if (subOpen < 0) throw new Error("hp:subList 가 없는 셀입니다");
  const innerStart = tc.indexOf(">", subOpen) + 1;
  const subEnd = tc.indexOf("</hp:subList>", innerStart);
  if (subEnd < 0) throw new Error("hp:subList 가 닫히지 않았습니다");
  const inner = tc.slice(innerStart, subEnd);

  const ps = findElements(inner, "hp:p");
  if (!ps.length) throw new Error("셀 안에 hp:p 가 없습니다");
  const proto = stripLineSegs(inner.slice(ps[0].start, ps[0].end));

  const list = (lines && lines.length) ? lines : [""];
  const built = list.map((line) => setParagraphText(proto, line)).join("");

  return tc.slice(0, innerStart) + built + tc.slice(subEnd);
}

/** 셀에 한 줄만 넣습니다. */
export function setCellText(tc, text) {
  return setCellParagraphs(tc, text ? [text] : []);
}

/** 셀 안 첫 hp:run 의 글자모양 id (없으면 -1). */
export function cellCharPr(tc) {
  const m = String(tc).match(/<hp:run\s[^>]*?charPrIDRef="(\d+)"/);
  return m ? +m[1] : -1;
}

/**
 * 셀 안 모든 hp:run 의 글자모양 id 를 바꿉니다.
 * 출석·과제현황표는 완료/미완료를 **글자모양(색·굵기)으로만** 나타내서, 이 함수가 곧 체크 표시입니다.
 */
export function setCellCharPr(tc, id) {
  return String(tc).replace(/(<hp:run\s[^>]*?charPrIDRef=")\d+(")/g, `$1${id}$2`);
}

/** 원본 XML 의 여러 구간을 한꺼번에 갈아끼웁니다(뒤에서부터 잘라 붙여 위치가 밀리지 않게). */
export function applyEdits(xml, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = xml;
  for (const e of sorted) out = out.slice(0, e.start) + e.xml + out.slice(e.end);
  return out;
}

/**
 * 라벨 셀을 앵커로 삼아 **그 다음 셀**의 인덱스를 돌려줍니다.
 * 못 찾으면 던집니다 — 조용히 엉뚱한 칸에 쓰는 것보다 낫습니다.
 */
export function valueCellAfterLabel(cells, label) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, "");
  const i = cells.findIndex((c) => norm(c.text) === norm(label));
  if (i < 0) throw new Error(`양식에서 '${label}' 라벨 셀을 찾지 못했습니다`);
  if (i + 1 >= cells.length) throw new Error(`'${label}' 라벨 다음에 값 셀이 없습니다`);
  return i + 1;
}

/** 본문 셀(colSpan 이 가장 큰 셀)의 인덱스. */
export function bodyCellIndex(cells) {
  let best = -1, span = 1;
  cells.forEach((c, i) => { if (c.colSpan > span) { span = c.colSpan; best = i; } });
  if (best < 0) throw new Error("양식에서 본문 셀(colSpan>1)을 찾지 못했습니다");
  return best;
}

/** 표의 고유 id 재발급 — 블록을 복제하면 id 가 중복되므로. */
export function reassignTableId(block, id) {
  return block.replace(/(<hp:tbl\s[^>]*?\bid=")\d+(")/, `$1${id}$2`);
}

/** 문단 블록의 pageBreak 설정 (멤버마다 페이지를 나누기 위해). */
export function setPageBreak(block, on) {
  return block.replace(/(<hp:p\s[^>]*?\bpageBreak=")[01](")/, `$1${on ? 1 : 0}$2`);
}

/** 여러 셀을 인덱스 기준으로 한꺼번에 치환합니다(뒤에서부터 잘라 붙여 위치가 밀리지 않게). */
export function replaceCells(block, cells, edits) {
  const sorted = [...edits].sort((a, b) => cells[b.index].start - cells[a.index].start);
  let out = block;
  for (const e of sorted) {
    const c = cells[e.index];
    out = out.slice(0, c.start) + e.xml + out.slice(c.end);
  }
  return out;
}

/** section XML 을 머리/본문/꼬리로 가릅니다. */
export function splitSection(xml) {
  const i = xml.indexOf("<hs:sec");
  if (i < 0) throw new Error("hs:sec 를 찾지 못했습니다 — HWPX 본문이 아닙니다");
  const openEnd = xml.indexOf(">", i) + 1;
  const close = xml.lastIndexOf("</hs:sec>");
  if (close < 0) throw new Error("hs:sec 가 닫히지 않았습니다");
  return { head: xml.slice(0, openEnd), body: xml.slice(openEnd, close), tail: xml.slice(close) };
}
