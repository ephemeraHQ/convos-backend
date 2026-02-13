import logger from "./logger";
import { prisma } from "./prisma";

const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { value: string; expiresAt: number }>();

export async function getRuntimeConfig(
  key: string,
  defaultValue: string,
): Promise<string> {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  try {
    const config = await prisma.runtimeConfig.findUnique({ where: { key } });
    const value = config?.value ?? defaultValue;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    logger.error({ error, key }, "Failed to read runtime config");
    return defaultValue;
  }
}

export async function setRuntimeConfig(
  key: string,
  value: string,
): Promise<void> {
  await prisma.runtimeConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}
