---
title: Admission Form — field gaps for Pakistani private schools
type: analysis
status: Tier 1 SHIPPED 2026-09-07 (all but the photograph) · Tiers 2–3 open
updated: 2026-09-07
---

# What a real admission form asks that ours does not

**Operator ask (2026-09-06):** *"analyse this form as a senior admission controller based on Pakistani
schools — what student admission details are missing and required to admit a new student."*

Reviewed against the live **Admit a student** screen (`packages/school-ui/src/app/admissions/direct-admission.tsx`),
the write contract (`CreateStudentDto`), and the `Student` / `ParentProfile` models — so the gaps below
are separated into *missing from the form* vs *missing from the system entirely*, which is the
difference between an afternoon and a migration.

## What we capture today

Campus · Class · Section · Full name · Gender · Date of birth · CNIC/B-Form (optional) ·
Roll number (optional) · **one** guardian (name, phone, CNIC, email, relation).

**Verdict: that is a seating record, not an admission record** — roughly 40% of a real form. It is
enough to put a child in a section and text one adult. It is not enough to produce a board form, a
leaving certificate, or to know who to call when a child is hurt and the one number is unanswered.

## Tier 1 — required (an admission is incomplete without these)

| Field | Why a Pakistani school needs it | Schema reality |
|---|---|---|
| **Photograph** | ID cards, board/registration forms, the register the class teacher actually recognises faces from | ⚠️ **Corrected 2026-09-07:** `Student.photoKey` exists but is a **dead column** — zero references in API or UI. Needs the full upload pipeline (presign → scan → promote → signed read), **not** a wire-up |
| **Religion** | Decides **Islamiat vs Ethics** streaming; it is a printed field on provincial board forms | ✅ **SHIPPED** — `students.religion`, free text (not an enum) |
| **Current/residential address** | Transport routing, leaving certificates, home visits, legal correspondence. **Absent entirely** | ✅ **SHIPPED** — `students.address_line` |
| **City / district / area** | Board forms; the address is not one free-text line in practice | ✅ **SHIPPED** — `students.city` (district deferred; nobody has asked) |
| **Father: name · CNIC · occupation · mobile** | The CNIC is the legal parent identifier and links to the child's B-Form | ✅ **SHIPPED** — `guardians[]` + `parent_profiles.occupation` |
| **Mother: name · CNIC · occupation · mobile** | Increasingly required on board forms; and she is often the reachable parent | ✅ **SHIPPED** — second block on the form, sent in one atomic admit |
| **Guardian (only if not a parent): name · relation · CNIC · contact** | Real for hostel/expat/orphan cases | ✅ **SHIPPED** — “+ Add another guardian”, up to 4 |
| **Emergency contact: name · relation · phone** | ⚠️ **Deliberately distinct from the fee-paying guardian.** When a child is injured you call whoever answers, not whoever pays | ✅ **SHIPPED** — three columns on `students`, NOT a guardian row (keeps them out of fees/SMS) |
| **Admission date / date of joining** | Office-set, **not** `createdAt`: it drives fee proration and seniority, and back-dated admissions are normal | ✅ **SHIPPED** — needed **no** column: `StudentEnrollment.startedAt` existed and was never settable |
| **Academic session being admitted into** | Mid-year admissions are the norm; the enrolment must name its year | ✅ **SHIPPED** — shown on the form (not chosen: the server always uses the current year) |

### ⚠️ The guardian problem is structural, and it is the real work here

The form takes **exactly one guardian**. You cannot record Father *and* Mother at admission — which is
the normal case, not an edge case.

Three separate facts, easy to conflate:
1. **The data model already supports many guardians** (`StudentGuardian` join, `AddGuardianDto`,
   `POST /students/:id/guardians`). So this is not a schema problem.
2. **That endpoint has no UI at all** — it sits in `route-coverage`'s `MISSING_UI_BACKLOG`. So today a
   second parent can only be added by an API call.
3. **`ParentProfile` has no `occupation`** (and no address) — that part *is* a migration.

So "Father + Mother" is mostly a **form + missing-screen** problem with one small column added, not a
redesign. Fixing it also closes a listed backlog item.

## Tier 2 — strongly recommended

