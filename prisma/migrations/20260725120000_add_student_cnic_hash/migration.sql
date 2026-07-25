-- AlterTable: student CNIC/B-Form HMAC, the second factor for the CNIC + registration-no portal login.
ALTER TABLE "students" ADD COLUMN     "cnic_hash" TEXT;
