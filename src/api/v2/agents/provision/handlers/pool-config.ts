import type { Request } from "express";

const MIN_KEY_LENGTH = 32;

export interface PoolConfig {
  poolBaseUrl: string;
  poolApiKey: string;
}

/**
 * Reads and validates pool configuration from environment variables.
 * Returns null if the pool is not configured or the API key is too short.
 * Values are trimmed and the URL trailing slash is stripped.
 */
export function getPoolConfig(req: Request): PoolConfig | null {
  const poolUrl = (process.env.AGENT_POOL_URL ?? "").trim();
  const poolApiKey = (process.env.AGENT_POOL_API_KEY ?? "").trim();

  if (!poolUrl || !poolApiKey || poolApiKey.length < MIN_KEY_LENGTH) {
    req.log.error("Agent pool not configured");
    return null;
  }

  return {
    poolBaseUrl: poolUrl.replace(/\/+$/, ""),
    poolApiKey,
  };
}
