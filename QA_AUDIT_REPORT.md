# HEAT Platform: QA, security and reliability audit

Date: November 11, 2026 · Branch: `qa-audit` (local only, not committed or pushed) · Base: `main` at `75a59fe`

## Executive summary

The data layer is in good shape:
- **Tenant isolation held.** An automated probe tried every table and every exposed database function as the owner of another restaurant, an employee of another restaurant, a user with no restaurant, and a signed-out visitor. It found no case where one restaurant could read, change, delete or add another restaurant's data.
- **Employees can't do manager work.** Without access they were limited to their own rows.

The real risks were in **abuse, not isolation**. Anyone can open the demo and becomes the owner of a demo restaurant. Nothing limited what that owner could trigger:
- Shift-report emails to any address, sent from HEAT's domain.
- Unlimited AI calls (tutor and assistant).
- Repeated phone notifications.

These are fixed in code, with a new migration (066) and regression tests.

The browser pass found one visible bug: on a phone (375 to 390 px), the owner's Sign out button was cut off the right edge of the header. It is fixed.

Two things this environment could not do, so they are **not verified**:
1. Run the app against the real Supabase project. Outbound access to supabase.co is blocked here, so the browser tests used a local fake backend.
2. Test real push delivery, Realtime, uploads, email or AI responses.

**Verdict: READY FOR STAGING REVIEW**, provided migration 066 is applied to staging before this code is deployed. The code works without it, but the limits are then off.

## Bugs discovered

### 1. Shift-report email could be used to spam any address from HEAT's domain (High, security/abuse). FIXED
- **Feature:** shift report → email (`app/api/shift-report/route.ts`, `shift_report_recipients` in 038).
- **Steps:**
  1. Open `/demo`. You get an anonymous account that owns a demo copy.
  2. Insert any outside addresses into `shift_report_recipients` and submit a report.
  3. Call `POST /api/shift-report {reportId}` in a loop.
- **Actual:** every call sends to up to 50 addresses chosen by the attacker, with no limit.
- **Expected:** demo visitors never send email, and a report isn't re-sent back to back.
- **Root cause:** the recipient policy only checked `can_manage(..,'team')`, which is true for any owner, demo included. The route had no send limit.
- **Fix:**
  - Migration 066 recreates the insert policy with `and not public.is_anonymous()`.
  - New `claim_request('report_email', reportId)`: never for anonymous users, at most once per report every 10 minutes, and 20 a day per person. The route answers 429 with a clear message.
- **Verification:** `tests/request-limits.test.ts`. It **failed before the fix** ("Missing expected rejection": the demo insert succeeded) and passes after.

### 2. Unlimited AI usage, including by anonymous demo visitors (High, cost abuse). FIXED
- **Feature:** `/api/tutor` (Haiku) and `/api/assistant` (Sonnet, up to 8 tool rounds).
- **Steps:** create anonymous accounts, call `start_demo`, then loop `POST /api/assistant` with 40 long messages.
- **Root cause:** no quota anywhere. A demo owner passes the "managers only" check.
- **Fix:** `claim_request('tutor' | 'assistant')` before calling Anthropic. Daily limits per person:

  | | Signed-in user | Demo visitor |
  |---|---|---|
  | Tutor | 400 | 40 |
  | Assistant | 150 | 15 |

  Over the limit, the route answers 429 with "You've reached today's limit…" (translated to Spanish).
- **Verification:** `tests/request-limits.test.ts` (daily count, per-kind counts, 24-hour window).
- **Note:** the numbers are a product decision. They live in one place in 066.

### 3. Phone notifications could be re-sent in a loop (Medium, abuse). FIXED
- **Feature:** `/api/notify`.
- **Steps:** an employee with a pending time-off request loops `POST /api/notify {"event":"time_off_requested","ref":…}`, and every manager's phone rings each time.
- **Fix:**
  - `claim_request('notify', event:ref:target)` refuses the same announcement within a minute, with a daily cap of 300 (30 for demo visitors).
  - Database refusals now map to 403 for access errors and 400 for malformed input, instead of returning Postgres's internal message.
