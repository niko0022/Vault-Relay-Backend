-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN     "unreadCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."Message" ADD COLUMN     "readAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."Participant" ADD COLUMN     "unreadCount" INTEGER NOT NULL DEFAULT 0;
