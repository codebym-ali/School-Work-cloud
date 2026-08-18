/**
 * Permission matrix (blueprint §23, security playbook P1.14) as data. Each row names a
 * representative endpoint per module, the roles RolesGuard must ADMIT, and whether the
 * admitted non-owner roles are additionally scope-gated (campus/ownership) — in which
 * case only OWNER_ADMIN's positive reachability is asserted, while the deny side (every
 * non-admitted role → 403) is always asserted. The conformance spec drives these against
 * the live Nest routes, so a change to any `@Roles` decorator that diverges from this
 * table fails CI (merge-blocking).
 */
// HR_MANAGER is in the union but NOT in `MATRIX_ROLES` below: three rows already name it as an
// admitted role, so the type has to allow it, but nothing here has ever exercised an
// HR_MANAGER session. Listing it without seeding it would be the drift §23 was softened for.
// Adding it to MATRIX_ROLES is real work — every row's deny side would then have to be true
// of it — and is worth doing; it is not worth *claiming* to have done.
export type MatrixRole = 'OWNER_ADMIN' | 'CAMPUS_ADMIN' | 'ADMISSION_CONTROLLER' | 'ACCOUNTANT' | 'TEACHER' | 'PARENT' | 'HR_MANAGER';

// PARENT is retained even though its portal was removed (2026-07-28): the role still exists,
// and every row's deny-side asserts a PARENT-bearing session reaches NOTHING. That is a
// regression guard worth keeping until the role itself is retired (scope B).
export const MATRIX_ROLES: MatrixRole[] = ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER', 'ACCOUNTANT', 'TEACHER', 'PARENT'];

export interface MatrixRow {
  label: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: Record<string, unknown>;
  /** Roles RolesGuard admits. Every other role must get 403. */
  allow: MatrixRole[];
  /** Admitted non-owner roles may still be scope-403'd (campus/ownership) → skip their positive check. */
  scopeGated?: boolean;
}

/**
 * ⚠️ **The two sign-in doors are deliberately NOT rows here, and that is not an oversight.**
 *
 * `/auth/login` and `/auth/owner-login` are `@Public()`. This harness drives every row with a
 * ROLE'S SESSION COOKIE and asserts 403 vs not-403 — but a login route takes *credentials*, has no
 * session to present, and refuses the wrong door with **401**, deliberately indistinguishable from
 * a wrong password. A row here would therefore assert nothing while looking like coverage, which is
 * worse than the gap it appears to close.
 *
 * The boundary is measured directly in `auth.e2e-spec.ts` instead: the owner door refuses a
 * non-owner (and never leaks an `mfaToken`), the staff door refuses an owner, both refusals are
 * byte-identical to a wrong password, and a dual-role owner is refused at the staff door. **Measured
 * by a different instrument, not unmeasured.**
 */
