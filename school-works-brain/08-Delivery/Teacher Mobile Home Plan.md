---
title: Teacher Mobile Home Plan
type: plan
status: draft — awaiting operator decisions in §7
updated: 2026-08-08
---

# 📱 Teacher Mobile Home — plan

> Related: [[Notifications Plan]] · [[Attendance & Leaves]] · [[Progress Tracker]] · [[Key Decisions]]

## 1. The premise has to be corrected first

**There is no teacher dashboard.** `/dashboard` is `OWNER_ADMIN / CAMPUS_ADMIN / ACCOUNTANT`; a
teacher's post-login landing is `/attendance` — a *work screen*, opened cold with no idea which
section you wanted. So this is not a restyle. It is building the home a teacher never had, and
building it phone-first.

A teacher today gets eight nav entries and no starting point:

| | |
|---|---|
| **Academics** | Attendance · My Classes · Exams & Results |
| **Administration** | School calendar |
| **My Portal** | My Attendance · My Timetable · My Leaves · My Payslips |

Every one is a filing cabinet. None answers *"what do I do now?"*

**The spec already agrees.** Blueprint §3 on the frontend: *"responsive (teachers/parents are
mobile-heavy)"*. Mobile-first for this role is the spec being honoured, not a new direction.

## 2. What "mobile app UI" has to mean here, concretely

Not "the desktop page, narrower". The shell today is a **desktop layout that degrades**: a 220px
sidebar that becomes a slide-over drawer under 720px, and content built from tables. That is
responsive, which is not the same as mobile-first.

Four things separate the two, and each is a real change:

1. **Navigation lives at the bottom, not behind a hamburger.** A drawer costs two taps and hides
   where you are. Phone thumbs reach the bottom third; the top-left corner is the hardest point on
   the screen to hit one-handed.
2. **Cards, not tables.** Every table on a phone either scrolls sideways or shrinks past reading.
   The timetable grid is the honest exception — a week *is* a grid — and it gets a day-at-a-time
   view on small screens instead.
3. **One primary action per screen, thumb-height.** Not a toolbar of equals.
4. **Tap targets ≥ 44px, and state legible at arm's length** — a teacher reads this walking
   between rooms, not sitting down.

## 3. The design driver: a teacher's actual day

The home should answer a *different* question at 07:50, 11:15 and 16:30. That is the whole idea,
and everything below follows from it.

| When | What they need | Where it comes from |
|---|---|---|
| Arriving | Am I checked in? Is the school even open today? | `/staff-attendance/mine/check-in`, closure banner |
| Between periods | What is next, and where? | `/timetable/mine` |
| In class | Mark this register — for **this** section, not a picker | `/attendance` + timetable |
| End of day | What did I miss? | `/notifications` |
| Occasionally | Leave, payslip, my own attendance | existing pages |

**So the home is one screen with a "now" card at the top that changes through the day**, and a
short list underneath. Not a grid of tiles — tiles are a desktop shape, and a tile that reads `0`
is a tile that teaches you to stop looking.

## 4. The screen

```
┌─────────────────────────────┐
│ Good morning, Nadia      🔔2│   ← name + bell (bell already exists, N1)
├─────────────────────────────┤
│  🔴 School closed today      │   ← closure banner, only today/tomorrow (H2)
├─────────────────────────────┤
│  NOW                        │
│  Period 2 · Grade 9-A       │   ← the "now" card: derived from /timetable/mine
│  Mathematics · Room 3       │
│  ┌───────────────────────┐  │
│  │   Mark this register  │  │   ← ONE primary action, pre-scoped to this section
│  └───────────────────────┘  │
├─────────────────────────────┤
│  NEXT                       │
│  P3 · 9-B · Maths · Rm 3    │   ← rest of today, compact
│  P5 · 10-A · Maths · Lab 2  │
├─────────────────────────────┤
│  NEEDS YOU                  │
│  ⚠ 1 register not marked    │   ← /notifications, same source as the bell
│  ✓ Leave approved 6–7 Jul   │
└─────────────────────────────┘
│ 🏠 Home 📋 Attend 🕘 Week 👤 Me │  ← bottom tab bar, 4 items, thumb-height
```

