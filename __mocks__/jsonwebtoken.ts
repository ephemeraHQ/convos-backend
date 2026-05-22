// Vitest manual mock for jsonwebtoken.
// jsonwebtoken@9 transitively requires buffer-equal-constant-time which uses
// SlowBuffer — removed in Node 22+. Any test that transitively loads
// apns-push.service (→ jsonwebtoken) must declare vi.mock("jsonwebtoken") to
// activate this stub and prevent the SlowBuffer crash at import time.
export default {
  sign: (_payload: unknown, _key: unknown, _opts: unknown): string =>
    "mock-jwt-token",
  verify: (_token: unknown, _key: unknown, _opts?: unknown): unknown => ({}),
  decode: (_token: unknown): unknown => ({}),
};
