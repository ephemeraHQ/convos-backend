-- Correct the signup_bonus grant-kind description. The original seed
-- (20260515120000_payments_credits_foundation) said "Granted once on first
-- agent creation", which was never wired. The bonus is granted once on first
-- account creation (SIWE upgrade on POST /v2/auth/token).
UPDATE "GrantKind"
SET "description" = 'Granted once when an account is first created (SIWE upgrade)'
WHERE "id" = 'signup_bonus';
