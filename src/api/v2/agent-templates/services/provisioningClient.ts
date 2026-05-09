/**
 * ProvisioningClient — HTTP client for the assistant-runtime-provisioning API.
 *
 * Methods:
 *   createAssistant({ name, instructions, joinUrl, profileImage?, metadata? })
 *     → POST /api/assistants → { instanceId }
 *   getAssistant(instanceId)
 *     → GET /api/assistants/:instanceId → { instanceId, joinStatus, inboxId?, ... }
 *
 * Auth: Bearer token from PROVISIONING_API_KEY env var.
 * Base URL: PROVISIONING_API_URL env var.
 * Lazy init: env vars are read at call time, not at import time.
 *
 * Test seam: `__resetProvisioningClientForTests(override | null)` mirrors the
 * `__resetGenerateTemplateForTests` / `__resetPostHogForTests` pattern.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateAssistantOpts {
  name: string;
  instructions: string;
  joinUrl: string;
  profileImage?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAssistantResult {
  instanceId: string;
}

export interface GetAssistantResult {
  instanceId: string;
  joinStatus: "starting" | "pending_acceptance" | "joined" | "failed";
  inboxId?: string | null;
  conversationId?: string | null;
  joinFailureReason?: string | null;
  createdAt: string;
  destroyedAt?: string | null;
}

export interface ProvisioningClientOverride {
  createAssistant?: (
    opts: CreateAssistantOpts,
  ) => Promise<CreateAssistantResult>;
  getAssistant?: (instanceId: string) => Promise<GetAssistantResult>;
}

// ---------------------------------------------------------------------------
// Lazy env var access — reads at call time, not import time
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const url = process.env.PROVISIONING_API_URL;
  if (!url) {
    throw new Error(
      "PROVISIONING_API_URL is not configured. Set the environment variable to the provisioning base URL.",
    );
  }
  return url;
}

function getApiKey(): string {
  const key = process.env.PROVISIONING_API_KEY;
  if (!key) {
    throw new Error(
      "PROVISIONING_API_KEY is not configured. Set the environment variable to your provisioning API key.",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Test seam — singleton override pattern
// ---------------------------------------------------------------------------

let _override: ProvisioningClientOverride | null = null;

/**
 * Install a test override for ProvisioningClient methods.
 * Pass `null` to restore normal behaviour.
 */
export function __resetProvisioningClientForTests(
  override: ProvisioningClientOverride | null,
): void {
  _override = override;
}

// ---------------------------------------------------------------------------
// ProvisioningClient
// ---------------------------------------------------------------------------

export const ProvisioningClient = {
  /**
   * Create an assistant instance on the provisioning service.
   *
   * POST /api/assistants with JSON body { name, instructions, joinUrl, profileImage?, metadata? }
   * Returns { instanceId } on success.
   * Throws on non-2xx responses or network errors.
   */
  async createAssistant(
    opts: CreateAssistantOpts,
  ): Promise<CreateAssistantResult> {
    // Test seam: delegate to override if installed
    if (_override?.createAssistant) {
      return _override.createAssistant(opts);
    }

    const baseUrl = getBaseUrl();
    const apiKey = getApiKey();

    const body: Record<string, unknown> = {
      name: opts.name,
      instructions: opts.instructions,
      joinUrl: opts.joinUrl,
    };
    if (opts.profileImage !== undefined) {
      body.profileImage = opts.profileImage;
    }
    if (opts.metadata !== undefined) {
      body.metadata = opts.metadata;
    }

    const url = `${baseUrl}/api/assistants`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ProvisioningClient: network error calling POST /api/assistants — ${message}`,
      );
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new Error(
        `ProvisioningClient: POST /api/assistants returned ${response.status} — ${responseBody}`,
      );
    }

    const data = (await response.json()) as { instanceId: string };
    return { instanceId: data.instanceId };
  },

  /**
   * Get the status of an assistant instance on the provisioning service.
   *
   * GET /api/assistants/:instanceId
   * Returns the full status object with joinStatus, inboxId, etc.
   * Throws on non-2xx responses or network errors.
   */
  async getAssistant(instanceId: string): Promise<GetAssistantResult> {
    // Test seam: delegate to override if installed
    if (_override?.getAssistant) {
      return _override.getAssistant(instanceId);
    }

    const baseUrl = getBaseUrl();
    const apiKey = getApiKey();

    const url = `${baseUrl}/api/assistants/${encodeURIComponent(instanceId)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ProvisioningClient: network error calling GET /api/assistants/${instanceId} — ${message}`,
      );
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new Error(
        `ProvisioningClient: GET /api/assistants/${instanceId} returned ${response.status} — ${responseBody}`,
      );
    }

    const data = (await response.json()) as GetAssistantResult;
    return data;
  },
};
