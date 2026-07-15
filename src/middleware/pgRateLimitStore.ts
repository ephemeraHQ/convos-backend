import type { Options, Store } from "express-rate-limit";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

/**
 * Postgres-backed express-rate-limit store (fixed windows over the
 * RateLimitCounter table). Used for limiters whose ceiling must hold across
 * every replica — the claim endpoint's global claims-per-hour ceiling — where
 * the default MemoryStore silently degrades to a per-replica limit. Postgres
 * is the one store every replica already shares; claim volume is tiny (the
 * per-IP/per-account limiters in front of it bound the write rate).
 *
 * Fail-open on database errors: a broken counter store must not take the
 * whole route down; the per-IP/account MemoryStore limiters still apply.
 */
export class PgRateLimitStore implements Store {
  private windowMs = 60 * 60 * 1000;
  readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private windowStart(): Date {
    return new Date(Math.floor(Date.now() / this.windowMs) * this.windowMs);
  }

  async increment(
    key: string,
  ): Promise<{ totalHits: number; resetTime: Date }> {
    const windowStart = this.windowStart();
    const resetTime = new Date(windowStart.getTime() + this.windowMs);
    try {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "RateLimitCounter" ("key", "windowStart", "count", "updatedAt")
        VALUES (${this.prefix + key}, ${windowStart}, 1, now())
        ON CONFLICT ("key", "windowStart")
        DO UPDATE SET "count" = "RateLimitCounter"."count" + 1, "updatedAt" = now()
        RETURNING "count"
      `;
      // Opportunistic cleanup of expired windows (cheap at this volume).
      void prisma.rateLimitCounter
        .deleteMany({
          where: {
            key: { startsWith: this.prefix },
            windowStart: {
              lt: new Date(windowStart.getTime() - 2 * this.windowMs),
            },
          },
        })
        .catch(() => undefined);
      return { totalHits: rows[0]?.count ?? 1, resetTime };
    } catch (err) {
      logger.error({ err, key }, "rate_limit.pg_store_increment_failed");
      return { totalHits: 1, resetTime };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await prisma.$executeRaw`
        UPDATE "RateLimitCounter"
        SET "count" = GREATEST("count" - 1, 0), "updatedAt" = now()
        WHERE "key" = ${this.prefix + key} AND "windowStart" = ${this.windowStart()}
      `;
    } catch (err) {
      logger.warn({ err, key }, "rate_limit.pg_store_decrement_failed");
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await prisma.rateLimitCounter.deleteMany({
        where: { key: this.prefix + key },
      });
    } catch (err) {
      logger.warn({ err, key }, "rate_limit.pg_store_reset_failed");
    }
  }
}
