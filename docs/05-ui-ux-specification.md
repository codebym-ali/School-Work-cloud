# UI/UX Specification — v1.0

**Product:** Multi-Tenant School Management System
**Document:** 05 — UI/UX Specification
**Audience:** Frontend Engineers · UX Designers · Product Managers
**Authority:** Conforms to `docs/consistency-register.md` (v1.0, LOCKED) and `school-management-master-blueprint.md` (v2.0) §28 (screens), §5 (roles), §25/App-A (errors). Screen names are used **verbatim** from §28. Where this document would conflict with the register, the register wins.

---

## 1. Design System Rules

Global rules applied to **every** screen (§28).

| Rule | Requirement |
|---|---|
| **Responsive** | Mobile-first. Teachers and parents are phone-majority users; their screens are designed for a 360px viewport first, then scaled up. Wide tables scroll horizontally inside their own container — the page body never scrolls sideways. |
| **Accessibility** | WCAG 2.1 AA: semantic HTML, full keyboard navigation, 4.5:1 contrast minimum, visible focus states, every input has a `<label>`, ARIA only where semantics are insufficient. |
| **Timezone** | All dates/times display in **Asia/Karachi** (fixed in v1). Date inputs submit ISO dates in school TZ. |
| **Loading** | Every list and data panel has a **loading skeleton** (not a spinner-only screen). |
| **Empty** | Every list has an **empty state** with a one-line explanation and a **primary action** (e.g. "No invoices yet — Generate a batch"). |
| **Error** | Every data view has an **error state with retry**, and the generic error surface displays the **`requestId`** for support. |
| **Destructive actions** | Waive, reverse, publish, promote, withdraw, delete → **confirmation dialog** stating the consequence, and requiring the **reason** wherever the API requires one. |
| **Forms** | Submit is **disabled while pending**; field-level **422** `details` render inline against the named field; the form never silently drops a server validation error. |
| **Currency** | Money renders with thousands separators and 2 decimals (PKR), right-aligned in tables, tabular figures. Bound to the API's string `Money` type — never parsed as a float. |
| **Confirm copy** | Confirmation dialogs name what happens ("Publish results — parents will be notified by SMS"), and the confirm button says the verb ("Publish"), followed by a success toast in past tense ("Published"). |

---

## 2. Screen Inventory by Role

Screen names are verbatim from §28. Each screen lists: **Goal**, **Key components/data**, **Mobile**, **A11y**. Screens shared across roles (auth, system pages) are listed once at the end.

### 2.1 OWNER_ADMIN / CAMPUS_ADMIN
> CAMPUS_ADMIN sees the same screens **scoped to their campus** (CampusScopeGuard force-injects the `campusId` filter); they cannot manage campuses themselves or grant roles above TEACHER/STAFF/ACCOUNTANT.

