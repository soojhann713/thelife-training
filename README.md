# 교회 소그룹 **큐티(QT) 완주 모니터링** 서비스.

- **웹 대시보드**: 바닐라 HTML/JS + Firebase Authentication, **GitHub Pages** 호스팅
- **자동 수집**: **GitHub Actions** 스케줄 → 게시판 스크래핑 → Firebase RTDB (결과는 대시보드에서 조회)

> 전체 재설계 방향은 [`PLAN.md`](./PLAN.md) 참고.

## 구조

```
index.html / css/style.css        로그인 + 대시보드 화면, 스타일
js/firebase-config.js             Firebase 초기화 (auth, db)
js/auth.js                        훈련 반 선택 + 비밀번호 로그인(Firebase 이메일/비밀번호)
js/config.js                      대시보드 공용 상수/큐티 날짜 파싱·색상
js/assignments.js                 제자반 주별 과제 정의(생활간증·독서·기타)
js/dashboard.js                   대시보드/멤버 탭/멤버 관리/과제 현황 렌더링
js/app.js                         화면 전환 게이트
scripts/                          GitHub Actions 작업 (Node)
  lib/scrape.js                   게시판 스크래핑 / 큐티 날짜 파싱
  lib/firebase.js                 firebase-admin 초기화
  lib/members.js                  멤버 명단 로더(/members, 기본값 폴백)
  collect-daily.js                신규 글 수집(본문 포함)
  collect-history.js              과거 글(올해치) 수집 — 페이지네이션
  backfill-content.js             기존 글 본문 일괄 채움
  seed-members.js / set-admin.js / manage-class.js / seed-course.js / dedupe-posts.js   관리 도구
  test/                           단위 테스트 (큐티 파서)
.github/workflows/
  ci.yml                          PR/푸시 검증(문법·의존성·테스트)
  daily-collect.yml               낮(06~23시) 10분마다 신규 글 수집 → RTDB
  collect-history.yml / backfill-content.yml / admin-tools.yml   수동 도구
```

## 로그인 (훈련 반 + 비밀번호)

인증은 **훈련 반(class) 선택 + 반 비밀번호**(Firebase 이메일/비밀번호)로 합니다. 각 반은
Firebase Auth 계정 하나에 대응하며, 로그인 이메일은 반 id 로부터 자동 생성됩니다
(`<반id>@class.jeja-pepero.app` — 사용자는 이메일을 볼 필요 없이 **반 + 비밀번호**만 입력).

- **반 = 로그인 단위.** 한 커리큘럼(코스)이 여러 반을 가질 수 있습니다
  (예: 사역훈련 → 사역9기/10기/11기).
- 반 목록은 공개 노드 `/classes` 에서 읽어 드롭다운에 채웁니다(**비밀번호는 저장하지 않음** —
  Firebase Auth 가 보관).
- **관리자**는 커스텀 클레임 `admin:true` 를 가진 계정으로, 드롭다운의 "⚙️ 관리자" 로 로그인하며
  **모든 반**을 열람·관리합니다. 일반 반 계정은 **자기 반 데이터만** 화면에 표시됩니다(화면 분리).

`/classes` 구조 (공개 읽기):
```jsonc
{
  "classes": {
    "disciple11": { "label": "제자 11기", "courseId": "disciple11", "active": true },
    "ministry9":  { "label": "사역 9기",  "courseId": "ministry",   "active": true }
  }
}
```

### Firebase 콘솔 설정 (1회)
1. **Authentication → Sign-in method → 이메일/비밀번호 공급자 사용 설정**
2. **Authentication → Settings → 승인된 도메인** 에 배포 도메인 추가 (예: `<id>.github.io`)
3. **Realtime Database 보안 규칙**:
   ```json
   {
     "rules": {
       "classes":     { ".read": true, ".write": "auth.token.admin === true" },
       "courses":     { ".read": "auth != null", ".write": "auth.token.admin === true" },
       "members":     { ".read": "auth != null", ".write": "auth != null" },
       "posts":       { ".read": "auth != null", ".write": false },
       "assignments": { ".read": "auth != null", ".write": "auth != null" },
       "qtManual":    { ".read": "auth != null", ".write": "auth != null" },
       "state":       { ".read": false, ".write": false }
     }
   }
   ```
   - `classes` = 로그인 드롭다운용 반 목록 → **공개 읽기**(라벨만, 비밀번호 없음), 쓰기는 관리자만. 반별 마감일 오버레이(`classes/<반>/due/<과제id>`)도 여기 저장됩니다.
   - `courses` = 커리큘럼(과제 정의) → 로그인 사용자 읽기, **쓰기는 관리자만**(커리큘럼 관리 화면).
   - `members`/`qtManual` 쓰기는 **로그인한 반이 자기 반을 관리**하도록 `auth != null`
     (화면에서 자기 반만 노출하는 "화면 분리" 방식이라, 인증된 반끼리는 DB 레벨에서 완전 격리되진 않음).
   - `posts` 는 서버(수집 스크립트)가 서비스 계정으로만 기록.
   - 예전 `/users` 허용명단은 더 이상 사용하지 않습니다(있어도 무시됨 — 삭제해도 무방).

