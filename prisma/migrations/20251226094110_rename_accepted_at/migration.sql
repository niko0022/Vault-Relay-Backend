/*
  Warnings:

  - You are about to drop the column `aceptedAt` on the `Friendship` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Friendship" DROP COLUMN "aceptedAt",
ADD COLUMN     "acceptedAt" TIMESTAMP(3);