| Screen (verbatim) | Goal | Key components / data | Mobile | A11y |
|---|---|---|---|---|
| **dashboard** | See school health at a glance | Cards: enrollment count, today's attendance %, month collections vs target, defaulter count, pending leaves, failed SMS count — **each card links through** | Cards stack single-column; numbers stay legible | Cards are links with descriptive labels, not bare numbers |
| **school setup wizard** | Configure a new school end-to-end | Stepper: year → campuses → classes/sections → subjects → fee heads/structures → grade scale → templates | One step per screen; sticky Next/Back | Step state announced; each step is a labeled fieldset |
| **academic-year & promotion screen** | Promote a section to next year | Section-by-section grid with per-student overrides, precondition warnings, batch-job progress | Grid → per-student cards; progress bar pinned | Precondition warnings are text + icon, not color alone |
| **admissions pipeline** | Move inquiries to admitted | Kanban by status; inquiry detail (test scheduling/scoring, reject/withdraw with reason); admit form with guardian-match step (§8) | Kanban → status-filtered list; drag replaced by status action | Kanban columns keyboard-reorderable; status is labeled |
| **student directory** | Find a student fast | Search (name-trigram OR exact GR OR guardian phone) + filters (campus/class/section/status); paginated list (max 100) | Filters in a collapsible sheet; sticky search | Search has a label; results announce count |
| **student profile** | See everything about a student | Tabs: info, guardians, enrollment history, attendance, results, fee ledger, documents | Tabs → horizontally scrollable tab bar | Tabs are ARIA tablist; each panel focusable |
| **attendance overview & post-window edit** | Fix locked attendance | Read grid + post-window edit (reason-required, admin only) | Grid scrolls horizontally in its own container | Reason field required + labeled; edit writes audit |
| **leave approval queues** | Approve/reject leaves | Student & staff queues; approve/reject with reason | Queue cards; swipe-free explicit buttons | Reject reason required inline |
| **exams** | Define and publish results | Definitions per term with **weightage-sum indicator**, publish screen showing completeness gaps, post-publish correction flow | Definition list; publish gate as a checklist | Weightage indicator is numeric + status text |
| **reports hub** | Export the seven reports | The seven §24 reports with export buttons (json/csv/pdf) | Report cards; export in a menu | Export format is a labeled select |
| **users & roles** | Manage staff/parent accounts | User list; role editor (CAMPUS_ADMIN limited to ≤ TEACHER/STAFF/ACCOUNTANT); unlock/disable | List → cards; role chips | Role changes confirm + audit |
| **teacher assignments & timetable editor** | Assign teachers, build timetable | Assignment table; timetable grid with **clash warnings** (409 on clash) | Grid scrolls; clash banner sticky | Clash warning is text + icon |
| **SMS center** | Send and monitor SMS | Templates (placeholder preview + segment counter), manual send (recipient query builder), credit balance, **failed-messages queue with retry** | Composer full-screen; segment counter live | Segment/credit estimate announced before send |
| **audit log browser** | Investigate changes | Filter by user/action/entity; **old→new diff view** | Diff stacks vertically | Diff uses labeled old/new regions, not color alone |
| **settings** | Adjust school settings | `SchoolSettings` form (Zod-validated; unknown keys rejected) | Sectioned accordion | Each setting labeled with helper text |

### 2.2 ACCOUNTANT
| Screen (verbatim) | Goal | Key components / data | Mobile | A11y |
|---|---|---|---|---|
| **fee counter** | Collect a payment quickly | Student lookup by GR/name/phone → open invoices → collect with method/ref → **print receipt** | Single-column flow; large tap targets; receipt print/share | Method + ref inputs labeled; receipt has a text summary |
| **invoice batch generation** | Generate monthly invoices | Class/month/year form with **duplicate-safe messaging** (`alreadyExists: true`) | Simple form; progress feedback | "Already generated" message is text, not just a toast |
| **defaulters list** | Chase unpaid dues | Defaulter list (campus, minDays) with **bulk-reminder SMS** | List → cards; multi-select persists | Selection count announced; bulk action confirmed |
| **advances/credits** | Manage guardian credits | Deposit advance; view `GuardianCredit` ledger | Ledger scrolls; running balance pinned | Amounts labeled deposit/applied/refund |
| **reversal request** | Request a payment reversal | Reversal form (reason required; OWNER_ADMIN approves) | Simple form | Reason required; states "pending OWNER_ADMIN approval" |
| **daily collection report** | Reconcile the day | Collections by method/collector; export | Table scrolls horizontally | Totals in a summary row |
| **financial dashboard** | Track money | Collection KPIs (financial-scoped) | Cards stack | KPI cards are labeled links |

