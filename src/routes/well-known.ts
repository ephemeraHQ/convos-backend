import { Router } from "express";
import { ASSISTANT_API_URL } from "@/config";
import logger from "@/utils/logger";

const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

const wellKnownRouter = Router();

/**
 * GET /.well-known/agents.json
 *
 * Proxies the agents.json from the assistant runtime service so it is
 * discoverable at the root of the Convos Backend API domain (RFC 8615).
 *
 * The upstream URL is derived from ASSISTANT_API_URL which is set
 * per-environment (dev/staging vs production).
 */
wellKnownRouter.get("/agents.json", async (req, res) => {
  // ASSISTANT_API_URL is already trimmed by @/config; re-trim defensively
  // before stripping trailing slashes so any whitespace that sneaks in
  // (e.g. via downstream injection) is still caught by the empty check.
  const assistantBaseUrl = ASSISTANT_API_URL.trim().replace(/\/+$/, "");

  if (!assistantBaseUrl) {
    req.log.warn(
      "ASSISTANT_API_URL not configured – cannot proxy .well-known/agents.json",
    );
    res.status(503).json({ error: "Assistant API not configured" });
    return;
  }

  const upstreamUrl = `${assistantBaseUrl}/.well-known/agents.json`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      logger.error(
        { status: upstream.status, body: text, upstreamUrl },
        "Upstream .well-known/agents.json returned non-200",
      );
      res.status(upstream.status).end();
      return;
    }

    const body = await upstream.text();

    // Forward relevant headers
    const contentType = upstream.headers.get("content-type");
    const cacheControl = upstream.headers.get("cache-control");

    if (contentType) res.setHeader("Content-Type", contentType);
    // Default to a short cache if upstream doesn't specify one
    res.setHeader("Cache-Control", cacheControl ?? "public, max-age=300");

    res.status(200).send(body);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      logger.error(
        { upstreamUrl },
        "Upstream .well-known/agents.json timed out",
      );
      res.status(504).json({ error: "Upstream timeout" });
      return;
    }

    logger.error(
      { error, upstreamUrl },
      "Failed to proxy .well-known/agents.json",
    );
    res.status(502).json({ error: "Failed to fetch upstream agents.json" });
  }
});

export { wellKnownRouter };
