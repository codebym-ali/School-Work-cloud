---
title: Teacher App Shell Plan (one navigation, both widths)
type: plan
status: drafted 2026-08-11 — decisions taken, not yet built
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

- **T0 — one navigation, two renderings.** `TEACHER_TABS` becomes the single source of truth for
  both. A `TeacherNav` component renders it as the bottom bar ≤720px and as the teacher sidebar
  above; the admin sidebar stops rendering for a teacher at any width. `/home` and `/me-more` stop
  being orphans. **Fixes 1.1 and 1.2.**
- **T1 — the teacher shell follows the person, not the role table.** A user holding TEACHER gets
  the teacher shell even when they also hold another role, with the second role's screens reachable
  from **Me**. Needs one decision (§5). **Fixes 1.3.**
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

## 5. Decision needed before T1

**Which shell does a teacher who also holds an administrative role get?** Options:

1. **Teacher shell wins for anyone holding TEACHER** — simple rule, and the teaching job is the one
   done between rooms on a phone. Risk: an owner who is also formally a teacher would lose the
   admin sidebar, so this needs a carve-out for the two admin roles.
2. **Teacher shell unless they hold an admin role** (OWNER_ADMIN / CAMPUS_ADMIN) — teacher beats
   ACCOUNTANT, ADMISSION_CONTROLLER, HR_MANAGER, but never beats a school-wide administrator.
   *Recommended:* it fixes Ayesha's case, which is the realistic one, without stranding an owner.
3. **Let the user choose**, remembered per account. Most flexible, most to build, and a preference
   nobody sets is a preference that does nothing.

## 6. Risks

- **Removing the admin sidebar for teachers hides screens they currently reach in one click**
  (My Classes, Exams, Calendar, payslips). They move behind **Me** — one extra tap. Mitigated by
  Me being a permanent destination at both widths, never a hidden drawer.
- **A teacher-shaped desktop looks unfinished if T3 is skipped.** Four sidebar items next to a
  three-quarters-empty page reads as a bug, not a design. T3 is not optional trim.
- **`primaryRole` is load-bearing in more places than the shell** (`landingPath`, `panelLabel`).
  Changing precedence for the shell must not silently change where people land.
