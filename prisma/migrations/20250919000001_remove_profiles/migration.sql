-- Remove profile relation from DeviceIdentity (already handled by cascade)

-- Drop Profile table (this will also remove the foreign key constraint)
DROP TABLE "Profile";