- **Verification:** `tests/request-limits.test.ts`.

### 4. Sign out button cut off on phones (Medium, UX). FIXED
- **Feature:** app header, owner and manager view.
- **Steps:** open `/app` as an owner at 375 or 390 px wide.
- **Actual:** the page scrolls sideways, and the Sign out icon is half off screen (390 px of content in a 375 px screen). Screenshot before the fix: `overflow-_app_owner_home_375.png`.
- **Root cause:** adding the chat icon made the four header icons (44 px each, 8 px gaps) plus the logo wider than a phone.
- **Fix:** a new appended CSS block in `app/globals.css` (one purpose, with an undo note). Below 480 px the icons sit together with a 40 px tap area. Adds the class `app-header-actions` in `app/workspace.tsx`.
- **Verification:** measured in Chromium. With the fix, page width equals screen width at 360, 375 and 390 px, for both owner and server.
- **Still open:** at 320 px (very old phones) the owner header is still 30 px too wide.

### 5. Pre-shift test failed every evening, US Eastern (Low, test reliability). FIXED
- **Test:** `tests/preshift-working-today.test.ts` used the database's UTC `current_date` instead of the restaurant's day. Between 7 and 8 pm and midnight in Miami it failed. It failed in the baseline run of this audit.
- **Fix:** ported the existing, unmerged fix from branch `claude/serene-ptolemy-e5y1z2`.
- **Verification:** passes. Full suite 153/153.

## Security findings

| Finding | Status |
|---|---|
| Cross-restaurant read, update, delete or insert on any table (41 of 44 tables seeded; 4 actors) | **None found.** Now a permanent test: `tests/tenant-isolation.test.ts`. |
| Tables without row level security | None |
| Security-definer functions without a pinned `search_path` | None (107 checked) |
| Functions an outsider can call with another restaurant's ids | All 107 refuse or return nothing, except the minor items below |
| Storage: another restaurant reading or uploading under A's folder (`menu-photos`, `chat-media`, `floor-photos`) | Denied |
| Secrets in client code | None. Only the Supabase URL, the publishable key and the VAPID public key are `NEXT_PUBLIC_*`. |
| `chat-cleanup` cron with `CRON_SECRET` unset | Safe: answers "not configured" before comparing |
| Email relay, AI cost, notification spam | Fixed (bugs 1 to 3) |

The isolation test was proven to work: a planted `using (true)` policy on `menu_items` made it fail with "LEAK as 4/5/6: menu_items".

### Minor and open items
- **Low: membership oracle.**
  - `chat_is_member(rid, uid)` and `is_on_team(rid, uid)` answer true or false to anyone signed in.
  - Someone who already knows two UUIDs can learn whether that person works at that restaurant. Exposure is low because UUIDs aren't guessable.
  - Suggested fix: return false unless the caller can read that restaurant.
- **Low: unlimited trial restaurants.** `start_trial_restaurant` lets any signed-in account create restaurants with no cap.
- **Low: cron secret compared with `!==`.** Not a constant-time comparison; not exploitable over the network in practice.
- **Supabase advisors on heat-pruebas** (read only):
  - "Leaked password protection" is off. Turn it on in Supabase Auth settings; this is a dashboard change, not made here.
  - 37 "anonymous sign-ins" warnings: policies also apply to anonymous demo users. That is by design for the demo, and it is the class of issue behind bugs 1 to 3.
- **Not covered by the probe:** `quiz_attempts`, `quiz_bank_revisions` and `shift_changes` could not be seeded automatically. Their access rules are covered by the existing tests (`quizzes`, `quiz-persistence`, `shift-changes`).

## Test coverage

