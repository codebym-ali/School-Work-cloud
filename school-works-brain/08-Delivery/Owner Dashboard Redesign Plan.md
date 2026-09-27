# Owner Dashboard Redesign Plan

**Status:** Phase 1 ✅ SHIPPED 2026-09-27 · Phase 2 ✅ SHIPPED 2026-09-27 · Phase 3 planned.
**Phase 2 as built:** `GET /dashboard` gained `outstandingTotal` (same `overdueWhere` predicate object as `defaulterCount`), `monthBilled` + `monthBilledPaid` (this month's own invoices, WAIVED excluded — the bar is "share of this month's fees paid", not cash÷bills), `lastMonthToDate` (month-to-date vs last month to the same day), and `schoolDay {open, reason}` from the new pure `schoolDayStatus()` in `libs/common/src/util/attendance.ts` (weekly off wins; school-wide holiday closes all; a campus holiday closes only that campus). Closed day ⇒ `todayAttendanceExpected = 0`; closed campuses' children are excluded from the whole-school count. The page no longer borrows the open/closed signal from the staff register. Tests: `schoolDayStatus` unit ×6, new `test/integration/owner-dashboard.e2e-spec.ts` ×6. **Deviation:** notification `severity`/`actionLabel` were NOT added server-side — Phase 1's client-side `KIND` map already ranks and labels every kind, so a second source would only drift. **Known cost:** `NotificationsService` calls `DashboardService.get()`, so each bell refresh now runs ~5 extra indexed aggregates it does not use — acceptable today; split a lean path if the bell ever shows up in profiling.
**Phase 1 deviations:** the "School open/closed" signal comes from the staff day summary (it already applies weekly-off + holidays) until Phase 2's `schoolDay`; the owed card shows the student count (amount needs `outstandingTotal`); the collected card shows last month's total instead of a bar vs billed (needs `monthBilled`); the students card uses a single-colour present bar, not green+red (charts.tsx CVD rule: red and green must never touch). The sidebar "Owner / Owner" repetition (brand + role chip) is left — `home-roles.spec` deliberately asserts the chip for single-role users. Mockup: https://claude.ai/artifact/FvvyDiJpBRe1VZFrKG2Pbe (desktop, phone, closed day).
**Research:** `reports/School owner dashboard design.md` (global SIS + Pakistan/India school ERPs + dashboard UX authorities).
**Supersedes:** the `ownerHomeV2` pilot flag ([[owner-home-v2]] in Key Decisions) — its four fixes are folded in and the flag is retired.

## 1. Why

The owner reported the home dashboard "looks so odd it will confuse the owner". Review of the live page (26–27 Sep 2026) plus the code found:

| # | Problem | Cause |
|---|---|---|
| B1 | MFA warning and "school closed" banner render as plain unstyled text | `.toast.warn` is not defined in any of the 5 apps' `globals.css` (only `.ok`/`.err`) |
| B2 | "Not marked yet" shown in large green | `todayAttendancePercent` tile has resting tone `ok`; a null value keeps it |
| B3 | On Sunday it says "0 of 320 · 320 not yet" | `insights.service.ts` `expectedToday` counts active enrolments and ignores weekly-off days and holidays (the staff card already handles this) |
| B4 | The owner is labelled "School Admin" (sidebar, badge, greeting) | `ROLE_INFO` label for `OWNER_ADMIN` in `packages/roles/src/index.ts`; easy to confuse with Campus Admin |
| U1 | Heavy navy header bar on every card; no single focal point | panel styling |
| U2 | Numbers without context (Rs 675,000.00 of what? 144 defaulters owing how much?) | API returns no billed or outstanding amount |
| U3 | "Needs attention" is a strip of chips with no actions | chip rendering |
| U4 | Sidebar leads with configure-once screens (Classes, Subjects…) | default `NAV_GROUPS` order |

Research headline: Pakistani/Indian ERPs lead the owner screen with **cash** (fee collected in 8 of 10 vendors, dues/defaulters in 7, student attendance in 5). No product found combines fees + attendance + one ranked action list — that is our differentiator.

## 2. Users and what they see (permission matrix)

| Block | Owner | Ops Admin | Accountant | Campus Admin |
|---|---|---|---|---|
| Headline + summary sentence | ✓ | ✓ | money parts only | own campus |
| Collected vs billed | ✓ | ✓ | ✓ | number only (no link) |
| Still owed | ✓ | ✓ | ✓ | own campus |
| Students in school | ✓ | ✓ | — | own campus |
| Staff at work | ✓ | ✓ | — | own campus |
| Needs your attention | ✓ (all) | ✓ (not owner-only items) | fee items | campus items |
| Collections trend | ✓ | ✓ | ✓ | own campus |

Server-side `visible[]` stays the gate (role-shaping); nothing new is exposed that a role cannot already reach.

## 3. Layout (top to bottom = priority; phone stacks the same order)

1. **Status line** — pill "School open today" (green dot) / "School closed · weekly off / <holiday>" (neutral) + date + campus switcher.
2. **Headline** — "Good morning. N things need you today." / "You're all caught up."
3. **Summary sentence** — "So far in September you have collected Rs 6.75 lakh — 74% of the fees billed. 144 students still owe Rs 4.05 lakh. Today 288 of 320 students are in school." (closed-day and new-school variants).
4. **Four KPI cards** (whole card is a link): Fees collected · month (value + bar vs billed) · Still owed (amount + students overdue) · Students in school (x of y + present bar + register coverage) · Staff at work (x of y + not-marked count).
5. **Needs your attention** — ranked (red money → amber people → amber setup), cap 5, each row: icon, one-line sentence, sub-line, **one action button**. The 2-step sign-in item lives here for the owner (banner stays on other screens).
6. **Fees collected, last 6 months** — one bar chart, current month highlighted, honest empty-months note.
7. **Quick actions** — Record a payment · Admit a student · Class-wise fee report · Send a notice to parents.

Visual rules: light white cards, no navy header bands; Bitter for numbers/headings, Roboto body; colour = meaning (green done/on-target, amber waiting on a person, red money not received) always paired with words/icons; money in **lakh/crore** on the dashboard (`Rs 6.75 lakh`, cards `Rs 6.75L`), full rupees on ledger screens; touch targets ≥ 44px.

## 4. Data mapping

| Need | Today | Change |
|---|---|---|
| Collected this month | `monthCollections` ✓ | — |
| Billed this month | ✗ | **add `monthBilled`** = Σ `fee_invoices.total_amount` for current month/year (campus via enrolment) |
| Still owed (amount) | ✗ (count only) | **add `outstandingTotal`** = Σ (total − paid) on overdue invoices — same predicate as `defaulterCount` so 144 ↔ amount always agree |
| School open today? | ✗ for students | **add `schoolDay: { open, reason }`** using the attendance service's `nonWorkingReason` (weekly off + holidays); when closed, `todayAttendanceExpected = 0` |
| Month-on-month | trend ✓ | compare **month-to-date vs last month same day**, not full last month (day-3 would always look like a crash) |
| Today's cash (P3) | ✗ | `todayCollections` = Σ payments with today's date |
| Attention items with actions | `notifications.list()` text+href ✓ | **add optional `severity` and `actionLabel`** per item server-side |
| Staff at work | `staffAttendance.daySummary()` ✓ | — |

Demo check (2026-09-27): billed Rs 918,000 · collected Rs 675,000 · outstanding Rs 405,000 across 144 overdue students (collected includes advances, so the bar must cap at 100%).

## 5. Implementation phases

**Phase 1 — bugs + layout on existing data (frontend, ~1–2 days)**
- Define `.toast.warn` (warn-tint bg, warn-ink text, border) in all 5 `apps/*/app/globals.css` (B1).
- `OWNER_ADMIN` label → "Owner" in `@sw/roles` (B4); update any test/e2e text matching "School Admin".
- `todayAttendancePercent` null → amber "Not marked yet", never green (B2).
- Rebuild `packages/school-ui/src/app/dashboard/page.tsx`: `StatusLine`, `HeroSummary`, `KpiCard`, `AttentionList`, restyled `CollectionsTrend`, `QuickActions`; dashboard-scoped CSS without header bands.
- `formatMoneyShort()` (lakh/crore, pinned — no browser-locale drift) in `@school/lib`, unit-tested.
- Make the curated sidebar the default (group order, "School setup"/"Administration" collapsed); retire `ownerHomeV2` flag.
- Cards that need new fields render without them (no bar, "of billed" hidden) until Phase 2.

**Phase 2 — API fields (backend, ~1 day)**
- `insights.service.ts`: `monthBilled`, `outstandingTotal`, `schoolDay`, closed-day `expected = 0`, month-to-date comparison; extend `Dashboard` in `@sw/api-client`; respect `visible[]` and campus lens.
- Notifications: `severity` + `actionLabel`.
- Integration tests: closed day ⇒ expected 0 and `schoolDay.open=false`; outstanding total matches defaulter predicate; campus lens scoping; accountant cannot see attendance fields.

**Phase 3 — owner value-adds**
- "Send reminders" → bulk SMS/WhatsApp to overdue guardians (reuse the defaulters/SMS flow if present; audit-logged).
- Today's cash collected in the summary line; class-wise collection % card ("lowest 5 classes").
- Owner daily summary (evening push/SMS) — later.

## 6. Edge cases

New school (0 students → setup checklist empty state) · nothing billed this month (hide bar, "No fees billed yet for September") · collected > billed via advances (cap bar 100%, show "+ Rs X advance") · one campus closed, another open (whole-school view counts only open campuses) · before the attendance deadline (amber "not marked yet" only after the school's deadline — notifications already know it) · campus lens active (scope pill on each card; attention list says "Whole school") · slow/offline (skeleton cards, "updated 5 min ago") · very large schools (all aggregates are SQL sums/counts, indexed on school_id + month/year + due_date).

## 7. Acceptance criteria

- Owner can say in ≤5 s: money in this month, money still owed, whether school is running normally, what to do next (5-second test with 3–5 real owners).
- No green on any pending/unmarked state; no attendance nag on a closed day.
- Every card and attention row is one tap to the screen behind it; every attention row has an action.
- Phone 390px: no horizontal scroll, order = §3.
- Tenant-isolation suite, RLS coverage, lint, strict typecheck, api+worker+5 FE builds green; verified live in the browser on the demo tenant (school day + Sunday).

## 8. Out of scope

Income vs expense / profit (no expense module — Decision D5). Exam performance on the owner home (lives in Exams & Results / Performance).
