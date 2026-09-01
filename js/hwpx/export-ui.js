// 과제 취합문서 내보내기 모달.
// 데이터는 대시보드가 `ctx` 로 넘겨줍니다(여기서 Firebase 를 직접 읽지 않습니다).
import { buildHwpxBlob, downloadBlob, safeFileName } from "./build.js";

// 과제 종류 → 양식 문서 제목 문구 (원본 양식 표기를 그대로 재현).
const DOC_TITLE = {
  설교간증: "설 교 간 증",
  생활간증: "생 활 간 증",
  독서: "독 서 과 제",
};
const DEFAULT_DOC_TITLE = "과     제";

/** 반 이름에서 기수를 뽑습니다. 예) "제자반 11기 (주일반)" → "11기" */
export function cohortOf(label) {
  const m = String(label ?? "").match(/(\d+)\s*기/);
  return m ? `${m[1]}기` : String(label ?? "").trim();
}

/** 양식 첫 칸에 들어갈 문서 제목. 예) "생 활 간 증(11기 제자 훈련반)" */
export function docTitleFor(kind, cohort) {
  return `${DOC_TITLE[kind] || DEFAULT_DOC_TITLE}(${cohort} 제자 훈련반)`;
}

/** 내려받을 파일명. 예) "11기_생활간증_20260503.hwpx" */
export function fileNameFor(cohort, kind, dueISO) {
  const day = String(dueISO ?? "").replace(/-/g, "");
  return `${safeFileName(`${cohort}_${kind}_${day}`)}.hwpx`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

let ctx = null;
let modal = null;

function el(id) { return document.getElementById(id); }

/** 대시보드에서 한 번 호출해 버튼과 모달을 연결합니다. */
export function initExport(context) {
  ctx = context;
  modal = el("export-modal");
  if (!modal) return;

  el("export-open")?.addEventListener("click", openModal);
  el("export-modal-close")?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  el("export-class")?.addEventListener("change", fillTasks);
  el("export-task")?.addEventListener("change", preview);
  el("export-run")?.addEventListener("click", run);
}

function openModal() {
  const sel = el("export-class");
  const classes = ctx.listClasses();
  sel.innerHTML = classes.length
    ? classes.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")
    : `<option value="">내보낼 수 있는 반이 없습니다</option>`;
  fillTasks();
  modal.hidden = false;
}

function closeModal() { modal.hidden = true; }

function fillTasks() {
  const classId = el("export-class").value;
  const tasks = classId ? ctx.listTasks(classId) : [];
  el("export-task").innerHTML = tasks.length
    ? tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.kind)} · ${esc(t.title)}${t.due ? ` (~${esc(t.due.slice(5))})` : ""}</option>`).join("")
    : `<option value="">과제가 없습니다</option>`;
  preview();
}

// 선택한 과제로 무엇이 나갈지 먼저 보여줍니다 — 자동 매칭이 틀렸을 때 여기서 걸러집니다.
function preview() {
  const box = el("export-preview");
  const btn = el("export-run");
  const classId = el("export-class").value;
  const taskId = el("export-task").value;
  if (!classId || !taskId) {
    box.innerHTML = `<p class="muted">반과 과제를 선택하세요.</p>`;
    btn.disabled = true;
    return;
  }
  let doc;
  try {
    doc = ctx.buildDoc(classId, taskId);
  } catch (e) {
    box.innerHTML = `<p class="export-warn">${esc(e.message)}</p>`;
    btn.disabled = true;
    return;
  }
  const done = doc.rows.filter((r) => r.본문 && r.본문.length);
  const noBody = doc.rows.filter((r) => r.제목 && !(r.본문 && r.본문.length));
  const rows = doc.rows.map((r) => {
    const state = (r.본문 && r.본문.length) ? "제출"
      : r.제목 ? "본문 없음" : "미제출";
    const cls = state === "제출" ? "ok" : state === "본문 없음" ? "partial" : "miss";
    return `<tr><td>${esc(r.이름)}</td><td class="export-${cls}">${state}</td><td>${esc(r.제목 || "")}</td></tr>`;
  }).join("");

  box.innerHTML = `
    <p class="export-meta">${esc(doc.문서제목)} · 제출일 ${esc(doc.제출일 || "미정")}
      · <strong>${done.length}</strong> / ${doc.rows.length} 명 제출</p>
    ${noBody.length ? `<p class="export-warn">본문이 비어 있는 제출 ${noBody.length}건 —
      과거 글이면 <code>backfill-content</code> 워크플로우를 먼저 돌리세요.</p>` : ""}
    <table class="export-table"><thead><tr><th>성함</th><th>상태</th><th>매칭된 제목</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  btn.disabled = false;
}

async function run() {
  const btn = el("export-run");
  const box = el("export-status");
  const classId = el("export-class").value;
  const taskId = el("export-task").value;
  btn.disabled = true;
  box.textContent = "문서를 만드는 중…";
  try {
    const doc = ctx.buildDoc(classId, taskId);
    const blob = await buildHwpxBlob(doc);
    downloadBlob(blob, doc.파일명);
    box.textContent = `내려받았습니다 — ${doc.파일명}`;
  } catch (e) {
    box.textContent = `실패: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}