**Previous academic history** — required for any *transfer* admission, i.e. most admissions above KG:
previous school · last class passed · last result (% or grade) · reason for leaving · **School Leaving
Certificate (SLC) received?**

**Welfare & records** — blood group · **medical conditions / allergies / disability / special needs**
(duty of care; the school is liable) · nationality (defaults Pakistani) · permanent address where it
differs from current.

**Documents & consent** — a received/not-received checklist (B-Form or CNIC copy, photographs,
previous SLC, birth or vaccination record) and the **parent declaration / terms acceptance**. Admission
is normally *gated* on these, and "we never got the B-Form" is discovered at board-registration time
when it is far too late.

## Tier 3 — conditional

Fee category / concession / scholarship / **sibling discount** (the bracket is set at admission) ·
sibling already enrolled (link, for household + discount) · admission type (New vs Transfer;
day-scholar vs boarder) · transport required + route/stop *(only if the school runs transport)* ·
hostel *(only if it has one)* · place of birth · mother tongue.

## Suggested phasing

1. **Quick wins, no migration** — ✅ **SHIPPED 2026-09-07: the joining date + the session label.**
   > ⚠️ **The photograph was wrongly on this list and has been moved out.** `Student.photoKey` exists,
   > but it is a **dead column** — zero references anywhere in the API or the UI. There is no upload
   > endpoint, no scan/promote step and no serve path, so it needs the whole pipeline the fee-proof
   > upload has (presign → ClamAV → promote → signed read), not a wire-up. It is its own piece of work.
   >
   > ✅ **The joining date needed no column either** — `StudentEnrollment.startedAt` already existed with
   > a `now()` default and was simply never settable. So the office-set date lands there rather than on
   > a new `admissionDate` column, which would have created a second source of truth for "when did they
   > join". A **future** date is refused (422), not clamped: the enrolment drives fee proration and the
   > register, and silently moving it to today would hide a keying error until it surfaced as a wrong
   > invoice weeks later.
   >
   > ✅ **The session is shown, not chosen.** The server always enrols into the current academic year
   > (`requireCurrentYearId`), so a picker would have been a control that silently does nothing.
2. **One migration, high value** — ✅ **SHIPPED 2026-09-07** (`20260907120000_admission_record_fields`):
   religion, address/city, the emergency contact, and `parent_profiles.occupation`; plus the
   **multi-guardian admit**.
   > **What the guardian work actually needed.** The many-guardian *shape* was already modelled, so
   > the missing piece was a way to send more than one **at admission**: `CreateStudentDto.guardians[]`
   > (capped at 4), resolved **before** the student row is written and linked inside the same request
   > transaction, with the **first as primary** — the one every SMS and fee receipt resolves. The old
   > single `guardian` field stays for CSV import and the pipeline admit, so nothing else moved.
   >
   > ⚠️ **A household that shares one phone still resolves to ONE parent record.** `resolveParent`
   > refuses to CREATE a second profile on an existing phone (“link instead of creating”), and the
   > join is unique on (student, parent) — so Father and Mother on the same number is a 409, by
   > design. The form now says which button fixes it (“use Find on that guardian to link them”).
   >
   > ⚠️ **`POST /students/:id/guardians` still has no UI** — adding a parent *after* admission remains
   > in `MISSING_UI_BACKLOG`. This slice closed the admission-time half only.
3. **Tier 2** — previous school block, medical/blood group, documents checklist + declaration.
4. **Tier 3** — only what this school actually operates (transport/hostel), never speculatively.

## What NOT to do

⚠️ **Do not put all of this on one screen.** The current form's virtue is that a walk-in can be seated
in under a minute — the reason `guardian` is optional at all (`CreateStudentDto`: a walk-in can be
admitted now and the guardian recorded later, with `hasGuardian` surfacing the gap so it gets chased).
A thirty-field wall would destroy that and be half-filled with junk. The pattern that survives contact
with a front desk is **admit fast, then complete the record** — the same "flag the gap and chase it"
shape already used for the missing guardian, extended to a completeness indicator on the student
profile.

Related: [[Enrollment & Admissions]] · the missing-UI backlog in `test/integration/route-coverage.e2e-spec.ts`.
