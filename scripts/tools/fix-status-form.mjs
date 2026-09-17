// 출석·과제현황 빈 양식의 어긋난 셀 병합을 바로잡습니다.
//
//   node scripts/tools/fix-status-form.mjs [입력.hwpx] [출력.hwpx]
//   (기본값: assets/templates/출석과제현황-빈양식.hwpx 를 제자리에서 고칩니다)
//
// 무엇이 잘못돼 있었나:
//   교회 원본의 6/7·6/14 주차만 `생` 칸이 rowSpan=2 로 아래 출석 행까지 먹고 있습니다.
//   그래서 출석 행의 칸이 한 칸씩 밀리고 13명 × 3칸(=39)이 아니라 26칸만 남습니다.
//   → 그 두 주차는 금/주를 자동으로 채울 수 없었습니다(남의 칸에 쓰게 되니 일부러 비웠음).
//
// 어떻게 고치나:
//   1) 과제 행의 `생` 칸을 rowSpan=1 로 되돌리고 높이를 정상 주차와 같게 맞춥니다.
//   2) 출석 행을 **같은 표의 정상 출석 행 구조 그대로 복제**해 갈아끼웁니다
//      (cellAddr 의 rowAddr 만 그 행 번호로 바꿉니다).
//
// 복제해도 잃는 정보가 없는 이유: 고칠 두 주차의 칸은 글자모양이 전부 20(미완료)이라
// 취소선(32, '그 주엔 이 과제 없음') 표시가 하나도 없습니다. 값이 아니라 빈 칸의 틀만 옮깁니다.
// (다른 주차의 32 표시는 이 도구가 건드리지 않습니다 — 애초에 그 행들은 고칠 대상이 아닙니다.)
import JSZip from "jszip";
import { readFile, writeFile } from "node:fs/promises";
import { findElements, tableCells, applyEdits } from "../../js/hwpx/owpml.js";
import { readStatusForm } from "../../js/hwpx/status.js";

const SECTION = "Contents/section0.xml";
const DEFAULT_FILE = "assets/templates/출석과제현황-빈양식.hwpx";

const norm = (s) => String(s ?? "").replace(/\s+/g, "");
const TASK_LABEL = "생";
const ATTEND_LABELS = new Set(["출", "MT"]);

const hasLabel = (cells, pick) => cells.some((c) => pick(norm(c.text)));
const isTaskRow = (cells) => hasLabel(cells, (t) => t === TASK_LABEL);
const isAttendRow = (cells) => hasLabel(cells, (t) => ATTEND_LABELS.has(t));

const rowAddrOf = (xml, cells) => {
  for (const c of cells) {
    const m = xml.slice(c.start, c.end).match(/<hp:cellAddr[^>]*rowAddr="(\d+)"/);
    if (m) return m[1];
  }
  return null;
};

/** 셀 하나를 rowSpan=1 로 되돌리고 높이를 한 줄 높이로 맞춥니다. */
function unmergeCell(tc, height) {
  return tc
    .replace(/(<hp:cellSpan[^>]*rowSpan=")\d+(")/, `$1${1}$2`)
    .replace(/(<hp:cellSz[^>]*height=")\d+(")/, `$1${height}$2`);
}

/** 정상 출석 행의 속을 그대로 쓰되 rowAddr 만 이 행 번호로 바꿉니다. */
function cloneAttendRow(healthyInner, rowAddr) {
  return healthyInner.replace(/(<hp:cellAddr[^>]*rowAddr=")\d+(")/g, `$1${rowAddr}$2`);
}

const innerOf = (xml, el) => {
  const open = xml.indexOf(">", el.start) + 1;
  const close = xml.lastIndexOf("<", el.end - 1);
  return { start: open, end: close, text: xml.slice(open, close) };
};