### 2.3 TEACHER
| Screen (verbatim) | Goal | Key components / data | Mobile | A11y |
|---|---|---|---|---|
| **my sections/timetable** | See what I teach | Assigned sections + timetable | Timetable scrolls; today highlighted | Timetable cells labeled day/period/subject |
| **attendance marking grid** | Mark a whole section fast | **Whole-section single screen**, **ON_LEAVE cells locked**, **conflict banner** (409 ATTENDANCE_CONFLICT) | One row per student; sticky save; big status toggles | Locked cells announce "on leave"; conflict banner focusable |
| **marks entry grid** | Enter marks for one exam+subject | Per (exam, subject) grid with **absent toggle** and **per-row validation** (marks ≤ total) | One row per student; inline errors | Absent toggle labeled; per-row error tied to the cell |
| **my students** | Look up my students | Roster for assigned sections | Cards | Names are links |
| **homework** *(v1.5)* | — | Deferred to v1.5 | — | — |
| **own leaves** | File/track my leave | Leave form + status list | Simple form | Overlap error (409) shown inline |
| **own payslips** | View my pay | Payslip list (self only) + PDF | List → cards | Payslip PDF has a text summary |

### 2.4 PARENT
| Screen (verbatim) | Goal | Key components / data | Mobile | A11y |
|---|---|---|---|---|
| **children switcher** | Switch between children | Child selector (GuardianOfStudentGuard) | Prominent top selector | Selector is a labeled combobox |
| **attendance calendar** *(per child)* | See attendance | Calendar with PRESENT/ABSENT/LATE/HALF_DAY/ON_LEAVE | Month view; swipe months | Status conveyed by label + icon, not color alone |
| **published results & report-card downloads** *(per child)* | See results | Published-only results; report-card PDF via pre-signed URL | Cards; download/share | "Results available after publishing" empty state |
| **fee invoices** *(per child)* | Understand dues | Invoices with paid/pending state; v1 shows **"pay at counter/bank"** info (online pay is v2) | Invoice cards; status chips | Status chip labeled; amount tabular |
| **leave request** *(per child)* | Request child leave | Leave form (date range, reason) | Simple form; date range picker | Overlap (409) inline |
| **documents** *(per child)* | Get certificates | Document list; pre-signed download | Cards | Download labeled with doc type |
| **profile with phone verification** | Verify my number | Profile + **phone verification** (OTP) | Simple; OTP entry | Explains why verification matters (SMS delivery) |

### 2.5 STUDENT
| Screen (verbatim) | Goal | Key components / data | Mobile | A11y |
|---|---|---|---|---|
| **read-only mirror of the parent child-view for self** | See own info | Attendance, published results, invoices, timetable (self, SelfGuard) | Same as parent per-child, single child | Read-only; no action buttons rendered |

### 2.6 STAFF (non-teaching)
| Screen (verbatim) | Goal | Key components / data | Mobile | A11y |
|---|---|---|---|---|
| **own attendance** | See my attendance | Staff attendance (self) + check-in/out | Simple | Check-in/out labeled with timestamps |
| **own leaves** | File/track leave | Leave form (type/quota) + status | Simple | Quota→UNPAID auto-flag explained inline |
| **own payslips** | View my pay | Payslip list (self) + PDF | Cards | PDF text summary |

### 2.7 PLATFORM_ADMIN — Vendor console (`admin.platform.pk`)
| Screen (verbatim) | Goal | Key components / data | Mobile | A11y |
|---|---|---|---|---|
| **tenant list/provisioning wizard** | Onboard a school | School list; provisioning wizard (School + first campus + OWNER_ADMIN invite + seeded templates/settings) | Wizard steps | Subdomain uniqueness error inline |
| **plan & SMS credit management** | Manage plans/credits | Plan tier; SMS credit top-up | Simple forms | Ledger deltas labeled |
| **suspend/reactivate** | Control tenant access | Suspend/reactivate (cache-invalidated) | Confirmation dialog | States "school users see 403 immediately" |
| **support sessions** | Break-glass access | Create support session (reason, 4h expiry, visible to OWNER_ADMIN) | Simple form | Reason required; audit `SUPPORT_SESSION_STARTED` |
| **platform analytics** | Cross-tenant view | Aggregate metrics | Charts scroll | Chart data available as a table |
| **export trigger** | Export a tenant | Trigger tenant-export | Simple | Progress feedback |

