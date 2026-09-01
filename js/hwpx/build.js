// 빈 양식을 읽어 취합 데이터를 채운 .hwpx 를 만듭니다.
import { openHwpx, packHwpx, loadJSZip } from "./zip.js";
import { compileSection, previewText } from "./compile.js";

export const TEMPLATE_URL = "./assets/templates/과제취합-빈양식.hwpx";

const SECTION = "Contents/section0.xml";
const PREVIEW = "Preview/PrvText.txt";

let templateBytes = null;

/** 양식 파일을 한 번만 받아 캐시합니다. */
export async function fetchTemplate(url = TEMPLATE_URL) {
  if (templateBytes) return templateBytes;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`양식 파일을 불러오지 못했습니다 (${res.status})`);
  templateBytes = new Uint8Array(await res.arrayBuffer());
  return templateBytes;
}

/**
 * 양식 바이트 + 취합 데이터 → .hwpx 바이트.
 * 양식의 엔트리를 하나도 빠뜨리지 않고, section0.xml 과 미리보기 텍스트만 갈아끼웁니다.
 */
export async function buildHwpx(JSZip, bytes, doc, { type = "blob" } = {}) {
  const src = await openHwpx(JSZip, bytes);
  if (!src.has(SECTION)) throw new Error(`양식에 ${SECTION} 이 없습니다`);

  const section = compileSection(await src.readText(SECTION), doc);

  // 양식의 엔트리 순서를 그대로 지킵니다(한글이 쓴 파일과 같은 배열이 되도록).
  const entries = {};
  for (const name of src.names) {
    if (name === SECTION) entries[name] = section;
    else if (name === PREVIEW) entries[name] = previewText(doc);
    else entries[name] = await src.read(name);
  }

  return packHwpx(JSZip, entries, { type });
}

/** 브라우저용: 양식을 받아 문서를 만들고 Blob 으로 돌려줍니다. */
export async function buildHwpxBlob(doc, { url = TEMPLATE_URL } = {}) {
  const [JSZip, bytes] = await Promise.all([loadJSZip(), fetchTemplate(url)]);
  return buildHwpx(JSZip, bytes, doc, { type: "blob" });
}

/** 파일명에 쓸 수 없는 문자를 정리합니다. */
export function safeFileName(name) {
  return String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

/** 브라우저에서 Blob 을 내려받습니다. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