export function repairSection(xml) {
  const edits = [];
  const fixed = [];

  for (const tbl of findElements(xml, "hp:tbl")) {
    const rows = findElements(xml, "hp:tr", tbl.start, tbl.end)
      .map((r) => ({ ...r, cells: tableCells(xml, r.start, r.end) }));

    // 이 표에서 가장 흔한 출석 행 칸 수 = 정상. 그 모양의 첫 행을 본으로 씁니다.
    const attendRows = rows.filter((r) => isAttendRow(r.cells));
    if (!attendRows.length) continue;
    const tally = new Map();
    for (const r of attendRows) tally.set(r.cells.length, (tally.get(r.cells.length) || 0) + 1);
    const normalCount = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const healthy = attendRows.find((r) => r.cells.length === normalCount);
    if (!healthy) continue;
    const healthyInner = innerOf(xml, healthy).text;

    // 정상 과제 행의 '생' 칸 높이 = 한 줄 높이.
    let lineHeight = null;
    for (const r of rows) {
      if (!isTaskRow(r.cells)) continue;
      const cell = r.cells.find((c) => norm(c.text) === TASK_LABEL && c.rowSpan === 1);
      const m = cell && xml.slice(cell.start, cell.end).match(/<hp:cellSz[^>]*height="(\d+)"/);
      if (m) { lineHeight = m[1]; break; }
    }
    if (!lineHeight) continue;

    rows.forEach((row, i) => {
      if (!isTaskRow(row.cells)) return;
      const merged = row.cells.filter((c) => norm(c.text) === TASK_LABEL && c.rowSpan === 2);
      if (!merged.length) return;
      const next = rows[i + 1];
      if (!next || !isAttendRow(next.cells)) return;
      if (next.cells.length === normalCount) return; // 이미 정상

      for (const c of merged) {
        edits.push({ start: c.start, end: c.end, xml: unmergeCell(xml.slice(c.start, c.end), lineHeight) });
      }
      const rowAddr = rowAddrOf(xml, next.cells);
      const slot = innerOf(xml, next);
      edits.push({ start: slot.start, end: slot.end, xml: cloneAttendRow(healthyInner, rowAddr) });

      // 주차 날짜 칸 = 첫 '생' 라벨 바로 앞 셀 (status.js 의 prefixLabel 과 같은 규칙).
      const head = row.cells.find((c) => norm(c.text) === TASK_LABEL);
      const before = row.cells.filter((c) => c.start < head.start);
      const date = before.length ? norm(before[before.length - 1].text) : "";
      fixed.push(`${date || `행 ${i}`} 주차 (${next.cells.length}칸 → ${normalCount}칸, 병합 ${merged.length}개 해제)`);
    });
  }

  return { xml: applyEdits(xml, edits), fixed };
}

async function main() {
  const [src = DEFAULT_FILE, dst = src] = process.argv.slice(2);

  const zip = await JSZip.loadAsync(await readFile(src));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  if (!names.includes(SECTION)) throw new Error(`${SECTION} 이 없습니다 — .hwpx 가 맞나요?`);

  const before = await zip.file(SECTION).async("string");
  const { xml: section, fixed } = repairSection(before);

  if (!fixed.length) {
    console.log("고칠 행이 없습니다 — 이미 모든 주차가 같은 6칸 양식입니다.");
    return;
  }

  // make-status-template.mjs 와 같은 규칙으로 다시 묶습니다(폴더 엔트리 없음·시각 고정).
  const out = new JSZip();
  const opt = { createFolders: false, date: new Date(Date.UTC(1980, 0, 1)), compression: "DEFLATE" };
  for (const name of names) {
    const extra = name === "mimetype" ? { compression: "STORE" } : {};
    const data = name === SECTION ? section : await zip.file(name).async("uint8array");
    out.file(name, data, { ...opt, ...extra });
  }
  await writeFile(dst, await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

  const form = readStatusForm(section, 2000);
  console.log(`${dst} 를 고쳤습니다.`);
  for (const f of fixed) console.log(`  ✔ ${f}`);
  console.log(`  멤버 열 ${form.slots}개 · 주차 ${form.keys.length}개`);
  console.log(form.warnings.length
    ? `  ⚠️ 아직 자동으로 채우지 않는 행: ${form.warnings.join(" · ")}`
    : "  모든 주차가 자동으로 채워집니다.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
