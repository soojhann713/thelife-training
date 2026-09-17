import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { findElements, tableCells } from "../js/hwpx/owpml.js";
import { readStatusForm } from "../js/hwpx/status.js";

const zip = await JSZip.loadAsync(await readFile("../assets/templates/출석과제현황-빈양식.hwpx"));
const xml = await zip.file("Contents/section0.xml").async("string");
const norm = (s) => String(s ?? "").replace(/\s+/g, "");
const form = readStatusForm(xml, 2026);
console.log("주차 키:", form.keys.join(", "));
console.log("경고:", form.warnings.length ? form.warnings.join(" · ") : "없음");

// 표별 '주차번호 ↔ 날짜' 대조
findElements(xml, "hp:tbl").forEach((t, ti) => {
  console.log(`\n=== 표 ${ti} (주차번호 → 날짜) ===`);
  const rows = findElements(xml, "hp:tr", t.start, t.end);
  for (const r of rows) {
    const cells = tableCells(xml, r.start, r.end);
    const head = cells.find((c) => norm(c.text) === "생");
    if (!head) continue;
    const before = cells.filter((c) => c.start < head.start).map((c) => norm(c.text));
    console.log(`  ${(before[0] || "·").padStart(3)} → ${before[before.length - 1] || "(빈칸)"}`);
  }
});