## 반·멤버 관리

### 반 개설/수정/삭제 (관리자, Actions)
반 계정과 비밀번호는 **Actions → Admin Tools** 에서 관리합니다(웹 로그인 없이 관리자 손으로 1회씩).

- **관리자 계정 개설(최초 1회)**: action `class-admin`, `class_id=admin`, `class_password=<관리자 비번>`
  → 이후 웹에서 "⚙️ 관리자" + 이 비번으로 로그인.
- **반 개설**: action `class-create`, `class_id`(예 `ministry9`), `class_label`(예 `사역 9기`),
  `class_course`(과제 커리큘럼 id, 없으면 비움), `class_password`(6자 이상).
- **비밀번호 변경**: `class-create` 로 같은 `class_id` + 새 `class_password`.
- **반 폐쇄**: action `class-delete`, `class_id`.

### 멤버 관리 (웹)
멤버 명단은 RTDB `/members/<이름>: { name, qt, active, class }` 에 저장됩니다.
- `qt` = 큐티 완주 현황 집계 대상 · `active` = 글 자동 수집 대상
- `class` = 소속 **반 id**(로그인 단위). 과제 채점은 그 반의 `courseId`(커리큘럼)로 이뤄집니다.
- **관리자**는 사이드바 "⚙️ 멤버 관리" 에서 전체 멤버의 반을 지정, **일반 반**은 "⚙️ 우리 반 관리" 에서
  자기 반 멤버만 추가/관리합니다.
- 멤버 추가 후 그 사람의 **과거 글**까지 채우려면 → 아래 "과거 글 수집".

> 마이그레이션: 기존 멤버의 `course` 값은 `class` 가 없을 때 반 id 로 간주됩니다. 반 id 를 예전
> course id 와 같게(예: `disciple11`) 개설하면 자동으로 이어지고, 다르면 멤버 관리에서 반을 다시 지정하세요.

## 과제 현황 · 커리큘럼 관리

대시보드의 **📝 과제 완주 현황** 카드에서 멤버별 과제 완료 여부를 **반(class)별로** 보여줍니다.
각 반은 자신의 **커리큘럼(course)** 으로 채점됩니다.

- 커리큘럼(과제 정의)은 **RTDB `/courses/<courseId>`** 에 저장되고, 관리자가 웹의 **📚 커리큘럼 관리**
  화면에서 편집합니다(과제 추가/삭제·과제명·종류·그룹·키워드·순서·마감일). 코드
  [`js/assignments.js`](./js/assignments.js) 의 `COURSES` 는 `/courses` 가 비었을 때 쓰는 **초기 시드**입니다.
- 코드 시드를 **이미 운영 중인 `/courses` 에 반영**하려면 **Actions → Admin Tools → `seed-course`** 를
  씁니다(예: 예배은혜나눔 74개처럼 손으로 넣기엔 많은 과제를 추가할 때).
  기본은 **덮어쓰기가 아니라 병합**입니다 — 시드에만 있는 과제는 추가하고, 이미 있는 과제와
  관리자가 직접 추가한 과제는 건드리지 않습니다(웹에서 손본 제목·키워드·마감일을 지키기 위해).
  `dry`(기본 켜짐)로 **무엇이 바뀔지 먼저 확인**하고, 실제로 쓸 때 끄세요.
  `course` 로 한 과정만, `force` 로 기존 과제까지 시드 값으로 덮어쓰기를 지정합니다.
  과제 id 는 절대 새로 만들지 않습니다 (`assignments/<이름>/<과제id>` 체크 기록과 연결돼 있어서).
