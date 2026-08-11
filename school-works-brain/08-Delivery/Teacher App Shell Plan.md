---
title: Teacher App Shell Plan (one navigation, both widths)
type: plan
status: T0 + T1 SHIPPED 2026-08-11 · T2–T4 planned
updated: 2026-08-11
---

# 📱 The teacher gets an app, not a dashboard

> Related: [[Teacher Mobile Home Plan]] · [[Cover Plan]] · [[05-ui-ux-specification]] · [[Key Decisions]]

Follow-on to [[Teacher Mobile Home Plan]] (M0–M4, complete). That plan built the phone shell and it
works. **This plan fixes the half it left behind: what a teacher sees on anything wider than a
phone, and what the home screen says in the state every school is currently in.**

## 1. What is actually wrong, measured

Checked live on 2026-08-11 with a throwaway TEACHER account on `demo`, at 375px and 1440px.

**The tab bar is fine.** At 375px: `shell has-tabbar`, four tabs — Home · Attendance · Week · Me —
`display: grid`, pinned at y=755 of an 812px viewport, sidebar `display: none`. M0 delivered what it
said. The report that prompted this plan came from a screenshot cropped above the bar.

Three things are wrong, and none of them is the tab bar.

### 1.1 ⚠️ On desktop the teacher's Home is an orphan

At 1440px the sidebar renders eight links — `/attendance`, `/my-classes`, `/exams`, `/calendar`,
`/my-attendance`, `/my-timetable`, `/my-leaves`, `/my-payslips` — and **`/home` is not among them.**
`/home` and `/me-more` are `hidden: true` in `NAV` so the tab bar can own them, which is right on a
phone and strands them above 720px.

So a teacher on a laptop lands on Home (their `landingPath`), clicks anything, and **has no way
back except the browser's back button or typing the URL.** The home screen this project spent four
phases building is unreachable on a laptop after the first click.

### 1.2 The two navigations disagree about what a teacher's job is

| | Phone (≤720px) | Desktop (>720px) |
|---|---|---|
| Count | 4 | 8, in 3 groups |
| Home | ✅ first tab | **absent** |
| Timetable | "Week" | "My Timetable" |
| Me | ✅ | **absent** |
| Grouping | none | ACADEMICS / ADMINISTRATION / MY PORTAL |

Same person, same product, two mental models and two vocabularies. "MY PORTAL" is an admin's word
for a teacher's own things.

### 1.3 ⚠️ A teacher who wears a second hat never sees the teacher shell at all

`usesMobileShell` is `primaryRole(roles)?.role === 'TEACHER'`, and `primaryRole` returns the
**first match in `ROLE_INFO` order** — where TEACHER is **7th**, behind PLATFORM_ADMIN, OWNER_ADMIN,
CAMPUS_ADMIN, ACCOUNTANT, ADMISSION_CONTROLLER and HR_MANAGER.

So a teacher who also handles admissions gets the Admission Portal shell: **no tab bar, no Home, on
a phone as well as a laptop.** Demo's own `ayeshakhan@gmail.com` is `TEACHER, ADMISSION_CONTROLLER`
and is exactly this case. In a small Pakistani private school, the teacher who also does one
administrative job is not an edge case — it is normal staffing.

### 1.4 The home screen contradicts itself in the state every school is in

Observed verbatim:

> **A register needs marking**
> No timetable has been set for you yet — the office builds it under Timetable.
> `[ Open attendance ]`

The headline promises a task, the body explains an absence, and the button is generic. **The
system knows the answer it is refusing to give**: `GET /attendance/unmarked-today` names the
sections and `GET /teaching/my-classes` names the teacher's own. M1's promise was *"hands them that
register in one tap"*; with no timetable — which is **every school today**, `timetable_slots` has
never held a row outside a test — it degrades to opening the screen cold, which is the exact
problem M1 was built to solve.

### 1.5 The teacher's cards were never looked at above 720px

The "now" card is a phone component stretched across 1500px: a 26px headline in a full-width dark
slab with roughly three-quarters of the viewport empty beneath it.

## 2. The design thesis

**Role decides the shell; width decides only the layout.**

