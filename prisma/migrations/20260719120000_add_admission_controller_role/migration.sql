-- Add the ADMISSION_CONTROLLER role: a campus-bound login, provisioned by a campus
-- admin, that manages that campus's admissions pipeline via the Admission Portal.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ADMISSION_CONTROLLER' AFTER 'CAMPUS_ADMIN';
