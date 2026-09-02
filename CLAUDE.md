# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**jeja-pepero (제자 페페로)** is a church small-group QT (quiet-time / daily devotional) completion tracker. It has two independent halves that share one Firebase Realtime Database:

1. **Web dashboard** — vanilla HTML/CSS/JS (ES modules, no build step, no framework), loads Firebase from the gstatic CDN, hosted on **GitHub Pages**.
2. **Scheduled jobs** (`scripts/`) — Node scripts run by **GitHub Actions** that scrape a church board (`thelifechurch.kr`, `boardID=www56`) and write posts to the RTDB. Results are viewed in the web dashboard (no email).

There is no server. The two halves only communicate through Firebase RTDB.

Most code comments and the README are in Korean. The domain logic (scraping + QT-date aggregation) was ported from a legacy Google Apps Script; `PLAN.md` documents that original design.

## Commands

There is **no build or bundler**. The web app is served as static files.

```bash
# Local dev (ESM cannot run from file://, so a static server is required)
npx serve .

# Scripts: all commands run from the scripts/ directory
cd scripts
npm install
npm test                       # runs node --test (unit tests)
node --test test/qt-parse.test.js   # run a single test file

# Job entry points (need env vars — see below):
npm run collect:daily          # scrape new posts → RTDB
npm run collect:history        # backfill this year's past posts (paginated)
npm run backfill:content       # fill body text into existing posts
npm run seed:members / set:admin / dedupe:posts / diagnose  # admin tools
```

CI (`.github/workflows/ci.yml`) runs on every PR and push to `main`: `node --check` over all `js/` and `scripts/` JS files, then `npm test` in `scripts/`. Keep both green — `main` is what the scheduled collection workflows run from.

## Environment / secrets

Scripts read config from env vars (set as GitHub Actions secrets):
- `FIREBASE_SERVICE_ACCOUNT` — service-account JSON, raw or base64 (base64 preferred; `lib/firebase.js` auto-repairs broken `private_key` newlines). This is the only secret the jobs need (no email).

The web app's `js/firebase-config.js` `apiKey` is a public client value by design — access is enforced by Firebase Auth + RTDB security rules (rules are documented in `README.md`), not by hiding it.

## Architecture

### Web dashboard (`js/`, loaded by `index.html`)
- `app.js` — entry point / view gate: swaps login ↔ main view based on auth state.
- `auth.js` — **class + password login** (Firebase email/password). Each training class (반) is one Auth account; the login email is derived from the class id (`<classId>@class.jeja-pepero.app`), so users only pick a class from a dropdown (populated from the public `/classes` node) and enter the class password. Admin accounts carry a custom claim `admin: true` (see everything); a class account is scoped in-UI to its own class. One curriculum (`course`) can back multiple classes (e.g. `ministry` → 사역9기/10기/11기).
- `firebase-config.js` — Firebase init (auth + db) from CDN.
- `config.js` — shared browser constants + QT-date parsing + color rules.
- `assignments.js` — `COURSES` definition (see below).
- `dashboard.js` — the bulk of the UI: dashboard, member tabs, member management, assignment status rendering.

### HWPX export (`js/hwpx/`, blank forms in `assets/templates/`)
Fills the church's own Hangul (`.hwpx`) forms from dashboard state and downloads them in the browser.
`assets/templates/*-빈양식.hwpx` are the real church forms with all content emptied — **the forms
themselves are never edited**; the code only clones their nodes or flips cell styles.
- `owpml.js` / `compile.js` / `status.js` / `status-data.js` — **pure string/XML functions, no
  DOM/Firebase/JSZip imports.** The Node tests (`scripts/test/hwpx*.test.js`) import these browser
  files directly, so there is no web/Node code duplication to keep in sync (cf. invariant 1).
  Never add a DOM, Firebase, or JSZip import to them.
- `zip.js` / `build.js` — ZIP handling; JSZip is *injected* (browser: CDN `window.JSZip` lazy-loaded,
  Node tests: devDependency). Output must keep the source form's entry names/order with `mimetype`
  first and STORED.
- `export-ui.js` — the modal; `scripts/tools/make-status-template.mjs` regenerates a blank form.
- Design notes and the church forms' quirks (misaligned cell addresses, `charPrIDRef` 13/20/32
  meaning done/not-done/N-A) are in `PLAN-HWPX.md`.

### Scheduled jobs (`scripts/`)
- `lib/scrape.js` — board scraping + QT-date parsing. Parses the list HTML by splitting on `class="mdDefaultW100 mdWebzinecon`, extracts title/link/date with regexes, filters out "공지" (notices) and posts before `START_DATE_STRING`. `fetchPostContent` pulls body text from detail pages.
- `lib/firebase.js` — `firebase-admin` init (service account → RTDB).
- `lib/members.js` — loads member roster from `/members`, falling back to `DEFAULT_MEMBERS`.
- `collect-daily.js` / `collect-history.js` / `backfill-content.js` — the jobs (scrape → RTDB).

