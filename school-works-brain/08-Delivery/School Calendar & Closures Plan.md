---
title: School Calendar & Closures Plan
type: plan
status: DECIDED 2026-08-05 (§6, all seven) — free/in-app path chosen; H0–H2 ready to build
created: 2026-08-05
scope: apps/api setup(holidays) + attendance + hr(payroll) · apps/web settings/calendar, dashboard · comms(SMS)
---

# School Calendar & Closures — plan

## 1. What is actually broken

Two different things get confused under "days off". One works, one has never worked at all.

**The weekly off works.** `weeklyOffDays` is a school setting, set by the owner on the settings
screen as day chips. One day, two days, three — the system does not care. Everything downstream
already honours it: student marking is refused, the coverage strip greys the day out, the
"registers not marked" chip stays quiet, the staff day-close skips it, and payroll excludes it
from working days.

**Holidays do not work — at all.**

> There is a `holidays` table. **Five places read it. Nothing anywhere writes it.**
> No endpoint, no service method, no screen, not even the seed. Every holiday lookup runs,
> finds nothing, and concludes it is a normal school day.

So today Eid is a working day, teachers get chased for not marking a register on a day the school
was shut, and **payroll counts the holiday as a working day** — which silently changes everyone's
per-day rate and therefore every absence deduction that month.

The read side is finished and waiting: screens already say *"{holidayName} — no register today"*.
The `campusId` column that lets one campus close while another stays open has simply never been
reachable. This is the inverse of the recurring "endpoint nobody calls" pattern — **a table
nobody can write.**

## 2. Two kinds of closure, one mechanism

| | Planned | Unplanned |
|---|---|---|
| Example | Eid, 14 August, winter break | Political unrest, a flood, a burst pipe, a funeral |
| Declared | Weeks ahead, in bulk | The night before, or *this morning* |
| Who | Owner, for the whole school | Whoever is awake — often the campus head |
| Notice needed | None; it is on the calendar | **Urgent, and it is the whole point** |

Both are the same row in `holidays`. What differs is *when* it is declared and *whether anyone
has to be told*. Building one mechanism and treating notification as a separate, explicit step
keeps the emergency case honest.

## 3. Declaring a closure

### 3.1 Who
- **OWNER_ADMIN** — any date, school-wide or a named campus.
- **CAMPUS_ADMIN** — their own campus only, never school-wide. This follows §22.8 exactly: a
  campus admin who could close the whole school could stop another campus's registers.
- Nobody else. A closure moves payroll.

### 3.2 The three time cases, and what each must not break

**Future date (the normal case).** Nothing exists yet. Write the row and stop.

**Today, before registers are marked.** Same as future.

**Today, after some registers are already marked** — the real emergency shape: the school opened,
something happened at 10:30, everyone goes home.

> **Rule: a closure never deletes attendance.** Rows already recorded stay exactly as they are.
> Declaring the day closed stops *further* marking and takes the day out of the payroll
> working-day count. It does not rewrite what a teacher observed, and it cannot un-send an
> absence SMS that has already gone to a parent.

Anything else means a teacher's morning register vanishes, or a parent who was told their child
was absent is never corrected. Both are worse than an inconsistent-looking day.

**A past date.** Allowed, because schools do reconstruct the calendar. Same rule: existing rows
survive.

### 3.3 The one hard refusal

**A closure that lands in a month whose payroll is already APPROVED must be refused.** Working
days feed the per-day rate, so adding a holiday to a settled month changes what everyone should
have been paid — and the payslips are already out. This is the same freeze that already protects
staff attendance (G1/G5), applied to the calendar.

The message has to name the way out: *"March payroll is approved. Record this closure, and it
will change what people were paid. Reverse the payroll run first."* — which today is impossible,
because payroll approval is one-way. Worth knowing before we promise it.

## 4. Telling people — the free path, decided 2026-08-05

### 4.0 The constraint that decided it

SMS is not billed per message here: every plan includes a **monthly credit allowance** —
BASIC 1,000 segments, PLUS 5,000, PRO 20,000 — refreshed on the 1st by the `sms-monthly-credit`
job. So the real question was never "can the school afford it" but **"what is the monthly
allowance spent on?"**

A 500-family closure broadcast is **~500 segments — half a BASIC school's entire month**, spent on
one message, competing with the daily absence alerts parents actually depend on.

> **Decision: closures send no SMS.** The notification path is in-app plus a WhatsApp-ready
> message the office copies. Zero credits. The SMS path is still built, but **off by default and
> behind a stated cost**, so the day a school is on PLUS it is one informed click.

### 4.1 The finding that shaped the in-app design

**Teachers have no dashboard.** `/dashboard` is `OWNER_ADMIN`/`CAMPUS_ADMIN`/`ACCOUNTANT` only; a
teacher lands on `/attendance`, staff on `/my-attendance`, a student on `/me`. So "show it on
their dashboard" reaches students and admins and **misses every teacher** — precisely the people
who need to know the gate is locked.

