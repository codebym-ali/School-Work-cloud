---
title: School Calendar & Closures Plan
type: plan
status: proposed — awaiting decisions (§6)
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

## 4. Telling people

There is no notification system in this product. There is **SMS**, and it costs real money per
message. So this section is mostly about not spending the school's money without asking.

### 4.1 Guardians — SMS, and never automatic

A 500-student school is 500 messages. **Declaring a closure must not send anything by itself.**
The flow is: declare → the screen says *"Tell 483 families? That is about 483 SMS (~2 credits
each)."* → the head decides.

`POST /comms/send` already exists (owner + campus admin, rate-limited 100/school/hour) but takes
**raw phone numbers** — the caller assembles the list. So this needs one new piece: resolve the
primary guardian phone for every active student in the closure's scope, deduplicated by number,
because siblings share a phone and a family should get **one** message, not three.

A new `SCHOOL_CLOSED` template rather than free text, so the message is consistent and
translatable: *"{schoolName} will be closed on {date} ({reason}). Classes resume as normal after."*

⚠️ The 100/hour manual-SMS limit is per school. A 500-student broadcast does not fit. Either the
closure broadcast gets its own policy or it is queued and drained — a decision, not an oversight.

### 4.2 Teachers and staff — in-app, not SMS

Teachers open the app every day; guardians do not. So teachers do **not** need an SMS, and paying
for one is waste. They need the app to say it plainly the moment they open it:

- the dashboard "Needs attention" panel gains the closure;
- `/attendance` refuses marking for that day and says **why** — *"School closed: Eid ul Adha"* —
  rather than the current generic "holiday or weekly off";
- `/my-attendance` says the same, so nobody wonders why check-in is refused.

All three already read `isNonWorkingDay`; they just need the holiday's **name** carried through
rather than a boolean. Cheap, and it is the difference between "the button is broken" and "the
school is shut".

### 4.3 Students
Nothing extra. Guardians are the contact of record, students have no phone in the system, and the
portal already shows the day as non-working once the row exists.

## 5. Phases

| # | Deliverable | Why this order |
|---|---|---|
| **H0** | Holiday CRUD (`POST/GET/DELETE /holidays`), campus-scoped, payroll-approved refusal, matrix rows | The write side that has never existed. Everything else is decoration without it |
| **H1** | Calendar screen: list by academic year, add one, add a range (winter break), delete. Named reason required | A holiday nobody can see is a holiday nobody trusts |
| **H2** | Carry the holiday NAME into the three screens that already ask "is this a working day" | Turns "you can't mark this" into "the school is closed for Eid" |
| **H3** | `SCHOOL_CLOSED` template + guardian broadcast with a **cost shown before sending**, deduplicated per phone | The urgent case. Deliberately last: sending is the part that spends money and cannot be undone |

## 6. Decisions needed

- **D1 — Can a campus admin declare a closure for their own campus?** Recommend **yes**. The
  emergency case is local (one campus floods) and the person on site is the one who knows.
- **D2 — Can a closure be declared for today after registers are marked?** Recommend **yes, and
  never delete**. See §3.2.
- **D3 — Should declaring a closure offer to SMS guardians?** Recommend **offer, never automatic**,
  with the message count and credit cost shown before the send. A school that is closing for a
  funeral should not discover it spent 500 credits.
- **D4 — Do teachers get an SMS too?** Recommend **no** — in-app only. Revisit if a school says
  its teachers do not open the app on a closure day, which is plausible and worth asking a pilot.
- **D5 — What happens to the 100/hour manual-SMS cap for a 500-family broadcast?** Needs an
  answer before H3: raise it for this template, or queue and drain over an hour.
- **D6 — Half-day closures** (school closes at 11:00). Recommend **out of scope for v1** —
  attendance is per-session, so a half day is really "cancel the second session", which only
  matters for two-session schools. Record and move on.

## 7. Risks

| Risk | Mitigation |
|---|---|
| A closure silently changes an approved payroll | Refused outright (§3.3), with the reason named |
| A broadcast fires twice | One `SCHOOL_CLOSED` send per holiday row, recorded on it; the second attempt says it already went |
| Siblings' families get three messages | Deduplicate by phone before queueing |
| A closure is declared and nobody is told | The screen states plainly that no message has been sent, and offers the send |
| An absence SMS already went out for a day now declared closed | Cannot be un-sent. Stated in the confirm dialog rather than discovered |