A teacher's device does not change what a teacher's job is. Today the product asks "how wide is
this screen?" and hands over two different applications. It should ask "who is this?" once, and then
lay the same application out for the space available.

Concretely: **one list of destinations, rendered as a bottom bar under 720px and as a sidebar above
it.** The structure is identical at both widths — same items, same order, same words — so a teacher
who learns the app on their phone already knows it on a laptop.

**The four stay four on desktop.** The temptation is to hoist the six secondary items into the
sidebar because a laptop has room. Resisted: the phone's structure *is* the product's structure, and
"more room" is a reason to make things bigger, not to invent a second information architecture. The
sidebar gets full labels, comfortable targets and an Account footer; everything else stays behind
**Me**, exactly as on the phone. *If real use shows that costs a click too many, promoting the
secondary list is a one-line change — but it should be made because a teacher complained, not
because there were spare pixels.*

## 3. Phases

- **T0 — one navigation, two renderings. ✅ SHIPPED 2026-08-11.** `TEACHER_TABS` becomes the single source of truth for
  both. A `TeacherNav` component renders it as the bottom bar ≤720px and as the teacher sidebar
  above; the admin sidebar stops rendering for a teacher at any width. `/home` and `/me-more` stop
  being orphans. **Fixes 1.1 and 1.2.**
- **T1 — the teacher shell follows the person, not the role table. ✅ SHIPPED 2026-08-11.** A user holding TEACHER gets
  the teacher shell even when they also hold another role, with the second role's screens reachable
  from the last tab. **All three decisions taken — see §5 and §5a.** **Fixes 1.3.**
- **T2 — the home screen earns the top of the screen with no timetable.** When there is no
  timetable, name the registers: *"Mark 9-A"* with the rest listed beneath, derived from
  `unmarked-today` ∩ `my-classes`. The headline stops promising a task the body then withdraws.
  **Fixes 1.4.** No new endpoints.
- **T3 — the teacher's surfaces at desktop width.** Cap the now card's measure so it reads as a
  card rather than a banner; two-column above 1024px so the screen is not three-quarters empty.
  **Fixes 1.5.**
- **T4 — tests, browser pass at 375 / 768 / 1440, brain.** A Playwright case that a teacher can
  reach Home from every teacher screen **at desktop width** — the regression that started this.

## 4. What this deliberately does not change

- **No other role's shell.** Owner, campus admin, accountant, HR and admission keep the sidebar and
  drawer at every width. This is about the one role that is mobile-heavy by nature (blueprint §3).
- **No new endpoints.** Everything T2 needs is already served.
- **No offline.** Still out, for the reason in [[Teacher Mobile Home Plan]] §8: a silent sync
  conflict on a register that feeds pay is worse than waiting for signal.
- **Not the student portal.** `/me/*` is its own shell and its own question.

## 5. Decision TAKEN for T1 (2026-08-11)

**Option 2: the teacher shell wins unless the person also holds OWNER_ADMIN or CAMPUS_ADMIN.**
Teacher beats ACCOUNTANT, ADMISSION_CONTROLLER and HR_MANAGER; it never beats a school-wide
administrator. This fixes the realistic case — the teacher who also runs admissions — without
stranding an owner who happens to teach a class. The options as considered:

1. **Teacher shell wins for anyone holding TEACHER** — simple rule, and the teaching job is the one
   done between rooms on a phone. Risk: an owner who is also formally a teacher would lose the
   admin sidebar, so this needs a carve-out for the two admin roles.
2. **Teacher shell unless they hold an admin role** (OWNER_ADMIN / CAMPUS_ADMIN) — teacher beats
   ACCOUNTANT, ADMISSION_CONTROLLER, HR_MANAGER, but never beats a school-wide administrator.
   *Recommended:* it fixes Ayesha's case, which is the realistic one, without stranding an owner.
3. **Let the user choose**, remembered per account. Most flexible, most to build, and a preference
   nobody sets is a preference that does nothing.

## 5a. What a dual-role person actually gets (decided 2026-08-11)

Checked live on `demo` with a real TEACHER + ACCOUNTANT user before deciding — the system refuses a
second ADMISSION_CONTROLLER per campus, so that pairing is capped at one person and ACCOUNTANT is
the general case.