### RTDB data model
- `posts/<name>/<pushKey>: { collectedAt, postDate, title, link, content }`
- `state/<name>/lastTitle` — dedup checkpoint: collection walks newest→oldest and **breaks** when it hits `lastTitle`, then reverses the fresh batch to write oldest→newest.
- `members/<name>: { name, qt, active, class }` — `qt` = counts toward QT aggregation, `active` = gets scraped, `class` = training-class id (login unit; falls back to legacy `course` if `class` absent). Assignment grading uses the class's `courseId` curriculum.
- `classes/<classId>: { label, courseId, active, due }` — training classes (login units); **publicly readable** so the login dropdown can list them before auth. Passwords live in Firebase Auth, not here. Managed by `scripts/manage-class.js` (Actions). `due/<taskId>` holds per-class assignment due-date overrides.
- `courses/<courseId>: { label, tasks: { <taskId>: { title, kind, group, order, due, m, x } } }` — assignment curricula, edited in the web **📚 커리큘럼 관리** (admin). `js/assignments.js` `COURSES` is only the initial seed used when `/courses` is empty.
- `assignments/<name>/<assignmentId>: true` — manual assignment checkboxes (any logged-in member may write).
- `state/*` is server-only (rules deny client read/write). (The legacy `/users` allowlist node is no longer used.)

## Critical invariants — read before editing

1. **`extractQtDays` is duplicated in `js/config.js` and `scripts/lib/scrape.js` and must be kept identical** (there is no shared module across the web/Node split — it's manually synced, as noted in `config.js`). The same applies to `TARGET_NAMES` / `QT_TARGET_NAMES` / `postNum`. Change both sides together.

2. **The QT-date parser is the most safety-critical logic** — it drives completion aggregation and was carefully ported from the legacy script. It recognizes many title date formats (`260215`, `20260215`, `0215`, `2월15`, `2.15`, `02/15`) for a given year/month and returns in-range days. `scripts/test/qt-parse.test.js` guards it; extend the tests when touching it.

3. **QT completion is counted by the date *in the post title*, not the collection date.** Aggregation dedups days via a `Set` (distinct days ÷ days-in-month).

4. **Assignment curricula are runtime data in RTDB `/courses`**, edited via the web 커리큘럼 관리 screen. `js/assignments.js` `COURSES` is the **seed** written to `/courses` on first admin edit (`ensureCourseSeeded`); the dashboard merges code seed with RTDB (RTDB wins). Each task carries keyword lists (`m` = match, `x` = exclude) for auto-matching scraped `[훈련나눔]` titles; tasks with no keywords are manual checkboxes. **Due dates are per-class overrides** (`classes/<id>/due/<taskId>`), so one curriculum shared by several classes (e.g. 사역 토요반/일요반) differs only in due dates. Preserve existing task ids when editing the seed — `assignments/<name>/<taskId>` checkboxes key off them.

5. **KST (Asia/Seoul) is the fixed timezone** for date boundaries and cron scheduling. `daily-collect.yml` cron is written in UTC but targets KST 06–23h.

6. **Dedup is title-based** (`state/<name>/lastTitle`) for daily collection but **post-number-based** (`postNum`, `num=` query param) for history/dedupe tools, which is more robust. Preserve the `num`-based idempotency in those tools.

7. **The `jeja-pepero` identifiers are NOT the GitHub repo name — do not rename them to match the repo (`thelife-training`) or the UI brand ("The Life").** The GitHub repo was renamed; these identifiers point at external services that were *not* renamed, and changing them breaks production:
   - **Firebase project** — `js/firebase-config.js` and `scripts/lib/firebase.js` reference the live Firebase project `jeja-pepero` (`authDomain`, `databaseURL`, `projectId`, `storageBucket`). The RTDB and all data live under this project id. These must match the actual Firebase project, which is independent of the repo name.
   - **Login email domain** — `EMAIL_DOMAIN = "class.jeja-pepero.app"` in `js/auth.js` and `scripts/manage-class.js` is the synthetic domain that class login emails are derived from (`<classId>@class.jeja-pepero.app`). Existing Firebase Auth accounts were created with these emails, so changing the domain locks every class (and admin) out. Keep the two files identical (see also invariant 1's manual-sync rule).

   Only rename these if the Firebase project or Auth accounts are *actually* migrated first. Cosmetic/doc mentions of the old name (README title, `package.json` `name`, `PLAN.md`) are safe to update; the four service identifiers above are not.

## Deployment

GitHub Pages: Settings → Pages → deploy from `main` / root. Pages only serves the static site; collection/reporting are entirely GitHub Actions (`.github/workflows/`), independent of deployment.
