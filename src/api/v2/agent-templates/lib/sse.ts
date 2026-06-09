/**
 * Shared Server-Sent-Events helpers for the agent-templates generation
 * endpoints.
 *
 * Both the async builder (POST /generations) and the ephemeral compare
 * endpoint (POST /generations/ephemeral) hold a connection open while a
 * generation runs. To keep that connection from sitting silent — which an
 * intermediary or client would treat as dead — a held connection emits a
 * comment keep-alive every DEFAULT_SSE_KEEPALIVE_MS and closes with a single
 * terminal frame (`event: result` or `event: error`). HTTP status is always
 * 200 in SSE mode; error detail rides in the terminal frame.
 */

import type { Response } from "express";

/**
 * Keep-alive heartbeat interval. Paired with the 45s long-poll ceiling, this
 * bounds how long a held SSE connection can sit silent before an intermediary
 * (or the client) would treat it as dead.
 */
const DEFAULT_SSE_KEEPALIVE_MS = 15_000;

let _sseKeepaliveMsOverride: number | null = null;

/**
 * Override the SSE keep-alive interval for tests.
 * Pass `null` to restore the default 15 000 ms.
 */
export function __setSseKeepaliveMsForTests(ms: number | null): void {
  _sseKeepaliveMsOverride = ms;
}

function getSseKeepaliveMs(): number {
  return _sseKeepaliveMsOverride ?? DEFAULT_SSE_KEEPALIVE_MS;
}

/** Flush the SSE response headers. */
export function writeSseHeaders(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

/**
 * Flush SSE headers and start the keep-alive heartbeat. Returns the interval
 * handle. The interval is cleared automatically when the connection closes;
 * callers also clear it once they write the terminal frame.
 */
export function startSseStream(res: Response): ReturnType<typeof setInterval> {
  writeSseHeaders(res);

  const keepalive = setInterval(() => {
    try {
      res.write(":\n\n");
    } catch {
      // Client gone — swallow
    }
  }, getSseKeepaliveMs());

  res.on("close", () => {
    clearInterval(keepalive);
  });

  return keepalive;
}

/** Write a terminal SSE frame (`event: <name>\ndata: <json>\n\n`) and end the
 *  stream. Caller clears any keep-alive interval. */
export function writeSseEvent(
  res: Response,
  event: "result" | "error",
  data: unknown,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
