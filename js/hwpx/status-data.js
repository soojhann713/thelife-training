// 출석·과제현황표에 채울 값 집계 — 순수 함수만 둡니다(DOM·Firebase 없음).
//
// 양식은 '주차(강의일)' 로 줄이 나뉘어 있고, 우리 과제는 '마감일(due)' 을 갖고 있습니다.
//
// **한 줄 = 그 강의일에 내준 과제.** (= 마감일 직전 강의일 줄에 붙습니다)
// 이 커리큘럼은 '마감 = 다음 강의일' 이라, 1주차(3/8 강의) 과제는 3/15 에 걷지만
// **3/8 줄**에 체크합니다. 그래야 양식의 주차 번호와 커리큘럼 주차가 맞습니다.
//   예) 2학기 #16 = 9/6 = 16주, #22 = 10/18 = 22주, #26 = 11/15 = 26주
// 강의일 목록은 양식에서 읽어(weekKeys) 그대로 씁니다. 못 읽으면 마감일+주일로 추정합니다.
//
//   생    = 그 줄에 묶인 생활간증·기타 과제 (있는 것 전부 완료해야 완료)
//   독    = 그 줄에 묶인 독서 과제
//   금/주 = 그 줄에 묶인 금요·주일 설교간증 (그 주의 주일·금요 예배)
//   큐티  = 그 강의일부터 다음 강의일 전날까지 서로 다른 큐티 완주일 수 (같은 줄 = 같은 한 주)
//   출    = 자동으로 알 수 없어 아예 값을 만들지 않습니다(관리자가 한글에서 직접 체크)
//
// '개강과제'·'방학과제' 줄은 날짜가 없어 커리큘럼의 그룹 이름(개강/방학)으로 맞춥니다.
// 아직 오지 않은 주차는 값을 만들지 않습니다 → 양식이 그대로 남습니다.
import { isSermonTask, sermonFields } from "../assignments.js";

const DAY_MS = 86400000;

