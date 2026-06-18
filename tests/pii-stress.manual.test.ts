/**
 * Manual stress harness for redactTemplatePii — makes REAL OpenRouter calls.
 *
 * Gated on PII_STRESS_KEY so it never runs in CI or a normal `vitest run`.
 * Run it with a real OpenRouter key:
 *
 *   PII_STRESS_KEY=sk-or-... pnpm exec vitest run tests/pii-stress.manual.test.ts
 *
 * Optionally override the model:
 *   PII_STRESS_MODEL=anthropic/claude-haiku-4-5 PII_STRESS_KEY=... pnpm exec vitest run ...
 */

/* eslint-disable no-console */

import { beforeAll, describe, expect, test } from "vitest";
import {
  __setBuilderApiKeyOverrideForTests,
  __setPiiModelOverrideForTests,
  redactTemplatePii,
  type RedactableFields,
} from "@/api/v2/agent-templates/services/moderation";

const KEY = process.env.PII_STRESS_KEY;
const MODEL = process.env.PII_STRESS_MODEL ?? null;

const CASES: { name: string; fields: RedactableFields }[] = [
  {
    name: "email + phone + name in prompt",
    fields: {
      agentName: "Recipe Buddy",
      description: "A friendly cooking helper",
      prompt:
        "You help users cook. If they get stuck, tell them to email the creator John Smith at john.smith@gmail.com or call 415-555-0123.",
    },
  },
  {
    name: "street address + contextual name",
    fields: {
      agentName: "Office Concierge",
      description: "Helps visitors to our office",
      prompt:
        "Our office is at 1200 Market Street, Suite 400, San Francisco. Greet visitors warmly and direct them to Maria in HR on the 4th floor.",
    },
  },
  {
    name: "spanish names/contextual + intl phone",
    fields: {
      agentName: "Asistente de Clínica",
      description: "Agenda citas para pacientes",
      prompt:
        "Eres el asistente del Dr. Rodríguez. La clínica está frente a la Plaza Bolívar. Para confirmar, llama a la paciente Ana María González al +57 300 123 4567.",
    },
  },
  {
    name: "clean — no PII expected",
    fields: {
      agentName: "Math Tutor",
      description: "Helps students with algebra",
      prompt:
        "You are a patient math tutor. Explain concepts step by step, then give two practice problems and check the answers.",
    },
  },
  {
    name: "card number + SSN",
    fields: {
      agentName: "Billing Helper",
      description: "Answers billing questions",
      prompt:
        "For refunds, reference the card on file 4111 1111 1111 1111. The account owner's SSN is 123-45-6789.",
    },
  },
  {
    name: "name in agentName + description",
    fields: {
      agentName: "Bob Johnson's Personal Assistant",
      description: "Personal helper for Bob Johnson",
      prompt:
        "Act as a personal assistant. Schedule meetings, summarize emails, and draft polite replies.",
    },
  },
];

describe.runIf(KEY)("redactTemplatePii — live stress", () => {
  beforeAll(() => {
    __setBuilderApiKeyOverrideForTests(KEY as string);
    if (MODEL) __setPiiModelOverrideForTests(MODEL);
  });

  test(
    "prompt → redacted output across cases",
    async () => {
      const latencies: number[] = [];
      console.log(
        `\n##### PII redaction stress — model: ${MODEL ?? "default (gemini-3.1-flash-lite)"} #####`,
      );

      for (const c of CASES) {
        const t0 = Date.now();
        let out: Awaited<ReturnType<typeof redactTemplatePii>> | null = null;
        let err: unknown = null;
        try {
          out = await redactTemplatePii(c.fields);
        } catch (e) {
          err = e;
        }
        const ms = Date.now() - t0;
        latencies.push(ms);

        if (err) {
          console.log(`\n=== ${c.name} — ERROR after ${ms}ms (fail-closed)`);
          console.log(`    ${(err as Error).message}`);
          continue;
        }

        const { fields, findings } = out!;
        console.log(
          `\n=== ${c.name}  (${ms}ms · ${findings.length} findings) ===`,
        );
        for (const k of ["agentName", "description", "prompt"] as const) {
          const before = c.fields[k];
          const after = fields[k];
          if (before === undefined) continue;
          if (before !== after) {
            console.log(`  [${k}] BEFORE: ${before}`);
            console.log(`  [${k}] AFTER : ${after}`);
          } else {
            console.log(`  [${k}] (unchanged)`);
          }
        }
        console.log(`  findings: ${JSON.stringify(findings)}`);
      }

      const sorted = [...latencies].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)];
      const max = sorted[sorted.length - 1];
      console.log(`\n##### latency: p50 ${p50}ms · max ${max}ms #####\n`);

      expect(latencies.length).toBe(CASES.length);
    },
    120_000,
  );
});