**Today, pre-T1:** brand reads *"🏫 Accountant"*, shell class is plain `shell`, **no tab bar in the
DOM at all**, and a 12-link accountant sidebar. The teacher app does not exist for this person on
any device. That is the bug.

**After T1:** they get the teacher shell at every width, and **the second job is not lost** —
`/me-more` is built from the person's *roles*, not a hardcoded teacher list, so it already renders
the lot. Observed verbatim: *Dashboard · My Classes · Exams & Results · Reports · Fees · Payment
submissions · School calendar · My Attendance · My Leaves · My Payslips*, plus Account. It moves
from "always in the sidebar" to "behind one tab".

Three decisions follow, all taken:

1. **The last tab is renamed "Me" → "More".** It is about to hold Dashboard, Fees, Payment
   submissions and Reports — a whole second job — under a person icon. The label is *already*
   slightly wrong for a plain teacher, since Exams & Results and School calendar are not personal
   either. "More" is honest in both cases and does not vary per user.
2. **A dual-role person lands on `/home`.** They are being given the teacher app, so starting them
   anywhere else contradicts the change, and Home is cheap to leave. ⚠️ **This changes existing
   behaviour**: `landingPath` keys off the same `primaryRole` as the shell, so an
   accountant-who-teaches who opens on `/dashboard` today will open on `/home` after T1.
3. **Four tabs stay four.** The second job lives in the grouped list behind the last tab rather
   than earning a tab of its own — the tab bar must not differ per person, or "learn it once"
   stops being true. A role switcher was considered and rejected as too heavy a concept for a small
   school where one person simply wears two hats.

**Consequence for T3:** the finance and admission screens will render inside the teacher shell — a
four-item sidebar beside a fees table. They will work; nobody has looked at them in that frame.

## 6. Risks

- **Removing the admin sidebar for teachers hides screens they currently reach in one click**
  (My Classes, Exams, Calendar, payslips). They move behind **Me** — one extra tap. Mitigated by
  Me being a permanent destination at both widths, never a hidden drawer.
- **A teacher-shaped desktop looks unfinished if T3 is skipped.** Four sidebar items next to a
  three-quarters-empty page reads as a bug, not a design. T3 is not optional trim.
- **`primaryRole` is load-bearing in more places than the shell** (`landingPath`, `panelLabel`).
  Changing precedence for the shell must not silently change where people land.

---

## 7. T0 as built — 2026-08-11

**Shipped:** `TeacherSidebarNav` alongside `TeacherTabs` in `components/teacher-tabs.tsx`, both
reading the same `tabsFor()` list; the shell renders the teacher sidebar instead of the grouped
admin nav when `usesMobileShell`; `test/e2e/teacher-shell.spec.ts` (2 cases).

### What changed

| | Before | After |
|---|---|---|
| Teacher @ 1440px | 8 admin links in 3 groups, **no `/home`** | **Home · Attendance · Week · Me** |
| Teacher @ 375px | Home · Attendance · Week · Me | unchanged |
| Getting back to Home on a laptop | browser back button only | a link, from every screen |
| Owner / other roles | 19 links, 6 groups | unchanged |

Verified live at both widths on `demo` with a throwaway teacher, and the owner re-checked at
1440px: still 19 links, 6 groups, `shell` without `has-tabbar`, no tab bar in the DOM at all.

### Why the desktop sidebar is four items and not ten

The obvious move is to hoist the six secondary screens into the sidebar because a laptop has room.
Rejected: **the phone's structure is the product's structure**, and spare pixels are a reason to
make things bigger, not to invent a second information architecture for the same person. Everything
else stays behind **Me**, exactly as on the phone, and the topbar keeps Security and Sign out above
720px so the sidebar does not need an account footer.

*If real use shows that costs a click too many, promoting the secondary list is a one-line change —
but it should be made because a teacher complained, not because there were spare pixels.*

### Proven non-vacuous

Reverting the shell to the pre-T0 behaviour (teacher gets the admin sidebar again) fails
**"a teacher gets the same four destinations on a phone and on a laptop"**. The second case asserts
the *other* direction — an owner still gets the grouped admin nav and no tab bar — because a change
scoped to one role is exactly the kind that quietly widens, and a suite that only ever looks at the
teacher would never see it.

