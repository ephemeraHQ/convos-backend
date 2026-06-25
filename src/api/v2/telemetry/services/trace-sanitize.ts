import { z } from "zod";
import { TELEMETRY_ALLOWED_RESOURCE_ATTRS } from "@/config";

// Loose structural validation, mirroring the metrics path in otlp.ts.
// .passthrough() everywhere: we re-serialize this body, so unknown OTLP fields
// (traceId, spanId, timestamps, kind, status, …) must survive untouched.

// Element-tolerant array: an element that fails `inner` (null, non-object,
// key-less attr, nameless span — all untrusted client input) is coerced to
// `undefined` per-element via .catch() and then filtered out, so one malformed
// element drops itself instead of rejecting the whole array or leaving a hole
// that later property access would throw on. This is what keeps a junk payload
// from 500-ing the route.
const tolerantArray = <T extends z.ZodTypeAny>(inner: T) =>
  z
    .array(inner.catch(() => undefined as unknown as z.infer<T>))
    .transform((xs) => xs.filter((x): x is z.infer<T> => x != null));

const attributeSchema = z
  .object({ key: z.string(), value: z.unknown() })
  .passthrough();

const attributeArray = tolerantArray(attributeSchema);

type Attr = z.infer<typeof attributeSchema>;

const withAttrs = z
  .object({ attributes: attributeArray.optional() })
  .passthrough();

// A malformed `resource`/`scope` (e.g. the primitive `1`) is coerced to
// `undefined` rather than failing its enclosing element — otherwise the bad
// field would drop the whole resourceSpans/scopeSpans element (and every valid
// span beneath it) via the tolerant array. The dropped field is harmless:
// applyServerResourceAttributes re-creates `resource`, and scope attrs are
// denied wholesale anyway.
const tolerantWithAttrs = withAttrs.optional().catch(undefined);

const spanSchema = z
  .object({
    name: z.string(),
    attributes: attributeArray.optional(),
    events: tolerantArray(withAttrs).optional(),
    links: tolerantArray(withAttrs).optional(),
  })
  .passthrough();

const scopeSpansSchema = z
  .object({
    scope: tolerantWithAttrs,
    spans: tolerantArray(spanSchema).default([]),
  })
  .passthrough();

const resourceSpansSchema = z
  .object({
    resource: tolerantWithAttrs,
    scopeSpans: tolerantArray(scopeSpansSchema).default([]),
  })
  .passthrough();

// Top-level array is tolerant too: a single malformed resourceSpans element
// (e.g. null, or one whose `resource` is a primitive) must NOT fail the whole
// parse — that would make sanitizeTraces return early and the handler forward
// the body UNSANITIZED, bypassing the PII/cardinality strip.
const tracesBodySchema = z
  .object({ resourceSpans: tolerantArray(resourceSpansSchema) })
  .passthrough();

// Bounded set of span-level attributes clients are allowed to emit.
// "convos.flavor" — build variant (e.g. nightly, production).
// "agent.template_id" — agent identity (low-cardinality UUID allowlisted by design).
// "outcome" — terminal result of a span (e.g. success, failure).
const ALLOWED_SPAN_ATTRS = new Set([
  "convos.flavor",
  "agent.template_id",
  "outcome",
]);

// Span names become Datadog APM operation names; allowlist to bound cardinality,
// mirroring the metrics name allowlist in otlp.ts. Spans with any other name are
// dropped before forwarding — a future accidental high-cardinality name (e.g.
// "agent.ready.<templateId>") would otherwise create an APM cost/cardinality problem.
const ALLOWED_SPAN_NAMES = new Set(["agent.join", "agent.ready"]);

// Filter a container's `attributes` against an allowlist, in place. The schema
// has already coerced `attributes` to a (possibly absent) array of valid Attrs.
function filterAttrs(
  container: { attributes?: Attr[] },
  allow: ReadonlySet<string>,
): void {
  if (container.attributes !== undefined) {
    container.attributes = container.attributes.filter((a) => allow.has(a.key));
  }
}

