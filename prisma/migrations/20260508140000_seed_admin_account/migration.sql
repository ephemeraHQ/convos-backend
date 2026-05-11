-- SeedRow
INSERT INTO "Account" ("id", "createdAt", "updatedAt") VALUES ('48a05ef4-4a71-57a0-957f-a3d410992b31', NOW(), NOW()) ON CONFLICT ("id") DO NOTHING;
