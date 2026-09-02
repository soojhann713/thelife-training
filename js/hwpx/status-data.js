// 출석·과제현황표에 채울 값 집계 — 순수 함수만 둡니다(DOM·Firebase 없음).
//
// 양식은 '주차(강의일)' 로 줄이 나뉘어 있고, 우리 과제는 '마감일(due)' 을 갖고 있습니다.
// 설교간증 제출일이 곧 예배 다음 주일이라(assignments.js 참고) **마감일 = 그 주차의 강의일**이 되어,
// 양식의 줄과 과제를 마감일로 맞출 수 있습니다.
//
//   생    = 그 마감일의 생활간증·기타 과제 (있는 것 전부 완료해야 완료)
//   독    = 그 마감일의 독서 과제
//   금/주 = 그 제출일의 금요·주일 설교간증
//   큐티  = 강의일까지 7일간(강의일 -6 ~ 강의일) 서로 다른 큐티 완주일 수
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

/**
 * 반 하나의 현황값을 만듭니다.
 *
 * names  : 멤버 이름 배열(양식의 열 순서)
 * tasks  : 그 반의 과제 배열(마감일 오버레이가 적용된 값)
 * today  : "YYYY-MM-DD" — 이 날짜 이후 주차는 비워 둡니다
 * isDone : (name, taskId) => boolean
 * qtDays : (name) => Set<"YYYY-MM-DD">  큐티 완주일 집합
 */
export function statusValues({ names, tasks, today, isDone, qtDays }) {
  const dues = tasks.map((t) => t.due).filter(Boolean).sort();
  const start = dues[0] || today;
  const end = dues[dues.length - 1] || today;

  const sermons = tasks.filter(isSermonTask).map((t) => ({ ...t, ...sermonFields(t) }));
  const inGroup = (re) => tasks.filter((t) => re.test(t.group || ""));
  const preTasks = inGroup(/개강/);
  const vacTasks = inGroup(/방학/);
  const special = new Set([...preTasks, ...vacTasks].map((t) => t.id));

  const qt = new Map(names.map((n) => [n, qtDays(n)]));
  const qtCount = (name, toISO) => {
    const set = qt.get(name);
    if (!set) return 0;
    let n = 0;
    for (let i = 0; i < 7; i++) if (set.has(isoAdd(toISO, -i))) n++;
    return n;
  };

  const values = {};
  const groupRow = (key, group) => {
    const read = group.filter((t) => t.kind === "독서");
    const other = group.filter((t) => t.kind !== "독서");
    values[key] = {};
    for (const name of names) {
      values[key][name] = { life: allDone(name, other, isDone), read: allDone(name, read, isDone) };
    }
  };
  if (preTasks.length) groupRow("개강과제", preTasks);
  if (vacTasks.length) groupRow("방학과제", vacTasks);

  // 마감일이 있는 모든 날짜 + 개강~종강 사이 모든 주일. 양식이 가진 줄만 실제로 쓰입니다.
  const keys = new Set(dues);
  for (let d = start; d <= end; d = isoAdd(d, 1)) if (isSunday(d)) keys.add(d);

  for (const key of [...keys].sort()) {
    if (key > today) continue; // 아직 오지 않은 주차
    const due = tasks.filter((t) => t.due === key && !special.has(t.id) && !isSermonTask(t));
    const life = due.filter((t) => t.kind === "생활간증" || t.kind === "기타");
    const read = due.filter((t) => t.kind === "독서");
    const fri = sermons.filter((t) => t.due === key && t.service === "금요");
    const sun = sermons.filter((t) => t.due === key && t.service === "주일");
    values[key] = {};
    for (const name of names) {
      values[key][name] = {
        life: allDone(name, life, isDone),
        read: allDone(name, read, isDone),
        fri: allDone(name, fri, isDone),
        sun: allDone(name, sun, isDone),
        qt: qtCount(name, key),
      };
    }
  }

  return { values, start, end, year: +start.slice(0, 4) };
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