**The "Mark this register" button is the point of the whole screen.** Today marking attendance is:
open Attendance → choose class → choose section → find the date. On a phone, mid-lesson. The
timetable already knows which section this teacher is standing in front of at this minute, so the
home can hand them the right register in one tap.

**Bottom tabs: four, never more.** Home · Attendance · Week · Me. Everything else (leaves,
payslips, exams, calendar) lives under **Me**, because those are visited monthly, not hourly.

## 5. What it needs from the backend: nothing new

Every figure already has an endpoint, and most shipped this week:

- `GET /timetable/mine` — today's periods in order, with room (2026-08-08)
- `GET /notifications` — what changed for me, already derived and role-shaped (2026-08-08)
- `GET /staff-attendance/mine/check-in` — including `wouldBe: 'LATE'`, so lateness is announced
  rather than sprung
- `GET /attendance/closure-notice` — already in the shell

**One possible addition, and only if the "now" card proves it:** the home makes 3–4 calls. If that
is slow on a 3G phone, a single `GET /teaching/home` composing them is the fix — but *measure
first*. Adding a composite endpoint before there is a number is how you end up maintaining two
paths to the same data.

## 6. Phases

- **M0 — the shell learns about phones.** Bottom tab bar under 720px (sidebar stays on desktop),
  safe-area insets for notched screens, 44px targets, `overflow-x` audit on every table.
  **Applies to all roles** — see §7.1.
- **M1 — the teacher home.** New route `/home`, teacher landing changes from `/attendance`. The
  "now" card, next-up list, and needs-you list. This is the phase that delivers the value.
- **M2 — the register on a phone.** The attendance marking grid is a wide table; on a phone it
  becomes a list of students with present/absent as a segmented control, and a sticky "Save" at
  thumb height. Pre-scoped when arrived at from the "now" card.
- **M3 — the rest, made narrow.** My Timetable → day-at-a-time on small screens with a day
  switcher; My Leaves, My Payslips, My Attendance → cards instead of tables.
- **M4 — installable (PWA), only if wanted.** Manifest + icons so "Add to home screen" gives a
  real app icon and no browser chrome. **No offline** — see §8.

## 7. Decisions needed

**7.1 — Does the mobile shell apply to every role, or only teachers?**
Recommendation: **every role.** An owner checks the school from a phone at the weekend, and an
accountant at a fee counter is on a desktop either way. Two shells means two places to fix every
layout bug, and the sidebar can simply remain the desktop presentation of the same nav.

**7.2 — Does the teacher's landing move from `/attendance` to `/home`?**
Recommendation: **yes**, and that is most of the point. Attendance stays one tap away in the tab
bar. Without this the home is a page nobody visits.

**7.3 — Installable app (PWA) now or later?**
Recommendation: **later, M4, and as a separate decision.** It changes how updates reach people —
a cached shell can serve a stale app after a deploy, which needs a version check and a "reload"
prompt to do safely. Worth having; not worth bundling into a UI change.

## 8. Out of scope, deliberately

- **Offline attendance marking.** Tempting — Pakistani school buildings have patchy signal — but
  it means a local queue, conflict rules when the office marked the same register meanwhile, and a
  sync UI. Attendance feeds pay and defaulter reporting; a silent merge conflict there is worse
  than a teacher waiting for a bar of signal. Revisit only with a real report from a pilot school.
- **Push notifications.** Already deferred in [[Notifications Plan]] §6 and unchanged by this.
- **A native app.** Nothing here needs one, and it doubles the delivery surface for a school that
  will access this through a browser link.
- **Redesigning the admin dashboard.** It is a desktop screen for a desktop job; M0 makes it
  *usable* on a phone, not rebuilt for one.

## 9. Risks

- **The "now" card is only as good as the timetable**, which nobody has filled in yet — the feature
  shipped 2026-08-08 with zero rows in every school. The card must degrade honestly: with no
  timetable it shows the next unmarked register instead, and says why it has nothing better.
- **Two navigation systems drifting.** Mitigated by both rendering from the same `NAV` array in
  `lib/roles.ts`; the tab bar is a filtered projection of it, never a second list.
- **Scope creep into "redesign the whole app".** M0 is a shell change and an overflow audit, not a
  visual redesign. The visual language stays as it is unless that is a separate, stated decision.
