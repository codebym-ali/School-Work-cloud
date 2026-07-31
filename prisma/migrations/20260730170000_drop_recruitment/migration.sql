-- Remove the recruitment surface (vacancy board + applicant pipeline).
--
-- Hiring happens offline — interviews, references and the decision — so posting a vacancy and
-- walking an applicant through SUBMITTED → SHORTLISTED → HIRED was process theatre: nothing
-- downstream depended on either table, and an application was never even linked to a vacancy.
-- What the school needs recorded is the RESULT of a hire, which is a staff_profile.
--
-- "Where are we short of teachers?" is now DERIVED from sections and subjects with no
-- teacher_assignment, so it cannot go stale the way a hand-maintained vacancy board did.
--
-- Safe to drop outright: both tables held 0 rows (verified before writing this migration).
DROP TABLE IF EXISTS "teacher_applications";
DROP TABLE IF EXISTS "vacancies";
DROP TYPE IF EXISTS "TeacherApplicationStatus";
DROP TYPE IF EXISTS "VacancyStatus";
-- "EmploymentType" is deliberately KEPT — staff records still use it.