### 2.8 Shared — Auth & System pages (all roles)
| Screen (verbatim) | Goal | Notes |
|---|---|---|
| **login (+MFA step)** | Sign in | Two-step when MFA enabled (mandatory for OWNER_ADMIN/ACCOUNTANT); generic error (no user enumeration) |
| **forgot/reset password** | Recover access | Reset via 30-min token; min-10-char + pwned check inline |
| **first-time set-password (invite link)** | Activate account | From INVITED; 30-min invite token |
| **locked-account screen** | Explain lockout | After 10 failures; states self-heal in 15 min or contact OWNER_ADMIN |
| **403 tenant-suspended page** | Truthful error | School-facing, truthful (from `TENANT_SUSPENDED`, not a 404) |
| **maintenance-mode page** | Planned downtime | Static, informative |
| **generic error page** | Unexpected failure | Displays `requestId` for support |

---

## 3. Critical User Journeys

Step-by-step flows (not wireframes). Each step names the screen, the API touchpoint, and the outcome.

### 3.1 Accountant collects a fee and prints a receipt
1. On **fee counter**, look up the student by GR / name / guardian phone (`GET /students?search=`).
2. Select the student → open invoices load (`GET /fees/invoices?studentId=&status=`); any auto-applied advance/credit is already reflected.
3. Choose an invoice → enter `amountPaid`, `method`, and `transactionRef` (required for non-CASH).
4. Submit. The client generates and sends an **`Idempotency-Key`** (UUID) with `POST /fees/invoices/:id/payments`.
5. Server (one serializable transaction) locks the invoice, validates `amountPaid ≤ remaining`, assigns a gap-free `receiptNo`, updates `paidAmount`/status → **201** with the printable receipt.
6. Receipt renders; user prints/shares. A **FEE_RECEIPT** SMS is enqueued to the primary guardian.
- **Edge — overpayment:** `422 OVERPAYMENT_USE_ADVANCE` → banner: "Amount exceeds what's due. Record the extra as an advance instead." with a link to **advances/credits**.
- **Edge — double-click / retry:** same key + same body → **200** replay of the same receipt (no double charge). Same key + different body → `409 IDEMPOTENCY_KEY_REUSED`.

### 3.2 Teacher marks attendance and resolves a conflict
1. On **my sections/timetable**, pick today's section → **attendance marking grid** loads the whole section on one screen.
2. Cells already `ON_LEAVE` (from an approved leave) are **locked** and cannot be changed.
3. Set each student PRESENT/ABSENT/LATE/HALF_DAY; submit `POST /attendance/bulk`.
4. Server upserts per (enrollment, date, session) → **200** `{ succeeded, failed, errors[] }`; per-row failures render inline.
5. Newly-ABSENT students trigger one absence-SMS each (deduped `absence:{enrollmentId}:{date}`), to primary guardians, skipping ON_LEAVE/opt-out/unverified.
- **Conflict:** a co-assigned teacher already saved different values → `409 ATTENDANCE_CONFLICT` → a **conflict banner** lists the diffs. The teacher cannot silently overwrite; resolution is by CAMPUS_ADMIN/OWNER_ADMIN via **attendance overview & post-window edit** (reason required, audited).
- **Edge — locked window:** editing after `attendanceEditWindowDays` (default 3) → `422 ATTENDANCE_LOCKED`; the grid shows the cell as read-only with an "admin only" note.

### 3.3 Admin promotes a section to the next academic year
1. Precondition: the next `AcademicYear` and its class/section structure exist (clone-from-previous tool in **school setup wizard**).
2. On **academic-year & promotion screen**, pick a section → grid defaults every student to the next class (by `Class.order`).
3. Override per student to RETAINED or WITHDRAWN as needed; **precondition warnings** flag students missing a published final-term report card or with unpaid invoices (if `promotionRequiresFeeClearance`).
4. Submit `POST /promotions {sectionId, targetYearId, overrides[]}` → **202** with a `batchId`.
5. Progress polls `GET /promotions/:batchId`; the queued idempotent job closes old enrollments and creates new ACTIVE ones, resumable and skip-if-done.
- **Edge — precondition block:** a blocked student needs an OWNER_ADMIN **override with reason** (audited `PROMOTION_OVERRIDE`); CAMPUS_ADMIN cannot override.
- **Edge — capacity:** target section full under `sectionCapacityMode = HARD` → `422 SECTION_FULL`; under ADVISORY it warns but proceeds.

