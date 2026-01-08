/*
  Warnings:

  - You are about to drop the `Device` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DeviceIdentity` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `IdentitiesOnDevice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `InviteCode` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `InviteCodeNotificationTarget` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `InviteCodeRequest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `InviteCodeUse` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Profile` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SubOrg` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."IdentitiesOnDevice" DROP CONSTRAINT "IdentitiesOnDevice_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "public"."IdentitiesOnDevice" DROP CONSTRAINT "IdentitiesOnDevice_identityId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InviteCode" DROP CONSTRAINT "InviteCode_createdById_fkey";

-- DropForeignKey
ALTER TABLE "public"."InviteCodeNotificationTarget" DROP CONSTRAINT "InviteCodeNotificationTarget_deviceIdentityId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InviteCodeNotificationTarget" DROP CONSTRAINT "InviteCodeNotificationTarget_inviteCodeId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InviteCodeRequest" DROP CONSTRAINT "InviteCodeRequest_inviteCodeId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InviteCodeRequest" DROP CONSTRAINT "InviteCodeRequest_requesterId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InviteCodeUse" DROP CONSTRAINT "InviteCodeUse_inviteCodeId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InviteCodeUse" DROP CONSTRAINT "InviteCodeUse_usedById_fkey";

-- DropForeignKey
ALTER TABLE "public"."Profile" DROP CONSTRAINT "Profile_deviceIdentityId_fkey";

-- DropTable
DROP TABLE "public"."Device";

-- DropTable
DROP TABLE "public"."DeviceIdentity";

-- DropTable
DROP TABLE "public"."IdentitiesOnDevice";

-- DropTable
DROP TABLE "public"."InviteCode";

-- DropTable
DROP TABLE "public"."InviteCodeNotificationTarget";

-- DropTable
DROP TABLE "public"."InviteCodeRequest";

-- DropTable
DROP TABLE "public"."InviteCodeUse";

-- DropTable
DROP TABLE "public"."Profile";

-- DropTable
DROP TABLE "public"."SubOrg";

-- DropEnum
DROP TYPE "public"."DeviceOS";

-- DropEnum
DROP TYPE "public"."InviteCodeRequestStatus";

-- DropEnum
DROP TYPE "public"."InviteCodeStatus";
