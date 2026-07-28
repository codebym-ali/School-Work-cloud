-- Audit fix #5: the teacher CNIC (national ID) was stored in PLAINTEXT inside the
-- teacher_applications.details JSON, while the same data class on ParentProfile has been
-- AES-256-GCM encrypted all along (cnic_enc). A JSON blob cannot be selectively encrypted,
-- so the value moves to its own column — which also makes what is protected visible in the
-- schema rather than buried in a document.
--
-- No backfill: teacher_applications is empty (verified), so nothing to migrate. If rows had
-- existed, this would need a data step to encrypt-and-strip before the column went live.
ALTER TABLE "teacher_applications" ADD COLUMN "cnic_enc" TEXT;