export const PERMISSION_MATRIX: MatrixRow[] = [
  { label: 'list students', method: 'get', path: '/api/v1/students', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'], scopeGated: true },
  // Creating a student is admission-controller-only (segregation of duties); owner/campus are read-only here.
  { label: 'create student', method: 'post', path: '/api/v1/students', body: {}, allow: ['ADMISSION_CONTROLLER'] },
  { label: 'import students (CSV)', method: 'post', path: '/api/v1/students/import', body: {}, allow: ['ADMISSION_CONTROLLER'] },
  { label: 'change student status', method: 'patch', path: '/api/v1/students/00000000-0000-0000-0000-000000000000/status', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Deleting a student record is owner-only — it is for mis-keyed admissions, not departures.
  { label: 'delete student', method: 'delete', path: '/api/v1/students/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'] },
  // Reading a child's national ID is admin-only — notably NOT the admission officer, who
  // captures the CNIC but has no reason to read it back afterwards.
  // Recording a CNIC changes a live sign-in credential, so it is admin-only like the reveal —
  // notably NOT the admission officer, who captures it at admission but may not rewrite it.
  { label: 'set student cnic', method: 'patch', path: '/api/v1/students/00000000-0000-0000-0000-000000000000/cnic', body: { cnic: '42101-1234567-1' }, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'reveal student cnic', method: 'get', path: '/api/v1/students/00000000-0000-0000-0000-000000000000/cnic', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // ADD includes the admission officer — the guardian is optional at admission, so they must
  // be able to complete the record they created. Edit/remove stay admin-only (below).
  { label: 'add student guardian', method: 'post', path: '/api/v1/students/00000000-0000-0000-0000-000000000000/guardians', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },
  { label: 'admit student', method: 'post', path: '/api/v1/admissions', body: {}, allow: ['ADMISSION_CONTROLLER'] },
  { label: 'request guardian OTP', method: 'post', path: '/api/v1/students/guardians/00000000-0000-0000-0000-000000000000/verify-phone', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'confirm guardian OTP', method: 'post', path: '/api/v1/students/guardians/00000000-0000-0000-0000-000000000000/verify-phone/confirm', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'create campus', method: 'post', path: '/api/v1/campuses', body: { name: 'Zeta' }, allow: ['OWNER_ADMIN'] },
  { label: 'delete campus', method: 'delete', path: '/api/v1/campuses/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'] },
  { label: 'create class', method: 'post', path: '/api/v1/classes', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'rename class', method: 'patch', path: '/api/v1/classes/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'delete class', method: 'delete', path: '/api/v1/classes/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'class coverage gaps', method: 'get', path: '/api/v1/classes/coverage', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'rename section', method: 'patch', path: '/api/v1/sections/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'delete section', method: 'delete', path: '/api/v1/sections/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'set section subjects', method: 'put', path: '/api/v1/sections/00000000-0000-0000-0000-000000000000/subjects', body: { subjectIds: [] }, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'rename subject', method: 'patch', path: '/api/v1/subjects/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'delete subject', method: 'delete', path: '/api/v1/subjects/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  // Closures move money: a holiday changes the month's working-day count, which is the divisor
  // for every absence deduction. Declaring is admin-only; a campus admin is force-scoped to their
  // own campus in the service. READING is open to TEACHER as well — it is their calendar, and a
  // teacher who cannot see the closures is a teacher who turns up at a locked school.
  { label: 'declare a closure', method: 'post', path: '/api/v1/holidays', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'declare a closure range', method: 'post', path: '/api/v1/holidays/range', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'read the closure calendar', method: 'get', path: '/api/v1/holidays', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { label: 'remove a closure', method: 'delete', path: '/api/v1/holidays/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  // ── Enrollment ────────────────────────────────────────────────────────────
  // Neither of these had a row, so the conformance check had never asserted who may call them —
  // and a transfer RELOCATES A CHILD, including between campuses. A route with no row is not
  // "assumed safe", it is unmeasured. The campus half is enforced in the service (§22.8), on both
  // the source and the destination.
  { label: 'transfer a student', method: 'post', path: '/api/v1/enrollments/transfer', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  // ⚠️ Adding this row is what revealed the endpoint had NO `@Roles` at all — every authenticated
  // session could enumerate which child is in which class. TEACHER stays because the attendance
  // roster and marks entry both load from here.
  { label: 'read enrollments', method: 'get', path: '/api/v1/enrollments', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER', 'TEACHER'], scopeGated: true },
  // Promotion is a bulk year-roll for a whole class; same admins, and it had no row either.
  { label: 'promote a class', method: 'post', path: '/api/v1/promotions', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },

  { label: 'create academic year', method: 'post', path: '/api/v1/academic-years', body: {}, allow: ['OWNER_ADMIN'] },
  { label: 'list inquiries', method: 'get', path: '/api/v1/inquiries', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'], scopeGated: true },
  { label: 'admissions summary', method: 'get', path: '/api/v1/inquiries/summary', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER'] },
  { label: 'mark attendance', method: 'post', path: '/api/v1/attendance/bulk', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'], scopeGated: true },
  // Which registers are still unmarked is OVERSIGHT, not self-service: it names colleagues who
  // are behind. A teacher gets their own coverage strip instead.
  { label: 'unmarked registers today', method: 'get', path: '/api/v1/attendance/unmarked-today', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  // `/attendance/mine/unmarked-today` is deliberately NOT here: it is self-scoped like
  // `/staff-attendance/mine`, so every role reaching it is correct and a deny row would encode the
  // opposite. What protects it is that the service resolves the caller's own staff profile and can
  // address no other — an account without one gets an empty list, not somebody else's registers.
  // Staff attendance had NO matrix row at all, on either endpoint — and these rows feed the
  // payroll attendance deduction, so who may write them is a pay question. Marking is the
  // office's job: a teacher must never record staff attendance, least of all their own.
  { label: 'mark staff attendance', method: 'post', path: '/api/v1/staff-attendance/bulk', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  // School settings govern money (fee due day, proration, sibling discount) and pay
  // (attendance windows, self check-in), so a campus admin reads the rules they work under
  // but only the owner moves them.
  { label: 'read school settings', method: 'get', path: '/api/v1/school-settings', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'change school settings', method: 'patch', path: '/api/v1/school-settings', body: {}, allow: ['OWNER_ADMIN'] },
  // Oversight is admin + HR (HR_MANAGER isn't a seeded matrix role, so these rows assert the
  // deny side: a teacher must not be able to read the whole school's staff register, and an
  // accountant has no business in it either.
  { label: 'staff attendance day summary', method: 'get', path: '/api/v1/staff-attendance/summary', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'staff attendance register', method: 'get', path: '/api/v1/staff-attendance', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'one staff member’s attendance history', method: 'get', path: '/api/v1/staff-attendance/staff/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'create exam', method: 'post', path: '/api/v1/exams', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'delete term', method: 'delete', path: '/api/v1/terms/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'list invoices', method: 'get', path: '/api/v1/fees/invoices', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  { label: 'generate invoice batch', method: 'post', path: '/api/v1/fees/invoice-batches', body: {}, allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  // What a class is charged is the owner's decision alone — an accountant collects money, they
  // do not set the price. These had no matrix rows at all before the plan rework.
  // A claim is not a payment: reading the queue is admin+cashier, but CONFIRMING one mints a
  // receipt, so verify/reject are the cashier's call and a campus admin is excluded.
  { label: 'list payment claims', method: 'get', path: '/api/v1/fees/claims', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  { label: 'submit a payment claim', method: 'post', path: '/api/v1/fees/claims', body: {}, allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { label: 'verify a payment claim', method: 'post', path: '/api/v1/fees/claims/00000000-0000-0000-0000-000000000000/verify', body: {}, allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { label: 'reject a payment claim', method: 'post', path: '/api/v1/fees/claims/00000000-0000-0000-0000-000000000000/reject', body: {}, allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  // Proof of payment is financial evidence: the same audience that may see the payment.
  { label: 'read payment proof', method: 'get', path: '/api/v1/fees/payments/00000000-0000-0000-0000-000000000000/proof', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  // F8: these four READS shipped with no `@Roles` while every write beside them was owner-only,
  // so the fee catalogue, every class's prices, the late-fee rule and — worst — named students'
  // concessions were readable by any authenticated session. The matrix had rows for the writes
  // only, which is precisely why nothing caught it: **a guarded write does not imply a guarded
  // read, and only a row here proves either.**
  { label: 'list fee heads', method: 'get', path: '/api/v1/fee-heads', allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { label: 'list fee prices', method: 'get', path: '/api/v1/fee-structures', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },
  { label: 'read late-fee policy', method: 'get', path: '/api/v1/late-fee-policy', allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { label: 'list student discounts', method: 'get', path: '/api/v1/discounts', allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  // Minting a guardian link creates a BEARER CREDENTIAL for one invoice — whoever holds it can
  // file a claim against that bill without signing in. So it is the cashier's call, not a campus
  // admin's, and never a teacher's. (The public surface the token opens is @Public by design and
  // therefore has no row here; its guards are the signature, the expiry and the settings flag,
  // asserted in fees.e2e.)
  { label: 'mint a guardian fee link', method: 'post', path: '/api/v1/fees/invoices/00000000-0000-0000-0000-000000000000/guardian-link', body: {}, allow: ['OWNER_ADMIN', 'ACCOUNTANT'] },
  { label: 'rename a fee', method: 'patch', path: '/api/v1/fee-heads/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN'] },
  { label: 'delete a fee', method: 'delete', path: '/api/v1/fee-heads/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'] },
  { label: 'change a fee price', method: 'patch', path: '/api/v1/fee-structures/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN'] },
  { label: 'delete a fee price', method: 'delete', path: '/api/v1/fee-structures/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'] },
  { label: 'copy a fee plan', method: 'post', path: '/api/v1/fee-structures/copy', body: {}, allow: ['OWNER_ADMIN'] },
  // A receipt is financial evidence about one family: the same audience that may see the payment.
  // (The STUDENT's own receipt is a different route under /portal, self-scoped in the service.)
  { label: 'read a fee receipt', method: 'get', path: '/api/v1/fees/payments/00000000-0000-0000-0000-000000000000/receipt', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  { label: 'reverse payment', method: 'post', path: '/api/v1/fees/payments/00000000-0000-0000-0000-000000000000/reversals', body: { reason: 'x' }, allow: ['OWNER_ADMIN'] },
  // ── Leaves ────────────────────────────────────────────────────────────────
  // Had NO matrix rows at all, on either controller — and staff leave feeds payroll (approved
  // UNPAID leave is deducted whatever the absence setting says), so who may file and who may
  // approve are both money questions.
  //
  // **A student never applies for their own leave** (decision, 2026-08-05). A parent tells the
  // class teacher and the office writes it down — which is how a Pakistani school actually works,
  // and the child is not the one making the request. Guardians have no logins either.
  //
  // ⚠️ These rows do NOT pin that: STUDENT is not a seeded matrix role, so adding `'STUDENT'` to
  // the decorator changes nothing here — verified by doing it and watching all 461 tests still
  // pass. What actually stops a student is the **guardian check in the service**, and
  // `student-portal.e2e` asserts it with a real student session. These rows cover the seeded
  // staff/admin roles: they catch an accountant or admission officer being handed leave filing.
  { label: 'file a student leave', method: 'post', path: '/api/v1/student-leaves', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'], scopeGated: true },
  // Deciding is the office's, never the teacher's: a teacher who could approve the leave they
  // filed would be approving their own request, and an approved leave LOCKS the attendance row.
  { label: 'approve a student leave', method: 'post', path: '/api/v1/student-leaves/00000000-0000-0000-0000-000000000000/approve', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // STAFF is also admitted here (a staff member files their own) but is not a seeded matrix role;
  // this row asserts the accountant, admission officer and parent are all denied.
  { label: 'file a staff leave', method: 'post', path: '/api/v1/staff-leaves', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { label: 'approve a staff leave', method: 'post', path: '/api/v1/staff-leaves/00000000-0000-0000-0000-000000000000/approve', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // ⚠️ `GET /staff-leaves/balance` has NO row on purpose, and it is not an omission. It carries no
  // `@Roles` — like `/staff-attendance/mine` and `/payslips/mine`, the gate is OWNERSHIP: the
  // service forces a non-admin to their own staff profile and 403s an account with no profile at
  // all. A matrix row states "these roles may, those may not", which is the wrong question here
  // and would read as coverage of a boundary it cannot see. What it should say is proved in
  // `staff-leaves.e2e` with a real TEACHER session: asked about a colleague, answered about
  // themselves. Same lesson as the STUDENT note above — a row that cannot fail is worse than none.
  // ── Cover ─────────────────────────────────────────────────────────────────
  // Arranging cover is a PERMISSION GRANT — it lets one teacher write to another class's
  // register, on data that feeds pay — so it belongs with the people who approve leave. A TEACHER
  // being able to arrange their own cover would make the boundary meaningless, and `cover.e2e`
  // asserts exactly that with a real teacher session.
  { label: 'arrange cover', method: 'post', path: '/api/v1/cover', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'remove cover', method: 'delete', path: '/api/v1/cover/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'read the cover list', method: 'get', path: '/api/v1/cover', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'read who is away', method: 'get', path: '/api/v1/cover/away', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'arrange cover for a range', method: 'post', path: '/api/v1/cover/range', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Suggestions read the whole staff body's attendance and timetable, so it is oversight, not
  // self-service — a teacher must not be able to ask who else is away today.
  { label: 'suggest who could cover', method: 'get', path: '/api/v1/cover/suggestions', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  // ── Timetable ─────────────────────────────────────────────────────────────
  // Building the week is the office's job; a teacher reads theirs and does not author it (§23).
  // These rows would have been impossible to write until 2026-08-08 — `timetable_slots` had no
  // endpoint at all, so there was no route for a matrix row to point at.
  { label: 'set a timetable period', method: 'post', path: '/api/v1/timetable/slots', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'clear a timetable period', method: 'delete', path: '/api/v1/timetable/slots/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // TEACHER included: they need the class's whole shape, not only the periods they personally
  // teach — "who has 9-B before me" is a real question. Campus scope still applies in-service.
  { label: 'read a section timetable', method: 'get', path: '/api/v1/timetable/section/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'], scopeGated: true },
  { label: 'timetable coverage', method: 'get', path: '/api/v1/timetable/coverage', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // Copying a day is bulk authoring, so it sits with authoring — not with the teacher who reads it.
  { label: 'copy a timetable day', method: 'post', path: '/api/v1/timetable/copy-day', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // ── School timings (bell schedule) ────────────────────────────────────────
  // The day's shape is a structural setting, like campuses and classes: the office declares it and
  // everyone else reads its consequences through the grid. A campus admin is narrowed to their own
  // campus in-service (§22.8), which `bell-schedule.e2e` asserts in both directions.
  //
  // ⚠️ Reads are gated too, and deliberately so. A guarded write does not imply a guarded read is a
  // lesson this repo has paid for twice — `GET /enrollments` had no `@Roles` at all, and four fee
  // reads returned a named child's concessions to any session. A teacher gets the times through
  // their own week, which needs no id and no role list.
  { label: 'list bell schedules', method: 'get', path: '/api/v1/bell-schedules', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'read a bell schedule', method: 'get', path: '/api/v1/bell-schedules/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'create a bell schedule', method: 'post', path: '/api/v1/bell-schedules', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'update a bell schedule', method: 'patch', path: '/api/v1/bell-schedules/00000000-0000-0000-0000-000000000000', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'retire a bell schedule', method: 'delete', path: '/api/v1/bell-schedules/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'compose a school day', method: 'put', path: '/api/v1/bell-schedules/00000000-0000-0000-0000-000000000000/days/1', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  // ⚠️ `GET /timetable/mine` has no row, for the same reason as `/staff-leaves/balance`: it is
  // ownership-gated, not role-gated. It takes no id and resolves the caller's own staff profile or
  // enrolment, so a role list would be the wrong question. Proved in `timetable.e2e` with a real
  // TEACHER session seeing only their own periods.
  { label: 'class-strength report', method: 'get', path: '/api/v1/reports/class-strength', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'], scopeGated: true },
  { label: 'dashboard', method: 'get', path: '/api/v1/dashboard', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT'] },
  // STUDENT-only. STUDENT isn't one of the seeded matrix roles, so allow:[] asserts every
  // seeded admin/staff role is denied (the STUDENT positive path is in student-portal.e2e).
  { label: 'student portal', method: 'get', path: '/api/v1/portal/overview', allow: [] },
  // Users & roles: create/list is admin; a campus admin is scoped + limited in-service.
  { label: 'list users', method: 'get', path: '/api/v1/users', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'create user', method: 'post', path: '/api/v1/users', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'set user access', method: 'patch', path: '/api/v1/users/00000000-0000-0000-0000-000000000000/access', body: { role: 'HR_MANAGER', grant: true }, allow: ['OWNER_ADMIN'] },
  // The per-campus admission seat (§8/§23): the overview is readable by both admins, but only
  // the owner may move it — it decides who speaks for a campus's admissions.
  { label: 'list admission officers', method: 'get', path: '/api/v1/admission-officers', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'set admission officer', method: 'put', path: '/api/v1/admission-officers/00000000-0000-0000-0000-000000000000', body: { userId: '00000000-0000-0000-0000-000000000000' }, allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'remove admission officer', method: 'delete', path: '/api/v1/admission-officers/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'list user modules', method: 'get', path: '/api/v1/users/00000000-0000-0000-0000-000000000000/modules', allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'add staff member', method: 'post', path: '/api/v1/staff', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'], scopeGated: true },
  { label: 'hr summary', method: 'get', path: '/api/v1/staff/summary', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'] },
  { label: 'assign teacher to class', method: 'post', path: '/api/v1/teacher-assignments', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'], scopeGated: true },
  // Class tests are teacher-owned formative assessment; admins may view and step in. The
  // (section, subject) ownership check lives in the service, so these rows assert the role gate.
  // Academic performance, deliberately NOT open to the accountant — this is not money.
  { label: 'class performance report', method: 'get', path: '/api/v1/reports/performance/classes', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { label: 'student performance report', method: 'get', path: '/api/v1/reports/performance/students/00000000-0000-0000-0000-000000000000', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'create class test', method: 'post', path: '/api/v1/class-tests', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'], scopeGated: true },
  { label: 'list class tests', method: 'get', path: '/api/v1/class-tests', allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'] },
  { label: 'enter class test marks', method: 'post', path: '/api/v1/class-tests/00000000-0000-0000-0000-000000000000/scores', body: { rows: [] }, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'TEACHER'], scopeGated: true },
  { label: 'set user module', method: 'patch', path: '/api/v1/users/00000000-0000-0000-0000-000000000000/modules', body: { moduleKey: 'hr.assign', allowed: false }, allow: ['OWNER_ADMIN'], scopeGated: true },
  { label: 'create staff', method: 'post', path: '/api/v1/staff', body: {}, allow: ['OWNER_ADMIN', 'CAMPUS_ADMIN'], scopeGated: true },
  { label: 'run payroll', method: 'post', path: '/api/v1/payroll-runs', body: {}, allow: ['OWNER_ADMIN'] },

  // Teacher self-service — TEACHER-only; positive path needs a linked StaffProfile so it's
  // scope-gated (deny side is the guarantee here).
  { label: 'teacher my-classes', method: 'get', path: '/api/v1/teaching/my-classes', allow: ['TEACHER'], scopeGated: true },
];
