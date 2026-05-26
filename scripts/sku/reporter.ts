import pc from "picocolors";
import type { ApplyResult, ProductDiff, StoreDiff } from "./types";

const summarizeStore = (d: StoreDiff | null): string => {
  if (!d) return pc.gray("skipped");
  if (d.ops.length === 0) return pc.gray("no changes");
  const creates = d.ops.filter((o) => o.kind === "create").length;
  const updates = d.ops.filter((o) => o.kind === "update").length;
  const parts: string[] = [];
  if (creates > 0) parts.push(pc.green(`+${creates}`));
  if (updates > 0) parts.push(pc.yellow(`~${updates}`));
  return parts.join(" ");
};

const renderStoreDetail = (d: StoreDiff): string[] => {
  const out: string[] = [];
  if (d.isAppleCreate) {
    out.push(
      pc.bold(
        pc.red(
          "  ⚠ Apple subscription does not yet exist. --apply requires --allow-create, " +
            "and the subscription will need App Review approval before it activates.",
        ),
      ),
    );
  }
  for (const op of d.ops) {
    if (op.kind === "create") {
      out.push(`  ${pc.green("+")} ${op.field} = ${JSON.stringify(op.value)}`);
    } else {
      out.push(
        `  ${pc.yellow("~")} ${op.field}: ${JSON.stringify(op.from)} → ${JSON.stringify(op.to)}`,
      );
    }
  }
  return out;
};

export const renderDiffs = (diffs: ProductDiff[]): string => {
  const lines: string[] = [];
  lines.push(pc.bold("Subscription SKU diff"));
  lines.push("");
  for (const d of diffs) {
    const appleSummary = summarizeStore(d.apple);
    const googleSummary = summarizeStore(d.google);
    lines.push(
      `${pc.bold(d.productId)}  apple: ${appleSummary}  google: ${googleSummary}`,
    );
    if (d.apple && d.apple.ops.length > 0) {
      lines.push(pc.cyan("  apple:"));
      lines.push(...renderStoreDetail(d.apple));
    }
    if (d.google && d.google.ops.length > 0) {
      lines.push(pc.cyan("  google:"));
      lines.push(...renderStoreDetail(d.google));
    }
    lines.push("");
  }
  return lines.join("\n");
};

export const renderApplyResults = (results: ApplyResult[]): string => {
  const lines: string[] = [];
  lines.push(pc.bold("Apply results"));
  for (const r of results) {
    const status = r.ok ? pc.green("OK") : pc.red("FAIL");
    lines.push(
      `  ${status} ${r.productId} [${r.store}] applied ${r.appliedOps} op(s)${
        r.errorMessage ? ` — ${pc.red(r.errorMessage)}` : ""
      }`,
    );
  }
  return lines.join("\n");
};
