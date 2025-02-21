-- Add username column and populate it from name
ALTER TABLE "Profile" ADD COLUMN "username" TEXT;
UPDATE "Profile" SET "username" = LOWER(REGEXP_REPLACE(REGEXP_REPLACE("name", '[^a-zA-Z0-9]+', '_'), '_+$', ''));
ALTER TABLE "Profile" ALTER COLUMN "username" SET NOT NULL;

-- Add unique constraint
CREATE UNIQUE INDEX "Profile_username_key" ON "Profile"("username");
