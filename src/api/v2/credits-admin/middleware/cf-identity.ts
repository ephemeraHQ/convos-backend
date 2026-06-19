import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const CF_IDENTITY_SENTINEL = "token-admin@no-cf";
const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

type CfIdentityResolver = JWTVerifyGetKey;

interface CfIdentityDeps {
  resolver: CfIdentityResolver | null;
  aud: string;
  requireIdentity: boolean;
}

// Test-only seam. The caller owns cleanup — reset to `undefined` in afterEach
// so an injected resolver never leaks into another test file.
let _testDeps: CfIdentityDeps | undefined;
export function __setCfIdentityForTests(
  deps: CfIdentityDeps | undefined,
): void {
  _testDeps = deps;
  _memoResolver = undefined;
}

// `undefined` = not yet computed; `null` = computed, no domain configured.
// Process-lifetime cache: a domain set after boot needs a restart to take
// effect (matches how other infra env vars are read once at startup).
let _memoResolver: CfIdentityResolver | null | undefined;
function realResolver(): CfIdentityResolver | null {
  if (_memoResolver !== undefined) return _memoResolver;
  const domain = (process.env.CF_ACCESS_TEAM_DOMAIN ?? "").trim();
  _memoResolver = domain
    ? createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`))
    : null;
  return _memoResolver;
}

function deps(): CfIdentityDeps {
  if (_testDeps) return _testDeps;
  return {
    resolver: realResolver(),
    aud: (process.env.CF_ACCESS_AUD ?? "").trim(),
    requireIdentity:
      (process.env.CREDITS_ADMIN_REQUIRE_CF_IDENTITY ?? "").trim() === "true",
  };
}

export const attachActorIdentity = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const { resolver, aud, requireIdentity } = deps();

  if (!resolver) {
    if (requireIdentity) {
      req.log.error("cf_identity.misconfigured");
      res.status(500).json({ code: "server_error" });
      return;
    }
    res.locals.actorEmail = CF_IDENTITY_SENTINEL;
    next();
    return;
  }

  // Domain configured but AUD missing is a partial misconfig. jose treats an
  // empty `audience` as "no audience check", so a validly-signed token issued
  // for a DIFFERENT Access application would verify here and stamp an
  // attacker-chosen-but-valid email on the audit row. Fail closed (500) rather
  // than attribute a wrong actor — set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD
  // together.
  if (!aud) {
    req.log.error("cf_identity.aud_misconfigured");
    res.status(500).json({ code: "server_error" });
    return;
  }

  const assertion = (req.header(ASSERTION_HEADER) ?? "").trim();
  if (!assertion) {
    if (requireIdentity) {
      req.log.warn("cf_identity.required");
      res.status(401).json({ code: "cf_identity_required" });
      return;
    }
    res.locals.actorEmail = CF_IDENTITY_SENTINEL;
    next();
    return;
  }

  try {
    // clockTolerance guards against minor node/CF clock skew spuriously
    // rejecting (and thus 401-blocking) an otherwise-valid admin action. `aud`
    // is guaranteed non-empty here (checked above).
    const { payload } = await jwtVerify(assertion, resolver, {
      audience: aud,
      clockTolerance: 30,
    });
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    if (!email) {
      req.log.warn("cf_identity.invalid_assertion");
      res.status(401).json({ code: "cf_identity_invalid" });
      return;
    }
    res.locals.actorEmail = email;
    next();
  } catch (err) {
    req.log.warn({ err }, "cf_identity.invalid_assertion");
    res.status(401).json({ code: "cf_identity_invalid" });
  }
};
