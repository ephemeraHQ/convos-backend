-- Drop FK column if it still exists (avoid leaving an orphan column)
ALTER TABLE "DeviceIdentity" DROP COLUMN IF EXISTS "profileId";

-- Drop Profile table (remove any dependent constraints/views)
DROP TABLE IF EXISTS "Profile" CASCADE;
