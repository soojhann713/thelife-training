// 교회에서 받은 '출석과 과제현황' .hwpx 에서 **내용을 비운 빈 양식**을 만듭니다.
// 원본에는 실제 목원 이름과 체크 기록이 들어 있어 저장소에 넣을 수 없어서, 이 도구로 한 번 걸러
// assets/templates/출석과제현황-빈양식.hwpx 를 만들어 커밋합니다.
//
//   node scripts/tools/make-status-template.mjs <원본.hwpx> [출력.hwpx]
//
// 하는 일
//   - 이름 행: 이름 삭제, 글자모양을 하나로 통일
//   - 주차 칸: 생/큐/독/출/금/주 라벨은 남기고 값(큐티 일수)은 '큐' 로, 글자모양은 미완료(20)로
//   - 취소선(32 = '그 주엔 해당 없음')은 **행 전체가 같을 때만** 남깁니다(양식 정보라서).
//     멤버마다 다르면 개인 기록이므로 미완료로 지웁니다.
//   - 표 구조·서식·주차 날짜·안내 문구는 하나도 건드리지 않습니다.
//   - 미리보기 텍스트는 비우고 미리보기 이미지는 뺍니다. 문서 속성의 작성자·제목도 지웁니다.
//   - 엔트리 이름과 순서는 원본 그대로(mimetype 을 맨 앞 무압축으로).
import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { findElements, tableCells, setCellText, cellCharPr, setCellCharPr, applyEdits } from "../../js/hwpx/owpml.js";
import { readStatusForm, CHAR_MISS, CHAR_NA } from "../../js/hwpx/status.js";

const SECTION = "Contents/section0.xml";
const PREVIEW_TEXT = "Preview/PrvText.txt";
const PREVIEW_IMAGE = "Preview/PrvImage.png";
const HPF = "Contents/content.hpf";

// 같은 위치(0=생/출, 1=값/금, 2=독/주)의 취소선이 모든 멤버에게 똑같이 걸려 있는지.
function uniformNa(xml, groups, slot) {
  if (!groups.length) return false;
  return groups.every((g) => cellCharPr(xml.slice(g[slot].start, g[slot].end)) === CHAR_NA);
}

function blankCell(xml, cell, keepNa, text) {
  const tc = xml.slice(cell.start, cell.end);
  const charPr = keepNa ? CHAR_NA : CHAR_MISS;
  const body = text === null ? tc : setCellText(tc, text);
  return { start: cell.start, end: cell.end, xml: setCellCharPr(body, charPr) };
}

function blankSection(xml) {
  // 연도는 키 계산에만 쓰이고 결과에 남지 않으므로 아무 값이나 괜찮습니다.
  const form = readStatusForm(xml, 2000);
  const edits = [];

  for (const tbl of form.tables) {
    for (const c of tbl.nameCells) {
      edits.push({ start: c.start, end: c.end, xml: setCellCharPr(setCellText(xml.slice(c.start, c.end), ""), 11) });
    }
    for (const w of tbl.weeks) {
      // 묶음에 들지 못한 칸(양식의 병합이 어긋난 구간)도 서식은 미완료로 되돌립니다 — 기록이 남지 않게.
      const grouped = new Set();
      const reset = (cells, groups, texts) => {
        const na = [0, 1, 2].map((s) => uniformNa(xml, groups, s));
        for (const g of groups) {
          g.forEach((c, i) => { grouped.add(c.start); edits.push(blankCell(xml, c, na[i], texts[i])); });
        }
        for (const c of cells) if (!grouped.has(c.start)) edits.push(blankCell(xml, c, false, null));
      };
      // 값 칸은 '큐'로 되돌리고, '출' 칸은 'MT' 처럼 주차 설명이 들어 있을 수 있어 텍스트를 그대로 둡니다.
      reset(w.taskCells.filter((c) => c.start >= w.task[0][0].start), w.task, ["생", "큐", "독"]);
      if (w.attend) reset(w.attendCells.filter((c) => c.start >= w.attend[0][0].start), w.attend, [null, "금", "주"]);
    }
  }
  return applyEdits(xml, edits);
}

function blankHpf(hpf) {
  return hpf
    .replace(/<opf:title>[\s\S]*?<\/opf:title>/, "<opf:title/>")
    .replace(/(<opf:meta name="creator" content="text">)[\s\S]*?(<\/opf:meta>)/, "$1$2")
    .replace(/(<opf:meta name="lastsaveby" content="text">)[\s\S]*?(<\/opf:meta>)/, "$1$2")
    .replace(/(<opf:meta name="date" content="text">)[\s\S]*?(<\/opf:meta>)/, "$1$2");
}

// 개인 기록이 들어갈 수 있는 칸(이름 행 + 주차 칸)에 남은 글자를 알려줍니다 — 커밋 전 마지막 확인용.
// 제목·안내 문구는 양식 자체라서 검사 대상이 아닙니다.
function leftoverText(xml) {
  const form = readStatusForm(xml, 2000);
  const allowed = new Set(["", "생", "독", "큐", "출", "금", "주", "MT"]);
  const out = new Set();
  for (const tbl of form.tables) {
    const cells = [...tbl.nameCells, ...tbl.weeks.flatMap((w) => [
      ...w.taskCells.filter((c) => c.start >= w.task[0][0].start),
      ...(w.attendCells || []).filter((c) => c.start >= w.attend[0][0].start),
    ])];
    for (const c of cells) {
      const t = String(c.text || "").replace(/\s+/g, "");
      if (!allowed.has(t)) out.add(t);
    }
  }
  return [...out];
}

async function main() {
  const [src, dst = "assets/templates/출석과제현황-빈양식.hwpx"] = process.argv.slice(2);
  if (!src) throw new Error("사용법: node scripts/tools/make-status-template.mjs <원본.hwpx> [출력.hwpx]");

  const zip = await JSZip.loadAsync(await readFile(src));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  if (!names.includes(SECTION)) throw new Error(`${SECTION} 이 없습니다 — .hwpx 가 맞나요?`);

  const section = blankSection(await zip.file(SECTION).async("string"));
  const left = leftoverText(section);

  // 폴더 엔트리를 만들지 않고 시각을 고정합니다 — 한글이 쓴 파일과 같은 모양이고, 매번 같은 바이트가 나옵니다.
  const out = new JSZip();
  const opt = { createFolders: false, date: new Date(Date.UTC(1980, 0, 1)), compression: "DEFLATE" };
  const put = (name, data, extra) => out.file(name, data, { ...opt, ...extra });
  for (const name of names) {
    if (name === PREVIEW_IMAGE) continue;
    if (name === SECTION) put(name, section);
    else if (name === PREVIEW_TEXT) put(name, "");
    else if (name === HPF) put(name, blankHpf(await zip.file(name).async("string")));
    else if (name === "mimetype") put(name, await zip.file(name).async("uint8array"), { compression: "STORE" });
    else put(name, await zip.file(name).async("uint8array"));
  }

  const bytes = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(dst, bytes);

  const form = readStatusForm(section, 2000);
  console.log(`${dst} 를 만들었습니다.`);
  console.log(`  멤버 열 ${form.slots}개 · 주차 ${form.keys.length}개: ${form.keys.join(", ")}`);
  console.log(left.length ? `  ⚠️ 값 칸에 남은 글자 확인 필요: ${left.join(", ")}` : "  값 칸은 모두 비었습니다");
  if (form.warnings.length) console.log(`  ⚠️ 자동으로 채우지 않는 행(양식 셀 병합이 어긋남): ${form.warnings.join(" · ")}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
