/**
 * Audio transcription — voice attachments → text before generation.
 *
 * The builder model (Claude) can't take audio, so a voice attachment is
 * transcribed to text first and folded into the generation's text input. Uses
 * an audio-capable model (BUILD_TRANSCRIBE_MODEL) via OpenRouter's `input_audio`
 * content block.
 *
 * Fail-loud (unlike moderation's fail-open): the user deliberately attached
 * audio, so a failed transcription fails that generation with a clear error
 * rather than silently dropping their input.
 *
 * ⚠ Format support is model-dependent. OpenRouter's `input_audio` is documented
 * around wav/mp3; mobile recordings are usually m4a/aac (iOS) or ogg/webm
 * (Android). If the chosen model rejects a container, the per-attachment call
 * throws and the generation fails with that error — the signal to either switch
 * BUILD_TRANSCRIBE_MODEL or add a server-side transcode. This whole path lives
 * behind the `transcribeAudio` seam so the provider can be swapped in one place.
 */

import type { OpenAI } from "openai";
import { BUILD_TRANSCRIBE_MODEL, BUILDER_OPENROUTER_API_KEY } from "@/config";
import {
  openRouterChatCompletion,
  type TraceContext,
} from "./openrouter-client";

const TRANSCRIBE_TIMEOUT_MS = 120_000;

const TRANSCRIBE_PROMPT =
  "Transcribe this audio recording to plain text. Output only the verbatim " +
  "transcript — no commentary, timestamps, speaker labels, or quotation marks.";

/** Map a wire MIME type to the short audio-format token OpenRouter expects in
 *  the `input_audio.format` field. Exported for testing. */
export function audioFormat(mimeType: string): string {
  const m = mimeType.split(";")[0].trim().toLowerCase();
  switch (m) {
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    default:
      return m.replace(/^audio\//, "");
  }
}

// ---------------------------------------------------------------------------
// Test seam — singleton override
// ---------------------------------------------------------------------------

export type TranscribeOverride = (
  bytes: Uint8Array,
  mimeType: string,
) => Promise<string>;

let _override: TranscribeOverride | null = null;

/** Install a test override for `transcribeAudio`. Pass `null` to restore. */
export function __resetTranscribeForTests(
  override: TranscribeOverride | null,
): void {
  _override = override;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Transcribe one audio attachment to text. Throws on no API key, an empty
 *  response, or any upstream error (callers fail the generation). */
export async function transcribeAudio(
  bytes: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
  trace?: TraceContext,
): Promise<string> {
  if (_override) {
    return _override(bytes, mimeType);
  }
  return _transcribe(bytes, mimeType, signal, trace);
}

async function _transcribe(
  bytes: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
  trace?: TraceContext,
): Promise<string> {
  const apiKey = BUILDER_OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("BUILDER_OPENROUTER_API_KEY not configured");
  }

  // input_audio carries a free-form `format` token (the SDK's content-part type
  // pins it to wav/mp3); cast through unknown so we can pass the container the
  // file actually used without an `any`.
  const content = [
    { type: "text", text: TRANSCRIBE_PROMPT },
    {
      type: "input_audio",
      input_audio: {
        data: Buffer.from(bytes).toString("base64"),
        format: audioFormat(mimeType),
      },
    },
  ] as unknown as OpenAI.Chat.Completions.ChatCompletionContentPart[];

  const data = await openRouterChatCompletion({
    apiKey,
    stage: "transcribe",
    body: {
      model: BUILD_TRANSCRIBE_MODEL,
      messages: [{ role: "user", content }],
      temperature: 0,
    },
    signal,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    trace,
  });

  const text = data.choices[0]?.message?.content;
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Transcription returned no text");
  }
  return text.trim();
}