| Area | How | Result |
|---|---|---|
| Typecheck | `tsc --noEmit` | Pass |
| Production build | `next build` | Pass |
| Unit and database suite | `npm test` (PGlite, all migrations) | Baseline 149/150 (bug 5); now **153/153** |
| Tenant isolation, all tables | New test, 4 actors × select/update/delete/insert | Pass; planted leak detected |
| Security-definer functions | Called as outsider, other owner and anon, with another restaurant's ids | No leaks |
| Storage policies | Read and upload as other tenants | Denied |
| API routes | Code review traced end to end (subagent, then the main findings checked by hand) | Bugs 1 to 3 |
| Public pages `/`, `/login`, `/trial`, `/demo`, `/preview` | Playwright at 375, 390, 768, 1366 and 1920 px | No overflow, no console or page errors |
| Signed-in app, owner and server, every side-menu item | Playwright at 375 and 1366 px, fake backend | One overflow (bug 4, fixed); no page errors |

**Notes on the browser pass:**
- The only console errors were the fake backend refusing a Realtime websocket. That comes from the test setup, not the app.
- A few side-menu items reported "not clickable" in the automated run. Checked by hand: they sit lower in the menu and can be clicked after scrolling. That is an artifact of the script.
- Public pages have small text links ("Sign in", "Open the demo kitchen") whose tap area is under 20 px tall. Low; for Gaby.

**Could not be tested here:**
- Real Supabase (auth, password reset, session expiry, Realtime chat), because supabase.co is unreachable from this environment.
- Real email (Resend), AI answers (Anthropic) and push delivery.
- Uploads to real Storage.
- iOS Safari and real phones.
- Slow-network, interrupted-request and concurrency behavior in the UI, beyond what the database tests cover.
- The data-entry edge cases listed in the brief (long inputs, special characters, double clicks) were not exercised screen by screen. The database enforces length limits on the main tables, seen in the constraints during the probe.

## Changes made (uncommitted)

| File | Change |
|---|---|
| `supabase/migrations/066_request_limits.sql` | **New.** `request_log` table (private), `claim_request()` limits, recipient policy refuses anonymous users. Additive; drops and recreates one policy only. |
| `lib/request-limit.ts` | **New.** `claimRequest()` used by the routes. If 066 isn't applied yet, nothing is blocked. |
| `app/api/tutor/route.ts`, `app/api/assistant/route.ts` | Daily limit before calling Anthropic (429 with a friendly message). |
| `app/api/shift-report/route.ts` | No email from the demo; no re-send within 10 minutes; generic 403 text. |
| `app/api/notify/route.ts` | No repeat within a minute; 403 vs 400 instead of raw database errors. |
| `app/globals.css`, `app/workspace.tsx` | Header fits on phones (bug 4). |
| `lib/i18n-es.ts` | Spanish for the new messages, and the "email didn't go out" message, which had none. |
| `tests/request-limits.test.ts` | **New.** Regression tests for bugs 1 to 3. |
| `tests/tenant-isolation.test.ts` | **New.** Whole-schema isolation test. |
| `tests/preshift-working-today.test.ts` | Test day fix (bug 5). |
| `QA_AUDIT_REPORT.md` | This report. |

## Remaining issues and next steps

1. **Apply migration 066** to staging and then production, before or together with deploying this code.
2. Turn on **leaked password protection** in Supabase Auth.
3. Decide the **daily limits** for the AI and notifications. The values in 066 are a first proposal.
4. **Assistant stream after the user disconnects** (possible, not tested): the Anthropic request isn't cancelled when the browser goes away (`request.signal` is not passed to it). Pass the request's abort signal.
5. **Tutor prompt size:** every card is sent to the model on each call. Cards are capped at 2000 characters each, but their number isn't. The new daily limits cap the cost, but a ceiling on the document would be safer.
6. **Membership oracle** functions (Low, above).
7. **Header at 320 px**, and **small text links** on public pages (Low, for Gaby).
8. A staging run with real Supabase: login, password reset, session expiry, chat Realtime and uploads on a real phone.

## Release readiness

**READY FOR STAGING REVIEW.** No critical issues remain open. The high-risk abuse paths are fixed and covered by tests, pending migration 066 on the target database and a review of these uncommitted changes.