/** Strip non-allowlisted resource + span attributes from an OTLP traces body
 *  in place (cardinality/PII guard). Unparseable / non-conforming bodies are
 *  left untouched — the handler's structural check produces the 400, and the
 *  schema is lenient (.passthrough(), element-tolerant arrays) so only a
 *  fundamentally wrong top-level shape fails to parse.
 *
 *  Walks all attribute containers:
 *   - resource.attributes       (allowlisted by TELEMETRY_ALLOWED_RESOURCE_ATTRS)
 *   - scopeSpans[].scope.attributes  (zeroed — same trust boundary as resource attrs)
 *   - span.attributes           (allowlisted by ALLOWED_SPAN_ATTRS)
 *   - span.events[].attributes  (allowlisted by ALLOWED_SPAN_ATTRS)
 *   - span.links[].attributes   (allowlisted by ALLOWED_SPAN_ATTRS)
 *
 *  Spans whose name is not on ALLOWED_SPAN_NAMES are dropped entirely — this is
 *  a deliberate APM operation-name cardinality/cost guard, NOT a passthrough.
 *  The dropped names are returned so the handler can log them, making the loss
 *  observable rather than silent (mirrors the metrics path's stripped-key logs).
 */
export function sanitizeTraces(body: unknown): { droppedSpanNames: string[] } {
  const droppedSpanNames = new Set<string>();
  const parsed = tracesBodySchema.safeParse(body);
  if (!parsed.success) return { droppedSpanNames: [] };
  const data = parsed.data;

  for (const rs of data.resourceSpans) {
    if (rs.resource) filterAttrs(rs.resource, TELEMETRY_ALLOWED_RESOURCE_ATTRS);
    for (const ss of rs.scopeSpans) {
      // Scope attributes are never forwarded — same trust boundary as
      // resource/point attrs, with no known legitimate use from clients.
      if (ss.scope?.attributes !== undefined) ss.scope.attributes = [];

      ss.spans = ss.spans.filter((s) => {
        if (ALLOWED_SPAN_NAMES.has(s.name)) return true;
        droppedSpanNames.add(s.name);
        return false;
      });
      for (const s of ss.spans) {
        filterAttrs(s, ALLOWED_SPAN_ATTRS);
        for (const ev of s.events ?? []) filterAttrs(ev, ALLOWED_SPAN_ATTRS);
        for (const lk of s.links ?? []) filterAttrs(lk, ALLOWED_SPAN_ATTRS);
      }
    }
  }

  // safeParse returns a deep clone, so the sanitized tree lives on `data`, not
  // the caller's object. Write the one branch we transformed back onto `body`
  // so the in-place contract holds (the handler forwards `body` and then runs
  // applyServerResourceAttributes over the same object).
  (body as { resourceSpans: unknown }).resourceSpans = data.resourceSpans;
  return { droppedSpanNames: [...droppedSpanNames] };
}

/** Stamp server-authoritative `service.name` and `deployment.environment` on
 *  every `resourceSpans[].resource.attributes`, in place.
 *
 *  These two attributes are derived server-side (service.name from the verified
 *  App Check appId, environment from config) and are NEVER trusted from the
 *  client — same policy as the metrics path. Any client-supplied value for
 *  either key is removed and replaced. Must run AFTER sanitizeTraces so the
 *  override values aren't stripped by the resource-attr allowlist.
 *
 *  Creates a missing `resource`/`attributes` so attribution is guaranteed, and
 *  replaces a non-array `attributes` (malformed input) rather than throwing.
 */
export function applyServerResourceAttributes(
  body: unknown,
  opts: { serviceName: string; environment: string },
): void {
  if (typeof body !== "object" || body === null) return;
  const rs = (body as { resourceSpans?: unknown[] }).resourceSpans;
  if (!Array.isArray(rs)) return;
  for (const r of rs) {
    if (typeof r !== "object" || r === null) continue;
    // `resource` is untrusted (unknown), so guard its runtime shape: replace a
    // missing OR non-object value (e.g. a primitive like `{ resource: 1 }`) with
    // a fresh object — otherwise `resource.attributes = …` below throws (500).
    const container = r as { resource?: { attributes?: unknown } | null };
    const resource: { attributes?: unknown } =
      typeof container.resource === "object" && container.resource !== null
        ? container.resource
        : (container.resource = {});
    const existing = resource.attributes;
    const kept = (
      Array.isArray(existing) ? (existing as unknown[]) : []
    ).filter(
      (a): a is Attr =>
        a != null &&
        typeof a === "object" &&
        typeof (a as { key?: unknown }).key === "string" &&
        (a as { key: string }).key !== "service.name" &&
        (a as { key: string }).key !== "deployment.environment",
    );
    kept.push(
      { key: "service.name", value: { stringValue: opts.serviceName } },
      {
        key: "deployment.environment",
        value: { stringValue: opts.environment },
      },
    );
    resource.attributes = kept;
  }
}
