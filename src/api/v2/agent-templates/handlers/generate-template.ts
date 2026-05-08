/**
 * Handler for POST /api/v2/agent-templates/generate (JSON mode).
 *
 * Auth via `authOrAgentApiKeyAuth`. Validation runs BEFORE any branch on
 * `Accept` so bad inputs always return JSON 400. Legacy field coalescing
 * accepts `text|idea|content|url`. Body limits: MAX_TEXT_LEN=50_000,
 * MAX_BASE64_LEN=35_000_000. Default Accept (or absent) returns
 * 200 application/json with the camelCase template draft.
 *
 * Error → status mapping:
 *   - Validation-class messages (Invalid URL|No content|Could not extract) → 400
 *   - All other rejections → 502
 *
 * SSE mode will be added in a separate feature (m3-generate-handler-sse-mode).
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { callGenerateTemplate } from "@/api/v2/agent-templates/services/templateGen";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_LEN = 50_000;
const MAX_BASE64_LEN = 35_000_000;

/** Regex matching validation-class error messages that should map to 400.
 *  "No content extracted" is a URL-extraction validation error → 400.
 *  "No content in LLM response" is an LLM failure → 502 (not matched here).
 */
const VALIDATION_ERROR_RE =
  /^(Invalid URL|No content extracted|Could not extract)/i;

// ---------------------------------------------------------------------------
// Zod schema — validates & coalesces the request body
// ---------------------------------------------------------------------------

const generateBodySchema = z
  .object({
    /** Primary text input. */
    text: z.string().optional(),
    /** Legacy alias for text. */
    idea: z.string().optional(),
    /** Legacy alias for text. */
    content: z.string().optional(),
    /** Legacy alias for text. */
    url: z.string().optional(),
    /** Base64-encoded PDF content. */
    pdfBase64: z.string().optional(),
    /** MIME type for PDF/image inputs. */
    mimeType: z.string().optional(),
    /** Filename for PDF inputs. */
    filename: z.string().optional(),
    /** Base64-encoded image content. */
    imageBase64: z.string().optional(),
  })
  .strict();

type GenerateBody = z.infer<typeof generateBodySchema>;

// ---------------------------------------------------------------------------
// Coalescing: first non-empty among text|idea|content|url wins
// ---------------------------------------------------------------------------

const coalesceText = (
  body: GenerateBody,
):
  | { text: string }
  | { pdfBase64: string; mimeType: string; filename: string }
  | { imageBase64: string; mimeType: string }
  | null => {
  // File inputs take priority when present
  if (body.pdfBase64) {
    return {
      pdfBase64: body.pdfBase64,
      mimeType: body.mimeType || "application/pdf",
      filename: body.filename || "document.pdf",
    };
  }

  if (body.imageBase64) {
    return {
      imageBase64: body.imageBase64,
      mimeType: body.mimeType || "image/png",
    };
  }

  // Text coalescing: first non-empty among text → idea → content → url
  const coalesced = body.text || body.idea || body.content || body.url;

  if (coalesced && coalesced.trim().length > 0) {
    return { text: coalesced };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Error → status mapping
// ---------------------------------------------------------------------------

const errorStatus = (error: Error): number =>
  VALIDATION_ERROR_RE.test(error.message) ? 400 : 502;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function generateTemplateHandler(req: Request, res: Response) {
  // 1. Validate body shape with zod
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  const body = parsed.data;

  // 2. Coalesce input — determine what we're generating from
  const coalesced = coalesceText(body);

  if (!coalesced) {
    res.status(400).json({
      error:
        "One of text, idea, content, url, pdfBase64, or imageBase64 is required",
    });
    return;
  }

  // 3. Validate lengths BEFORE any Accept branch (so bad inputs always get JSON 400)
  if ("text" in coalesced && coalesced.text.length > MAX_TEXT_LEN) {
    res.status(400).json({
      error: `Text exceeds maximum length of ${MAX_TEXT_LEN} characters`,
    });
    return;
  }

  if ("pdfBase64" in coalesced && coalesced.pdfBase64.length > MAX_BASE64_LEN) {
    res.status(400).json({
      error: `PDF base64 exceeds maximum length of ${MAX_BASE64_LEN} characters`,
    });
    return;
  }

  if (
    "imageBase64" in coalesced &&
    coalesced.imageBase64.length > MAX_BASE64_LEN
  ) {
    res.status(400).json({
      error: `Image base64 exceeds maximum length of ${MAX_BASE64_LEN} characters`,
    });
    return;
  }

  // 4. Branch on Accept header — JSON mode (default) only for now.
  //    SSE mode will be added in the m3-generate-handler-sse-mode feature.
  const accept = req.headers.accept || "";
  const isSSE = accept.includes("text/event-stream");

  // NOTE: SSE branch will be added later. For now, all requests go through JSON mode.
  void isSSE; // used by future SSE branch

  // 5. JSON mode: call generateTemplate and return buffered response
  try {
    const result = await callGenerateTemplate(coalesced);

    res.status(200).json(result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    req.log.warn({ error: error.message }, "Template generation failed");

    const status = errorStatus(error);
    res.status(status).json({ error: error.message });
  }
}
