import { describe, expect, test } from "bun:test";
import {
  templatePublicUrl,
  templateUrlFromUrlSlug,
} from "@/api/v2/agent-templates/lib/template-url";
import { BUILDER_SITE_URL } from "@/config";
import { buildUrlSlug } from "@/utils/url-slug";

describe("template public URL helpers", () => {
  // BUILDER_SITE_URL default ("https://dev.convos.org") carries no trailing
  // slash; agent pages live under the `/a/` segment.
  test("templateUrlFromUrlSlug joins origin + /a/ + already-hashed slug", () => {
    expect(templateUrlFromUrlSlug("brewski.x4f9k")).toBe(
      `${BUILDER_SITE_URL}/a/brewski.x4f9k`,
    );
  });

  test("templatePublicUrl builds origin + /a/ + canonical <base>.<hash>", () => {
    const url = templatePublicUrl("brewski", "tmpl_abc123");
    expect(url).toBe(
      `${BUILDER_SITE_URL}/a/${buildUrlSlug("brewski", "tmpl_abc123")}`,
    );
    expect(url).toMatch(/\/a\/brewski\.[0-9a-z]{5}$/);
  });
});