export function isoAdd(isoStr, n) {
  const d = new Date(`${isoStr}T00:00:00Z`);
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

const isSunday = (isoStr) => new Date(`${isoStr}T00:00:00Z`).getUTCDay() === 0;

// 과제가 없으면 undefined — 컴파일러가 그 칸을 건드리지 않게 하려는 뜻입니다("모름" ≠ "미완료").
function allDone(name, tasks, isDone) {
  return tasks.length ? tasks.every((t) => isDone(name, t.id)) : undefined;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * 한 줄이 품는 기간(일). 강의일 간격의 **최빈값**을 씁니다 — 주간 과정이면 7, 격주면 14.
 *
 * 평균·중앙값이 아니라 최빈값인 이유: 방학처럼 한 번 크게 벌어지는 간격이 있으면
 * 평균은 물론 중앙값도(강의일이 적을 때) 그쪽으로 끌려갑니다. 가장 자주 나오는 간격이
 * 그 과정의 '한 주' 입니다. 같은 횟수면 짧은 쪽 — 넓게 잡아 남의 주차를 먹는 것보다 낫습니다.
 */
function lectureSpan(lectures) {
  const tally = new Map();
  for (let i = 1; i < lectures.length; i++) {
    const gap = daysBetween(lectures[i - 1], lectures[i]);
    if (gap > 0) tally.set(gap, (tally.get(gap) || 0) + 1);
  }
  if (!tally.size) return 7;
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/**
 * 양식이 가진 강의일 목록. 못 읽었으면 마감일 + 그 사이 모든 주일로 추정합니다.
 * (추정은 예전 동작을 유지하기 위한 폴백입니다 — 양식을 읽을 수 있으면 언제나 그쪽이 정확합니다.)
 */
function lectureDays(weekKeys, dues, start, end) {
  const fromForm = (weekKeys || []).filter((k) => ISO_RE.test(k));
  if (fromForm.length) return [...new Set(fromForm)].sort();
  const keys = new Set(dues);
  for (let d = start; d <= end; d = isoAdd(d, 1)) if (isSunday(d)) keys.add(d);
  return [...keys].sort();
}

/**
 * 어느 과제가 어느 줄에 들어가는지만 계산합니다(누가 했는지는 보지 않습니다).
 *
 * 내보내기와 점검용 목록(scripts/tools/status-week-list.mjs)이 **같은 함수**를 써서
 * "목록에는 이렇게 나오는데 문서에는 다르게 찍히는" 일이 생기지 않게 합니다.
 *
 * tasks    : 그 반의 과제 배열(마감일 오버레이가 적용된 값)
 * weekKeys : 양식에서 읽은 주차 키 배열(선택) — 있으면 이 강의일들로 묶습니다
 * today    : "YYYY-MM-DD"(선택) — 기준일. 미래 주차 판별에만 씁니다.
 */
export function statusWeekPlan({ tasks, weekKeys, today }) {
  const all = tasks || [];
  const dues = all.map((t) => t.due).filter(Boolean).sort();
  const base = today || dues[dues.length - 1] || "";
  const start = dues[0] || base;
  const end = dues[dues.length - 1] || base;

  const sermonOf = new Map(all.filter(isSermonTask).map((t) => [t.id, sermonFields(t)]));
  const inGroup = (re) => all.filter((t) => re.test(t.group || ""));
  const preTasks = inGroup(/개강/);
  const vacTasks = inGroup(/방학/);
  const special = new Set([...preTasks, ...vacTasks].map((t) => t.id));

  // 마감일 **직전** 강의일 = 그 과제를 내준 강의일.
  //
  // 다만 **한 주치보다 멀리 떨어진 것은 붙이지 않습니다.** 방학처럼 강의일이 통째로 비는
  // 구간(6/14 → 9/6)의 과제·예배가 전부 6/14 줄로 쏟아져 들어가기 때문입니다.
  // 그런 과제는 양식에 놓일 줄이 없는 것이므로 조용히 합치지 않고 unplaced 로 알립니다.
  const lectures = lectureDays(weekKeys, dues, start, end);
  const span = lectureSpan(lectures);
  const last = lectures[lectures.length - 1];

  const assignedAt = (due) => {
    let prev = null;
    for (const L of lectures) { if (L < due) prev = L; else break; }
    if (prev) return { L: prev, gap: daysBetween(prev, due) };
    // 첫 강의일 전에 마감인 과제(서약서 같은 개강 행정 과제)는 첫 강의일 줄로 보냅니다.
    if (lectures.length) return { L: lectures[0], gap: daysBetween(due, lectures[0]) };
    return null;
  };

  const bucket = new Map(lectures.map((L) => [L, []]));
  const unplaced = [];
  for (const t of all) {
    if (!t.due || special.has(t.id)) continue;
    const at = assignedAt(t.due);
    if (at && at.gap <= span) { bucket.get(at.L).push(t); continue; }
    unplaced.push({ ...t, why: last && t.due > last ? "late" : "gap" });
  }

  const split = (list) => ({
    life: list.filter((t) => !sermonOf.has(t.id) && (t.kind === "생활간증" || t.kind === "기타")),
    read: list.filter((t) => !sermonOf.has(t.id) && t.kind === "독서"),
    fri: list.filter((t) => (sermonOf.get(t.id) || {}).service === "금요"),
    sun: list.filter((t) => (sermonOf.get(t.id) || {}).service === "주일"),
  });

  const rows = lectures.map((key) => ({ key, future: !!today && key > today, ...split(bucket.get(key)) }));
  const groups = [];
  if (preTasks.length) groups.push({ key: "개강과제", ...split(preTasks) });
  if (vacTasks.length) groups.push({ key: "방학과제", ...split(vacTasks) });

  return { lectures, rows, groups, unplaced, span, start, end, year: +String(start).slice(0, 4) };
}

/**
 * 반 하나의 현황값을 만듭니다.
 *
 * names    : 멤버 이름 배열(양식의 열 순서)
 * tasks    : 그 반의 과제 배열(마감일 오버레이가 적용된 값)
 * today    : "YYYY-MM-DD" — 이 날짜 이후 주차는 비워 둡니다
 * isDone   : (name, taskId) => boolean
 * qtDays   : (name) => Set<"YYYY-MM-DD">  큐티 완주일 집합
 * weekKeys : 양식에서 읽은 주차 키 배열(선택) — 있으면 이 강의일들로 과제를 묶습니다
 */
export function statusValues({ names, tasks, today, isDone, qtDays, weekKeys }) {
  const plan = statusWeekPlan({ tasks, weekKeys, today });

  // 큐티는 **그 강의일부터 다음 강의일 전날까지** 셉니다 — 같은 줄의 생·독·금·주와 같은 한 주.
  // (다음 강의일 당일은 그 줄 몫이라 빼고, 방학처럼 사이가 벌어진 구간은 한 주치로 자릅니다.)
  const qt = new Map(names.map((n) => [n, qtDays(n)]));
  const qtCount = (name, fromISO, nextISO) => {
    const set = qt.get(name);
    if (!set) return 0;
    let n = 0;
    for (let i = 0; i < plan.span; i++) {
      const day = isoAdd(fromISO, i);
      if (nextISO && day >= nextISO) break;
      if (set.has(day)) n++;
    }
    return n;
  };

  const values = {};
  for (const g of plan.groups) {
    values[g.key] = {};
    for (const name of names) {
      // 개강·방학 줄에는 큐티·예배 칸이 없습니다(양식에 날짜가 없는 줄).
      values[g.key][name] = {
        life: allDone(name, g.life, isDone),
        read: allDone(name, g.read, isDone),
      };
    }
  }

  plan.rows.forEach((row, i) => {
    if (row.future) return; // 아직 오지 않은 주차 — 양식 그대로 둡니다
    const next = plan.lectures[i + 1];
    values[row.key] = {};
    for (const name of names) {
      values[row.key][name] = {
        life: allDone(name, row.life, isDone),
        read: allDone(name, row.read, isDone),
        fri: allDone(name, row.fri, isDone),
        sun: allDone(name, row.sun, isDone),
        qt: qtCount(name, row.key, next),
      };
    }
  });

  return { values, start: plan.start, end: plan.end, year: plan.year };
}

/** 반 이름에서 제목에 넣을 조각을 뽑습니다. 예) "제자반 11기 (주일반)" → 11기·제자·주일 */
export function titleParts(label, year, start) {
  const s = String(label ?? "");
  const cohort = (s.match(/(\d+)\s*기/) || [])[1] || "";
  const course = (s.match(/(여성제자|제자|사역)/) || [])[1] || "";
  const day = (s.match(/(주일|토요|평일|금요)/) || [])[1] || "";
  return {
    year, cohort, course, day, start,
    text: `${year}년 제${cohort}기 ${course}반${day ? `(${day})` : ""} 출석과 과제현황`,
  };
}