### ⚠️ The suite now has zero login headroom, and it cost me a false failure

`teacher-shell` seeds a teacher and signs in, which takes the suite to **exactly 5 form logins per
run against the §29 limit of 5/IP/15min**. A clean run passes. Running one spec twice during
development and then the full suite does not — and the symptom is **not** a rate-limit error but a
30-second navigation timeout that reads as a broken feature. That is precisely what happened here:
`staff-attendance` failed in a full run, passed in isolation, and passed again in a full run once
the window drained. The tracker already records the same trap from an earlier design; it has simply
been re-approached from the other side. **Filed as its own task** — the fix is fewer logins (a
shared teacher `storageState` setup project), not a higher limit, because the limit is real
production behaviour worth testing against.

### Still open (T1–T4)

T1 (role precedence — decision taken, §5), T2 (the home screen with no timetable), T3 (desktop
layout for the teacher's cards), T4 (browser pass at 375/768/1440 and the brain).

---

## 8. T1 as built — 2026-08-11

**Shipped:** `usesMobileShell` → **`usesTeacherShell`** with the rule stated directly;
`landingPath` and `panelLabel` now follow it rather than `primaryRole`; the last tab renamed
**Me → More**; a third e2e case for the dual-role person.

### The rule, stated instead of inherited

```ts
const ADMIN_SHELL_ROLES = ['PLATFORM_ADMIN', 'OWNER_ADMIN', 'CAMPUS_ADMIN'];
usesTeacherShell = holds TEACHER && holds none of ADMIN_SHELL_ROLES
```

It used to be `primaryRole(roles)?.role === 'TEACHER'` — i.e. the answer fell out of the **ordering
of a list written for a different purpose**, in which TEACHER sits 7th. Anyone teaching *and*
keeping the books, running admissions or doing HR was silently excluded from the app built for
them, on a phone as well as a laptop. **A rule that matters should be written down, not implied by
an array's order.**

**`landingPath` and `panelLabel` follow the same function**, so the shell you see, the screen you
land on and the name in the corner cannot disagree about who you are. ⚠️ This is a **behaviour
change for existing accounts**: an accountant-who-teaches who opens on `/dashboard` today opens on
`/home` after this. That was the decision (§5a.2), not an accident.

### Me → More

The last tab is about to hold *Dashboard, Fees, Payment submissions, Reports* for a dual-role
teacher — a whole second job under a person icon. It was already slightly wrong for a plain
teacher, whose *Exams & Results* and *School calendar* are not personal either.

### Proven non-vacuous

Reverting `usesTeacherShell` to the old `primaryRole` rule fails
**"a teacher who also keeps the books still gets the teacher app"** — the case that could not have
existed before, because the behaviour it describes did not.

The dual-role case also asserts that **the accounting job is still reachable** under More
(Dashboard · Fees · Payment submissions · Reports). Without that, "give the teacher an app" could
quietly have meant "take the other half of their work away", and no test would have noticed.

### ⚠️ Two test-quality fixes made along the way

Both surfaced while probing, and both are about failures that lie:

1. **`waitForURL('**/home')` burned the full 30-second budget and then reported only "timeout".**
   Replaced with *wait for any redirect off `/login`*, then `toHaveURL(/\/home$/)` — which fails in
   ~5s with **"Expected /home, Received http://localhost:3001/dashboard"**. When this test breaks,
   the landing page *is* the question, so the failure has to name it.
2. **`apiSetupDelete` and `ctx.close()` threw during teardown after a failed test**, and Playwright
   reported *those* instead of the assertion that actually failed
   (`browserContext.cookies: Target page... has been closed`). Both are now best-effort.
   **Cleanup must never be the loudest thing in a failure** — chasing a teardown error while the
   real cause sits one line above is how an afternoon disappears.

### Still open (T2–T4)

T2 (the home screen naming the actual registers when there is no timetable), T3 (the teacher's
cards at desktop width — now including the finance and admission screens a dual-role person will
open inside the teacher shell), T4 (browser pass at 375/768/1440 and the brain).
