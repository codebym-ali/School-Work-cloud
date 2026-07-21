-- Add the HR_MANAGER role: an HR-recruitment permission the owner grants to an EXISTING
-- employee (reusing their account, no duplicate login). It unlocks the recruitment module.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'HR_MANAGER' AFTER 'ADMISSION_CONTROLLER';