- `prune` 은 **시드에 없는 과제를 삭제**합니다(`force` 와 무관하게 단독 동작). 과제를 쪼개거나
  이름을 바꿔 **옛 id 가 남았을 때** 씁니다 — 예: `m-vac-video` 하나를 `m-vac-video9`~`16` 으로
  쪼갠 뒤 남은 옛 항목. 관리자가 웹에서 직접 추가한 과제도 시드에 없으면 지워지므로,
  **`dry` 출력의 '시드에 없는 항목' 목록을 먼저 확인**하고 켜세요.
- **마감일은 반별로 다르게** 지정할 수 있습니다: 커리큘럼 관리에서 ‘마감일 편집 대상’으로 반을 고르면
  그 반의 마감일(`classes/<반id>/due/<과제id>`)을 입력합니다(비우면 커리큘럼 기본값 사용).
  → 같은 커리큘럼을 쓰는 **사역 토요반/일요반**이 과제·키워드는 공유하고 **마감일만** 각자 갖습니다.
- 한 커리큘럼을 여러 반이 공유할 수 있습니다(예: `ministry` → 사역 토요반/일요반).
  반 개설 시 `class_course` 로 커리큘럼 id 를 지정합니다.

- **자동 체크**: 수집된 **[훈련나눔]** 글 제목을 과제별 키워드로 매칭해 자동 완료 처리
  (`✓ 자동 ↗`, 클릭하면 글 본문). 키워드는 커리큘럼 관리에서 조정.
- 매칭되는 글이 없는 항목(예: 서약서)은 **클릭해서 수동 체크** — 팝업에서 내용(선택)을 적어
  완료 처리하고, 체크된 항목을 다시 클릭하면 내용 확인·수정·**체크 해제(내용 삭제)** 가 됩니다.
  저장 위치 `assignments/<이름>/<과제ID>` = `true`(내용 없음) 또는 `{ content, createdAt }` (로그인한 멤버 누구나).
- 완주율은 **마감이 도래한 과제** 기준(괄호는 전체 기준), 마감 지난 미완료는 빨갛게, 마감일 미정은 ‘미정’.

## 자동 수집 (GitHub Actions)

- `daily-collect.yml` — **낮(KST 06~23시) 10분마다** 신규 글 수집 → 본문 포함 `/posts/<이름>` 기록.
  결과는 **웹 대시보드**에서 바로 확인합니다(이메일 발송 없음).

데이터 모델: `posts/<이름>/<key>: { collectedAt, postDate, title, link, content }`,
`state/<이름>/lastTitle`(중복 방지 기준점). 큐티 집계는 **제목의 날짜** 기준(수집일 아님).

> **수동 완주일**: 게시판에 글을 올리지 않는 멤버는 대시보드의 큐티 완주 현황에서 멤버 행을 펼쳐
> **관리자가 완주일(+선택적으로 내용)을 직접 추가/삭제**할 수 있습니다.
> 저장 값은 `qtManual/<이름>/<YYYY-MM-DD>: true`(내용 없음) 또는 `{ content, createdAt }`(내용 포함)입니다.
> 수동 완주일은 스크래핑으로 집계된 날짜와 합쳐지며(중복 제거), 웹 대시보드에 반영됩니다.
> 내용을 적어두면 주차별 목록·개인 글 목록에서 **`수동` 태그**와 함께 표시되고, 클릭하면 글 보기 모달로 내용을 볼 수 있습니다.

### 과거 글 수집 (수동)
**Actions → "Collect Past Posts"** — 게시판을 페이지네이션하며 올해치 과거 글을 수집합니다.
특정 멤버만 지정 가능, 글 번호(`num`) 기준 중복 제거(멱등). 새 멤버 추가 후 사용.

### 필요한 GitHub Secrets
**Settings → Secrets and variables → Actions**:

| 시크릿 | 설명 |
|--------|------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키(JSON) 전체 (base64 도 허용) |

(이메일 발송 기능을 제거해 메일 관련 시크릿은 더 이상 필요 없습니다.)

## 로컬 실행 / 배포

```bash
npx serve .          # ESM 모듈은 file:// 불가 → 정적 서버로 실행
```
배포: **Settings → Pages → Deploy from a branch → `main` / (root)**.
GitHub Pages는 정적 호스팅이라 수집·보고는 위 Actions가 별도로 담당합니다(배포 방식과 무관).

## 🔒 보안 안내
- `firebase-config.js`의 `apiKey` 등 웹 설정값은 공개되도록 설계된 값으로 공개 저장소에 포함되어도 안전합니다(보안은 Auth + 규칙으로).
- 서비스 계정 키·메일 비밀번호는 **반드시 GitHub Secrets** 로만 보관하세요.
