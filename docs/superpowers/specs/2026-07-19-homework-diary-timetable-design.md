# Feature #5 — Homework/Diary + Timetable (Design Spec)

> **Status:** Design DRAFT (2026-07-19). Release 2. Largest new build in the roadmap.
> **Goal:** Give teachers a daily-use tool (homework/diary entry, timetable view) and light up the
> parent/student portal "Diary" tab that feature #1 ships dormant. This is the feature that drives
> **teacher adoption** — without it teachers never log in, and without teacher data entry the whole
> product looks empty.

## Open Decisions (confirm before build)

1. **Homework granularity.** Recommendation: **one entry per (section, subject, date)** authored by the
   subject teacher; a section's "diary" for a day = all subjects' entries. ⚠️ Confirm vs. per-student
   homework (heavier, rarely needed at v1).
2. **Attachments.** Allow file attachments (worksheet PDF/image) on a homework entry? Recommendation:
   **yes, optional**, via existing `storage.service.ts` (R2) — cap size/type. ⚠️ Confirm.
3. **Timetable editor complexity.** `TimetableSlot` model exists (section, year, dayOfWeek, periodNo,
   subject, staff, with a teacher-clash index). Recommendation for v1: **simple per-section grid form**
   (add/edit slots, clash detection) — **not** drag-drop auto-scheduling. ⚠️ Confirm.
4. **Bell/period structure.** Are periods uniform school-wide or per-campus/section? Recommendation:
   **per-campus period template** (start/end times per period number). ⚠️ Confirm; may need a
   `PeriodTemplate` config.