### 3.4 Parent views a published report card and downloads the PDF
1. On **children switcher**, select the child.
2. Open **published results & report-card downloads** → only **PUBLISHED** results are visible (unpublished show an empty state: "Results will appear here once published").
3. Tap the term's report card → client calls `GET /students/:id/report-cards` then `GET /documents/:id/url`.
4. The server returns a **10-minute pre-signed URL** after an ownership check (GuardianOfStudentGuard); the PDF opens/downloads.
- **Edge — corrected result:** after a post-publish correction, the PDF is regenerated and a "Corrected" SMS is sent; the parent sees the latest version on next load.

### 3.5 Admission officer admits a student from an inquiry (with guardian match)
1. On **admissions pipeline**, open an inquiry in `ENTRY_TEST_PASSED` (or admit directly if the school skips tests).
2. Open the **admit form** → fill student fields; GR number is auto-suggested (AUTO mode) or entered manually (MANUAL mode).
3. **Guardian-match step (§8):** the form searches existing `ParentProfile` by normalized phone and shows any match ("Link to existing parent Ali Khan? Their children: …"). The officer makes an **explicit choice: link or create** — the system **never auto-merges**.
4. Submit `POST /admissions` (one transaction): guardian resolution → `Student` → `StudentGuardian` (exactly one primary) → ACTIVE `StudentEnrollment` in the current year → `Admission` (inquiry → ADMITTED) → admission invoice if an ADMISSION-type fee structure exists.
5. **201** returns the student, enrollment, and any invoice. A new parent (created, not linked) gets an **ACCOUNT_INVITE** SMS with a 30-min set-password link.
- **Edge — GR taken:** `422 GR_NUMBER_TAKEN` → inline error on the GR field.
- **Edge — age band:** DOB outside `Class.minAgeYears/maxAgeYears` → `422` with the age-band message.
- **Edge — bad transition:** admitting from a non-admissible status → `409 INVALID_STATE_TRANSITION`.

---

## 4. Form Specifications

Validation patterns, wired to class-validator DTOs server-side and mirrored client-side. Client validation is a UX convenience; the server is authoritative.

| Field | Pattern / rule | UI behavior |
|---|---|---|
| **GR number (AUTO)** | Server-sequenced from `School.nextGrNumber` + `grPrefix`; read-only in the form | Show the next value greyed out; "assigned automatically" helper |
| **GR number (MANUAL)** | Free text; unique `[schoolId, grNumber]` | Editable; on submit, `422 GR_NUMBER_TAKEN` maps to inline "This GR number is already used." |
| **CNIC** | Pakistani CNIC `#####-#######-#` (13 digits); guardian PII, encrypted at rest | Masked input; format-as-you-type; never echoed back in full once saved |
| **Phone** | Normalized **E.164** (`+92…`); stored normalized | Country prefix helper; normalize on blur; used for guardian match |
| **Email** | Standard email; unique `[schoolId, email]` | Inline uniqueness error on `409` |
| **Password** | Min **10** chars; checked against HaveIBeenPwned (soft-fail if API down) | Strength + "found in breaches" inline; never blocks on API outage |
| **MFA code** | 6-digit TOTP or a single-use recovery code | Numeric input; auto-advance |
| **Dates (academic)** | Constrained to the selected **academic year** range; no future dates for attendance | Date picker min/max bound to the year; holidays/weekly-offs disabled unless `allowHolidayOverride` |
| **Leave range** | `toDate ≥ fromDate`; no overlap with existing PENDING/APPROVED | Range picker; `409 LEAVE_OVERLAP` → inline banner |
| **Marks** | `marksObtained ≤ totalMarks`; `isAbsent` ⇒ marks empty | Per-row inline error; absent toggle clears + disables the marks cell |
| **Weightage** | Sum across a class's term exams must equal **100** | Live sum indicator; generation blocked with `422 WEIGHTAGE_SUM_INVALID` |
| **Amount (money)** | `Decimal(12,2)`; positive; `amountPaid ≤ remaining` | String-bound money input; thousands separators; overpayment → advance CTA |
| **Transaction ref** | Required for all non-CASH `PaymentMethod`; unique `[schoolId, method, transactionRef]` | Conditionally required; duplicate → inline error |
| **Reason (destructive)** | Required on waive/reverse/post-window edit/promotion override/withdrawal override | Required textarea inside the confirmation dialog |
| **Settings (SchoolSettings)** | Zod-validated; **unknown keys rejected** | Unknown/invalid key → `400`/`422` mapped to the specific field |

