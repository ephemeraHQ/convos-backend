/**
 * Unit tests for the audio transcription service. The transcription model call
 * is exercised end-to-end in the resolver/executor tests via the
 * `__resetTranscribeForTests` seam; here we cover the no-key gate and the
 * MIME → format mapping (the m4a-risk surface).
 */

import { describe, expect, test } from "vitest";
import {
  audioFormat,
  transcribeAudio,
} from "@/api/v2/agent-templates/services/transcribe";

test("throws when no builder API key is configured", async () => {
  // BUILDER_OPENROUTER_API_KEY is unset in the test env.
  await expect(
    transcribeAudio(new Uint8Array([1, 2, 3]), "audio/mp4"),
  ).rejects.toThrow(/BUILDER_OPENROUTER_API_KEY/);
});

describe("audioFormat", () => {
  test("maps the common containers to short tokens", () => {
    expect(audioFormat("audio/mpeg")).toBe("mp3");
    expect(audioFormat("audio/wav")).toBe("wav");
    expect(audioFormat("audio/mp4")).toBe("m4a");
    expect(audioFormat("audio/m4a")).toBe("m4a");
    expect(audioFormat("audio/aac")).toBe("aac");
    expect(audioFormat("audio/ogg")).toBe("ogg");
    expect(audioFormat("audio/webm")).toBe("webm");
  });

  test("strips parameters and falls back to the subtype", () => {
    expect(audioFormat("audio/webm; codecs=opus")).toBe("webm");
    expect(audioFormat("audio/flac")).toBe("flac");
  });
});
