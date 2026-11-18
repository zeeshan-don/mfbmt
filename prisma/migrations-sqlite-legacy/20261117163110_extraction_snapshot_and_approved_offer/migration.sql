-- AlterTable
ALTER TABLE "Enquiry" ADD COLUMN "extractedJson" TEXT;

-- AlterTable
ALTER TABLE "EnquiryItem" ADD COLUMN "approvedOfferId" TEXT;
ALTER TABLE "EnquiryItem" ADD COLUMN "extractedJson" TEXT;
