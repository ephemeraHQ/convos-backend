import { describe, expect, test } from "vitest";
import { extractPromptText } from "@/api/v2/agent-templates/services/bench-prompt";

describe("extractPromptText", () => {
  test("reads a completion `content` string", () => {
    expect(extractPromptText({ prompt: { content: "you are a bot" } })).toBe(
      "you are a bot",
    );
  });

  test("reads a completion `prompt` string", () => {
    expect(extractPromptText({ prompt: { prompt: "system text" } })).toBe(
      "system text",
    );
  });

  test("joins chat `messages`, skipping non-string content", () => {
    expect(
      extractPromptText({
        prompt: {
          messages: [
            { role: "system", content: "line one" },
            { role: "user", content: "line two" },
            { role: "assistant", content: { parts: ["ignored"] } },
          ],
        },
      }),
    ).toBe("line one\nline two");
  });

  test("returns empty string for missing/unknown shapes", () => {
    expect(extractPromptText(null)).toBe("");
    expect(extractPromptText({})).toBe("");
    expect(extractPromptText({ prompt: {} })).toBe("");
    expect(extractPromptText({ prompt: { messages: [] } })).toBe("");
  });
});