Building a teacher dashboard to carry one line is the wrong shape. Instead the notice goes in the
**app shell** (the sidebar+topbar layout wrapping every authenticated page):

- one implementation reaches teachers, staff, students, admins **and any role added later**;
- it does not depend on which screen someone happens to open;
- the shell already loads the user's context on every page, so it is close to free.

A slim strip under the topbar:

> 🔴 **School closed tomorrow — Eid ul Adha.** No classes, no attendance.

**Shown only when it is news: today or tomorrow.** A closure three weeks out belongs on the
calendar, not in a banner — a banner that is always there stops being read. **No per-user
dismissal in v1**: it needs storage to remember who dismissed what, and the banner retires itself
when the day passes.

### 4.2 Guardians — WhatsApp, not SMS

Guardians have **no logins** (contact records only; the parent portal was removed 2026-07-28), so
there is no screen to post a notice to. The channel that actually reaches them is the school's
existing **WhatsApp group**.

So the calendar screen offers **Copy message**, not Send:

> *Falcon School will be closed on Tue 12 Aug (Eid ul Adha). Classes resume Wed 13 Aug.*

The head pastes it into the group they already use. Zero credits, better reach than SMS, and we
are removing the retyping rather than replacing their habit.

### 4.3 Students
The shell banner, plus the same notice in context on `/me` — genuinely their home screen. No
separate channel; guardians are the contact of record.

### 4.4 The limitation, stated rather than discovered

**In-app reaches only people who open the app.** A closure declared at 21:00 for tomorrow is seen
by a teacher when they next open it — possibly on arrival at a locked school. In-app is right for
"I am in the system anyway" and is **not** a way to reach someone asleep.

That gap is real and is being accepted deliberately, not overlooked. The staff-SMS toggle (§6 D4)
is the answer when a school decides it is worth ~20 credits.

## 5. Phases

| # | Deliverable | Cost | Why this order |
|---|---|---|---|
| **H0** | Holiday CRUD (`POST`/`POST range`/`GET`/`DELETE /holidays`), campus-scoped, payroll-approved refusal, matrix rows | free | The write side that has never existed. Everything else is decoration without it |
| **H2** | `isNonWorkingDay` → returns the **reason and name**; the 4 surfaces that already ask stop saying "holiday or weekly off" and name the closure. **Plus the shell banner** (today/tomorrow) | free | Before H1 deliberately: once closures can exist, the screens must explain them *before* anyone is handed a button that creates them |
| **H1** | Calendar screen: list by year, add one, add a range, delete behind confirm, **Copy message** | free | A closure nobody can see is a closure nobody trusts |
| **H3** | `SCHOOL_CLOSED` template + guardian broadcast — **off by default**, cost shown before sending, deduplicated per phone; separate staff toggle | costs credits only when switched on | Last, and inert until chosen |

## 6. Decisions — all taken 2026-08-05

- **D1 — Campus admin may declare for their own campus.** ✅ **YES.** The emergency case is local
  (one campus floods) and the person on site knows first. Never school-wide — that stays the owner's.
- **D2 — A closure may be declared for today, after registers are marked.** ✅ **YES, and it never
  deletes attendance.** See §3.2.
- **D3 — Automatic SMS to guardians on a closure.** ✅ **NO.** Copy-to-WhatsApp instead (§4.2). The
  send exists but is off by default and states its credit cost.
- **D4 — Automatic SMS to staff.** ✅ **NO — a toggle, default off.** The arithmetic is honest and
  worth recording: ~20 staff ≈ 20 credits ≈ **2% of a BASIC month**, for the case where a teacher
  otherwise drives to a locked school. Good value, but the operator chooses it; nothing bills them
  by surprise.
- **D5 — The 100/hour manual-SMS cap vs a 500-family broadcast.** **Deferred with H3.** Not a
  blocker now: nothing sends.
- **D6 — Half-day closures.** ✅ **Out of scope for v1.** Attendance is per-session, so a half day
  is really "cancel the second session", which only matters for two-session schools.
- **D7 — Teacher dashboard vs shell banner.** ✅ **Shell banner.** §4.1.

## 7. Risks

| Risk | Mitigation |
|---|---|
| A closure silently changes an approved payroll | Refused outright (§3.3), naming the month and the reason |
| Siblings' families get three messages | Deduplicate by phone — applies to H3 only; the WhatsApp path is one message to one group |
| A closure is declared and nobody is told | The screen states plainly that **nothing has been sent**, and offers Copy message |
| An absence SMS already went out for a day now declared closed | Cannot be un-sent. Said in the confirm dialog rather than discovered afterwards |
| The banner becomes wallpaper | Shown only for today/tomorrow; a distant closure lives on the calendar |
| Someone assumes in-app reached everyone | §4.4 is stated on the screen, not just in this document |
