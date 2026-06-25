-- Seed the initial curated set of agent prompt hints.
-- Idempotent: a row is inserted only when no existing hint already has the same
-- text, so re-running (or re-applying) this migration never duplicates. Ids are
-- gen_random_uuid(); timestamps are NOW(). All seeds are published with a stable
-- sortOrder so the public endpoint returns them in a deterministic order.
INSERT INTO "AgentPromptHint" ("id", "text", "published", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid(), v."text", true, v."sortOrder", NOW(), NOW()
FROM (
    VALUES
        ('Summarize what I missed in this group chat', 0),
        ('TL;DR this long message in one line', 1),
        ('Turn my messy thoughts into a clean to-do list', 2),
        ('Make me a simple plan for today', 3),
        ('Draft a kind reply when I''m too tired to', 4),
        ('Help me say no without sounding harsh', 5),
        ('Pick a dinner spot we''ll all agree on', 6),
        ('Explain this like I''m five', 7),
        ('Give me 3 gift ideas under $50', 8),
        ('Hype me up before something scary', 9)
) AS v ("text", "sortOrder")
WHERE NOT EXISTS (
    SELECT 1 FROM "AgentPromptHint" h WHERE h."text" = v."text"
);
