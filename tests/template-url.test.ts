import { describe, expect, test } from "bun:test";
import {
  templatePublicUrl,
  templateUrlFromHashedSlug,
} from "@/api/v2/agent-templates/lib/template-url";
import { BUILDER_SITE_URL } from "@/config";
import { buildSlug } from "@/utils/slug-hash";

describe("template public URL helpers", () => {
  // BUILDER_SITE_URL default ("https://convos.org/assistants") carries no
  // trailing slash, so the join here is a plain `${origin}/${slug}`.
  test("templateUrlFromHashedSlug joins origin + already-hashed slug", () => {
    expect(templateUrlFromHashedSlug("brewski.x4f9k")).toBe(
      `${BUILDER_SITE_URL}/brewski.x4f9k`,
    );
  });

  test("templatePublicUrl builds origin + canonical <base>.<hash>", () => {
    const url = templatePublicUrl("brewski", "tmpl_abc123");
    expect(url).toBe(
      `${BUILDER_SITE_URL}/${buildSlug("brewski", "tmpl_abc123")}`,
    );
    expect(url).toMatch(/\/brewski\.[0-9a-z]{5}$/);
  });
});