---

## 5. Error State Mapping

Maps stable machine codes (Appendix A + pipeline) to user-facing copy and the UI action. Copy is plain, actionable, and never exposes internals; the generic surface always keeps the `requestId`.

| Code | HTTP | User-facing message | UI action |
|---|---|---|---|
| `TENANT_SUSPENDED` | 403 | "This school's account is suspended. Please contact your administrator." | Render the **403 tenant-suspended page** (truthful, not a 404). |
| `TENANT_MISMATCH` | 403 | "Something's off with your session. Please sign in again." | Force logout → **login**. |
| `INVALID_STATE_TRANSITION` | 409 | "That action isn't allowed from the current status." | Disable the invalid action; refresh the entity's status. |
| `ATTENDANCE_CONFLICT` | 409 | "Another teacher already recorded different attendance." | Show the **conflict banner** with the diff; route resolution to an admin. |
| `ATTENDANCE_LOCKED` | 422 | "This attendance is locked. Only an admin can edit it now." | Make cells read-only; show "admin only" note. |
| `RESULTS_INCOMPLETE` | 422 | "Some marks are missing. Complete these before publishing." | List the missing (student × subject) rows returned by the server. |
| `WEIGHTAGE_SUM_INVALID` | 422 | "Exam weightages must add up to 100% for this term." | Highlight the live sum; block generate/publish. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | "This looks like a different request with a reused key. Please retry." | Regenerate the key and re-submit; never silently double-post. |
| `OVERPAYMENT_USE_ADVANCE` | 422 | "Amount exceeds what's due. Record the extra as an advance." | Banner with a link to **advances/credits**. |
| `SECTION_FULL` | 422 | "This section is full." | Block enroll/promote (HARD mode); offer another section. |
| `GR_NUMBER_TAKEN` | 422 | "This GR number is already used." | Inline error on the GR field. |
| `LEAVE_OVERLAP` | 409 | "This overlaps an existing leave request." | Inline banner on the date range. |
| `INSUFFICIENT_SMS_CREDITS` | 422 | "Not enough SMS credits for this send." | Block non-critical sends; link to **plan & SMS credit management** (or admin). |
| `PHONE_UNVERIFIED` | 422 | "This number isn't verified yet, so we can't send student details to it." | Prompt to verify via **profile with phone verification** (OTP). |
| *(validation)* | 400/422 | Field-specific `details[].issue` | Render each against its `field` inline. |
| *(unexpected)* | 500/503 | "Something went wrong on our side. Please try again." | **generic error page** showing `requestId`; offer retry. |
| *(rate limited)* | 429 | "Too many attempts. Try again shortly." | Disable submit until `Retry-After`; countdown. |

---

## Changelog
- **v1.0** — Initial UI/UX Specification. Derived from blueprint v2.0 §28/§5/§25 and Consistency Register v1.0. Covers design system rules, per-role screen inventory (verbatim names), five critical journeys, form validation patterns, and full error-code → UI mapping.