5. **Diary notifications.** Should a new diary entry notify parents (WhatsApp/SMS via #2)? Recommendation:
   **daily digest, opt-in** (not per-entry, to avoid spam). ⚠️ Confirm — affects comms cost.

## 1. Business Analysis

- **Problem:** Teachers have no daily reason to use the system (attendance alone isn't enough). Parents
  want to see homework/diary — the single most-requested parent feature after fees. The portal's diary
  tab is empty until this ships.
- **Who uses it:** Subject/Class teacher (create diary + view own timetable), Student/Parent (read
  diary + timetable), Admin (view/manage timetable, oversee).
- **Why largest:** genuinely new domain — a new `Homework`/`DiaryEntry` model, homework API, teacher
  authoring UI, timetable API+UI over the existing `TimetableSlot`, and parent/student read surfaces.
- **Existing foundation:** `TimetableSlot` (`sectionId, academicYearId, dayOfWeek, periodNo, subjectId,
  staffId`, unique per slot, teacher-clash index), teacher assignments module, `storage.service.ts` for
  attachments, comms pipeline (#2) for optional digests, portal patterns from #1.

## 2. Users & Roles

| Role | Access |
|---|---|
| TEACHER | Create/edit diary for own assigned sections+subjects; view own timetable. |
| CAMPUS_ADMIN / OWNER_ADMIN | Manage timetable (own campus), view all diary. |
| STUDENT | Read own section's diary + timetable (via `/me` / student portal). |
| PARENT | Read child's section diary + timetable (via `/parent` — enables the dormant tab from #1). |

## 3. Data Model

**Timetable:** reuse `TimetableSlot`. Add (per Open Decision #4) an optional `PeriodTemplate`
(`{ schoolId, campusId, periodNo, startTime, endTime, label }`) so the grid shows real times.

**Homework/Diary — new model:**
```
model DiaryEntry {
  id             String   @id @default(uuid())
  schoolId       String   @map("school_id")           // tenant
  academicYearId String   @map("academic_year_id")
  sectionId      String   @map("section_id")
  subjectId      String   @map("subject_id")
  date           DateTime @db.Date                     // the diary date
  title          String?
  body           String                                // the homework/diary text
  createdById    String   @map("created_by_id")        // authoring teacher (staff/user)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  attachments    DiaryAttachment[]

  @@unique([sectionId, subjectId, date])               // one entry per section+subject+day
  @@index([schoolId, sectionId, date])                 // parent/student read path
  @@map("diary_entries")
}

model DiaryAttachment {
  id        String @id @default(uuid())
  schoolId  String @map("school_id")
  entryId   String @map("entry_id")
  fileKey   String @map("file_key")                    // R2 key
  fileName  String @map("file_name")
  createdAt DateTime @default(now())
  @@map("diary_attachments")
}
```
- Carries `school_id`; will get the RLS `tenant_isolation` policy via the SQL companion scan — verify
  with `pnpm db:check-rls` after migration.
- Follow conventions: snake_case `@@map`/`@map`, UUID PKs, explicit `schoolId` on create, no `upsert`.

## 4. API Surface

**Diary** — new `DiaryModule` (`DiaryController` + `DiaryService`):

| Method + Path | Purpose | Guard |
|---|---|---|
| `POST /diary` `{sectionId, subjectId, date, body, attachments?}` | teacher creates entry (own section+subject) | TEACHER (ownership in service) |
| `PUT /diary/:id` | edit own entry (within an edit window) | TEACHER (author) / admin |
| `GET /diary?sectionId=&date=` | day/section diary (all subjects) | TEACHER/admin (any section they own/manage) |
| `GET /diary/:id/attachments/:aid/url` | presigned attachment URL | scoped reader |

**Timetable** — new `TimetableModule`:

| Method + Path | Purpose | Guard |
|---|---|---|
| `GET /timetable?sectionId=` | section grid | admin/teacher/student/parent (scoped) |
| `GET /timetable/mine` | teacher's own week | TEACHER |
| `POST/PUT/DELETE /timetable/slots` | edit slots (clash-checked) | CAMPUS_ADMIN/OWNER_ADMIN |
| `GET/PUT /timetable/period-template` | per-campus period times | CAMPUS_ADMIN/OWNER_ADMIN |

**Portal read paths (extend #1 and student `/me`):**
- `GET /parent/children/:studentId/diary?date=` and `.../timetable`
- `GET /portal/diary?date=` and `.../timetable` (student)
- These **enable the dormant diary tab from feature #1** — flip the feature flag when this ships.

## 5. UI

- **Teacher:** `/teacher/diary` — pick section+subject+date → write entry, attach file; `/teacher/timetable`
  — own weekly grid.
- **Admin:** `/setup/timetable` — per-section grid editor with clash warnings; period-template config.
- **Parent/Student:** diary tab in `/parent/[studentId]` and `/me` — read entries by date, download
  attachments; timetable grid.

## 6. Edge Cases

| Case | Behavior |
|---|---|
| Teacher edits after students saw it | Allow within an edit window; show "edited" indicator; consider notifying if digests are on. |
| Duplicate entry (same section+subject+date) | Unique constraint → update-or-reject (find-then-write, no `upsert`). |
| Timetable clash (teacher double-booked) | Reject on save using the `(schoolId, staffId, dayOfWeek)` clash index. |
| Section merged/renamed / student changes section | Diary is section-scoped; a moved student sees the new section's diary going forward, old entries stay historical. |
| Academic year rollover | Diary + timetable are `academicYearId`-scoped; new year starts clean. |
| Teacher resigns | Entries authored remain (createdById kept); reassign timetable slots. |
| Holiday/weekly-off date | Allow "no homework" / block per school policy; align with attendance calendar. |
| Attachment too large / wrong type | Reject with clear error; cap enforced server-side. |
| Parent of multiple children | Diary shown per selected child's section (child-switcher from #1). |

## 7. Testing Checklist

- Tenant isolation for `DiaryEntry`/`DiaryAttachment` (RLS coverage check must pass) — add to isolation suite.
- Teacher can only author for own assigned section+subject (§22.8 service check).
- Unique (section+subject+date) enforced; find-then-write, not `upsert`.
- Timetable clash detection rejects double-booking.
- Parent/student read only their own section's diary/timetable; cross-section/tenant blocked.
- Attachment upload/download presigned-URL flow + size/type caps.
- Portal diary tab lights up (feature flag) and shows entries.
- Playwright: teacher writes homework → parent sees it under the right child.

## 8. Scalability

- `(schoolId, sectionId, date)` index keeps the parent/student read path fast at scale.
- Attachments in R2, not the DB; presigned URLs.
- Optional diary digest via #2 uses BullMQ batching (daily), not per-entry sends.

## 9. Build Order

1. Migration: `DiaryEntry` + `DiaryAttachment` (+ `PeriodTemplate`); run `pnpm db:setup` + `db:check-rls`.
2. `DiaryModule` (create/edit with teacher ownership; attachments via storage).
3. `TimetableModule` over `TimetableSlot` (grid read, slot editor with clash check, period template).
4. Portal read endpoints (parent #1 + student `/me`); flip the diary feature flag.
5. Teacher UI (diary authoring, own timetable), admin timetable editor, portal diary tabs.
6. Optional: daily diary digest via comms (#2).
7. Tests (isolation + ownership + clash + Playwright) + brain update (new domain note, Progress Tracker,
   Key Decisions: homework granularity, timetable editor scope).
