// 설교간증(예배은혜나눔) 매칭 단위테스트.
// 핵심 규칙: **제목에 적힌 날짜가 예배일의 기준**이다. 늦게 올려도 제목 날짜대로 붙어야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sermonItems,
  sermonDateFromTitle,
  hasTitleDate,
  matchSermonPosts,
} from "../../js/assignments.js";

// 2026-09 은 금요 4·11·18·25 / 주일 6·13·20·27
const TASKS = sermonItems("m", "2026-03-08", "2026-11-22");
const sep = TASKS.filter((t) => t.serviceDate.startsWith("2026-09"));

/* ---------- 제목 날짜 파서 ---------- */
const dateCases = [
  ["[예배은혜나눔] 0904 금요예배 은혜나눔", "2026-09-04"],
  ["[예배은혜나눔] 0906 주일예배 은혜나눔", "2026-09-06"],   // '주' 를 단위로 오해하면 안 됨
  ["[예배은혜나눔] 0906주일예배", "2026-09-06"],
  ["[예배은혜나눔] 260904 금요예배", "2026-09-04"],
  ["[예배은혜나눔] 20260904 금요예배", "2026-09-04"],
  ["[예배은혜나눔] 9월 4일 금요예배", "2026-09-04"],
  ["[예배은혜나눔] 9.4 금요예배", "2026-09-04"],
  ["[예배은혜나눔] 09/04 금요예배", "2026-09-04"],
  ["[예배은혜나눔] 2026.09.04 금요예배", "2026-09-04"],
  ["[예배은혜나눔] 금요예배 은혜나눔", ""],            // 날짜 없음
  ["[예배은혜나눔] 9월 첫째주 금요예배", ""],          // 날짜 아님
  ["[예배은혜나눔] 민수기 20장 1-10절 은혜나눔", ""],  // 성경 구절은 날짜가 아님
  ["[예배은혜나눔] 2026년 금요예배 은혜나눔", ""],     // 20월은 없음
];
for (const [title, expected] of dateCases) {
  test(`sermonDateFromTitle: ${JSON.stringify(title)}`, () => {
    assert.equal(sermonDateFromTitle(title, "2026"), expected);
    assert.equal(hasTitleDate(title), expected !== "");
  });
}

/* ---------- 매칭 ---------- */
const matched = (posts) => matchSermonPosts(sep, posts);

test("늦게 올려도 제목 날짜대로 붙는다 (0904 글을 9/11 에 올림)", () => {
  const post = { title: "[예배은혜나눔] 0904 금요예배 은혜나눔", postDate: "2026.09.11" };
  assert.deepEqual(matched([post]), { "msermon-0904": post });
});

test("제 날짜에 올린 글도 그대로 붙는다", () => {
  const post = { title: "[예배은혜나눔] 0911 금요예배 은혜나눔", postDate: "2026.09.11" };
  assert.deepEqual(matched([post]), { "msermon-0911": post });
});

test("밀린 글을 한꺼번에 올려도 각자 제 예배에 붙는다", () => {
  const a = { title: "[예배은혜나눔] 0904 금요예배", postDate: "2026.09.13" };
  const b = { title: "[예배은혜나눔] 0906 주일예배", postDate: "2026.09.13" };
  const c = { title: "[예배은혜나눔] 0911 금요예배", postDate: "2026.09.13" };
  assert.deepEqual(matched([a, b, c]), {
    "msermon-0904": a, "msermon-0906": b, "msermon-0911": c,
  });
});

test("제목 날짜에 해당하는 예배가 없으면 아무 데도 붙지 않는다", () => {
  // 9/2(수)는 설교간증 과제가 없음 — 게시일로 9/4 나 9/6 에 끌어오면 안 된다.
  const post = { title: "[예배은혜나눔] 0902 수요예배", postDate: "2026.09.04" };
  assert.deepEqual(matched([post]), {});
});

test("제목에 날짜가 없으면 예전처럼 게시일 구간으로 붙는다", () => {
  const post = { title: "[예배은혜나눔] 금요예배 은혜나눔", postDate: "2026.09.11" };
  assert.deepEqual(matched([post]), { "msermon-0911": post });
});

test("제목에 날짜가 없어도 다른 예배(금요↔주일)로는 붙지 않는다", () => {
  // 9/13(주일) 제출일 안이지만 '금요' 글이라 주일예배 과제로 가면 안 된다.
  const post = { title: "[예배은혜나눔] 금요예배 은혜나눔", postDate: "2026.09.13" };
  assert.deepEqual(matched([post]), { "msermon-0911": post });
});

test("한 글이 두 과제에 중복으로 붙지 않는다", () => {
  const a = { title: "[예배은혜나눔] 0904 금요예배", postDate: "2026.09.05" };
  const b = { title: "[예배은혜나눔] 0904 금요예배 (재업로드)", postDate: "2026.09.06" };
  const res = matched([a, b]);
  assert.deepEqual(Object.keys(res), ["msermon-0904"]);
  assert.equal(res["msermon-0904"], a); // 먼저 올린 글
});

test("RTDB 과제(serviceDate 없음)도 id 에서 예배일을 되살려 매칭한다", () => {
  const rtdbTasks = sep.map(({ id, kind, title, due }) => ({ id, kind, title, due }));
  const post = { title: "[예배은혜나눔] 0904 금요예배", postDate: "2026.09.11" };
  assert.deepEqual(matchSermonPosts(rtdbTasks, [post]), { "msermon-0904": post });
});
