import type { Server } from "node:http";
import type {
  AuthConfigListParams,
  AuthConfigListResponse,
  ConnectedAccountListResponse,
  ConnectedAccountListResponseItem,
  ConnectionRequest,
} from "@composio/core";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  __resetComposioServiceForTests,
  ComposioService,
} from "@/api/v2/connections/composio.service";
import { connectionsRouter } from "@/api/v2/connections/connections.router";
import { authMiddleware } from "@/middleware/auth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// Stub shapes — match just what the service touches on the Composio client.
type ConnectedAccountsStub = {
  initiate: (
    userId: string,
    authConfigId: string,
    options?: { callbackUrl?: string },
  ) => Promise<ConnectionRequest>;
  list: (query: {
    userIds?: string[] | null;
  }) => Promise<ConnectedAccountListResponse>;
  delete: (id: string) => Promise<unknown>;
};

type AuthConfigsStub = {
  list: (query?: AuthConfigListParams) => Promise<AuthConfigListResponse>;
};

type ComposioStub = {
  connectedAccounts: ConnectedAccountsStub;
  authConfigs: AuthConfigsStub;
};

const AUTH_CONFIG_ID = "ac_test_google_calendar";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/connections", authMiddleware, connectionsRouter);

let server: Server;
const baseURL = "http://localhost:4012";

function makeStub(
  options: {
    overrides?: Partial<ConnectedAccountsStub>;
    authConfigsOverride?: Partial<AuthConfigsStub>;
  } = {},
): {
  stub: ComposioStub;
  calls: {
    initiate: Array<{
      userId: string;
      authConfigId: string;
      callbackUrl?: string;
    }>;
    list: Array<{ userIds?: string[] | null }>;
    delete: string[];
    authConfigsList: AuthConfigListParams[];
  };
  accounts: Map<string, ConnectedAccountListResponseItem & { userId: string }>;
} {
  const accounts = new Map<
    string,
    ConnectedAccountListResponseItem & { userId: string }
  >();
  const calls = {
    initiate: [] as Array<{
      userId: string;
      authConfigId: string;
      callbackUrl?: string;
    }>,
    list: [] as Array<{ userIds?: string[] | null }>,
    delete: [] as string[],
    authConfigsList: [] as AuthConfigListParams[],
  };
  const defaults: ConnectedAccountsStub = {
    initiate: (userId, authConfigId, options) => {
      calls.initiate.push({
        userId,
        authConfigId,
        callbackUrl: options?.callbackUrl,
      });
      const id = `conn_${accounts.size + 1}`;
      accounts.set(id, {
        id,
        userId,
        authConfig: {
          id: authConfigId,
          isComposioManaged: true,
          isDisabled: false,
        },
        status: "INITIATED",
        statusReason: null,
        toolkit: { slug: "google_calendar" },
        isDisabled: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      return Promise.resolve({
        id,
        status: "INITIATED",
        redirectUrl: "https://composio.example/auth",
        waitForConnection: () => Promise.reject(new Error("not used in tests")),
        toJSON: () => ({
          id,
          status: "INITIATED",
          redirectUrl: "https://composio.example/auth",
        }),
        toString: () => id,
      });
    },
    list: (query) => {
      calls.list.push(query);
      const wanted = query.userIds ?? [];
      const items = Array.from(accounts.values())
        .filter((a) => wanted.length === 0 || wanted.includes(a.userId))
        .map(({ userId: _userId, ...rest }) => rest);
      return Promise.resolve({ items, totalPages: 1, nextCursor: null });
    },
    delete: (id) => {
      calls.delete.push(id);
      accounts.delete(id);
      return Promise.resolve({ id, deleted: true });
    },
  };
  const connectedAccounts: ConnectedAccountsStub = {
    ...defaults,
    ...(options.overrides ?? {}),
  };

  const authConfigsDefaults: AuthConfigsStub = {
    list: (query) => {
      calls.authConfigsList.push(query ?? {});
      const toolkit = query?.toolkit ?? "google_calendar";
      return Promise.resolve({
        items: [
          {
            id: AUTH_CONFIG_ID,
            name: `${toolkit} (test)`,
            toolkit: { slug: toolkit, logo: "" },
            noOfConnections: 0,
            status: "ENABLED",
            uuid: "uuid-test",
          },
        ],
        nextCursor: null,
        totalPages: 1,
      });
    },
  };
  const authConfigs: AuthConfigsStub = {
    ...authConfigsDefaults,
    ...(options.authConfigsOverride ?? {}),
  };
  return {
    stub: { connectedAccounts, authConfigs },
    calls,
    accounts,
  };
}

function installStub(stub: ComposioStub) {
  const service = new ComposioService({
    // The service only touches `composio.connectedAccounts` and
    // `composio.authConfigs`; cast through unknown so we don't need
    // the full client surface in tests.
    composio: stub as unknown as ConstructorParameters<
      typeof ComposioService
    >[0]["composio"],
  });
  __resetComposioServiceForTests(service);
  return service;
}

describe("Connections API", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4012, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    __resetComposioServiceForTests(null);
  });

  beforeEach(() => {
    __resetComposioServiceForTests(null);
  });

  describe("auth", () => {
    test("initiate returns 401 without auth", async () => {
      installStub(makeStub().stub);
      const res = await fetch(`${baseURL}/api/v2/connections/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: "google_calendar" }),
      });
      expect(res.status).toBe(401);
    });

    test("complete returns 401 without auth", async () => {
      installStub(makeStub().stub);
      const res = await fetch(`${baseURL}/api/v2/connections/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionRequestId: "conn_1" }),
      });
      expect(res.status).toBe(401);
    });

    test("list returns 401 without auth", async () => {
      installStub(makeStub().stub);
      const res = await fetch(`${baseURL}/api/v2/connections`, {
        method: "GET",
      });
      expect(res.status).toBe(401);
    });

    test("delete returns 401 without auth", async () => {
      installStub(makeStub().stub);
      const res = await fetch(`${baseURL}/api/v2/connections/conn_1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("happy path", () => {
    test("initiate forwards deviceId as userId and maps serviceId to authConfigId", async () => {
      const { stub, calls } = makeStub();
      installStub(stub);
      const deviceId = "device-abc";
      const token = await createJwtToken({ deviceId });

      const res = await fetch(`${baseURL}/api/v2/connections/initiate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Convos-AuthToken": token,
        },
        body: JSON.stringify({ serviceId: "google_calendar" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        connectionRequestId: string;
        redirectUrl: string;
      };
      expect(body.connectionRequestId).toBe("conn_1");
      expect(body.redirectUrl).toBe("https://composio.example/auth");
      expect(calls.initiate[0]?.userId).toBe(deviceId);
      expect(calls.initiate[0]?.authConfigId).toBe(AUTH_CONFIG_ID);
      // No redirectUri in body → service falls back to the env default.
      expect(calls.initiate[0]?.callbackUrl).toBe(
        "convos://connections/callback",
      );
    });

    test("initiate forwards per-request redirectUri to Composio", async () => {
      const { stub, calls } = makeStub();
      installStub(stub);
      const deviceId = "device-abc";
      const token = await createJwtToken({ deviceId });

      const res = await fetch(`${baseURL}/api/v2/connections/initiate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Convos-AuthToken": token,
        },
        body: JSON.stringify({
          serviceId: "google_calendar",
          redirectUri: "convos-dev://connections/callback",
        }),
      });

      expect(res.status).toBe(200);
      expect(calls.initiate[0]?.callbackUrl).toBe(
        "convos-dev://connections/callback",
      );
    });

    test("initiate rejects malformed redirectUri", async () => {
      const { stub } = makeStub();
      installStub(stub);
      const token = await createJwtToken({ deviceId: "device-abc" });

      const res = await fetch(`${baseURL}/api/v2/connections/initiate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Convos-AuthToken": token,
        },
        body: JSON.stringify({
          serviceId: "google_calendar",
          redirectUri: "not a url",
        }),
      });

      expect(res.status).toBe(400);
    });

    test("complete returns mapped response for owned connection", async () => {
      const { stub, accounts } = makeStub();
      installStub(stub);
      const deviceId = "device-abc";
      accounts.set("conn_owned", {
        id: "conn_owned",
        userId: deviceId,
        authConfig: {
          id: AUTH_CONFIG_ID,
          isComposioManaged: true,
          isDisabled: false,
        },
        status: "ACTIVE",
        statusReason: null,
        toolkit: { slug: "google_calendar" },
        isDisabled: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const token = await createJwtToken({ deviceId });

      const res = await fetch(`${baseURL}/api/v2/connections/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Convos-AuthToken": token,
        },
        body: JSON.stringify({ connectionRequestId: "conn_owned" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        connectionId: string;
        composioEntityId: string;
        status: string;
        serviceId: string;
      };
      expect(body.connectionId).toBe("conn_owned");
      expect(body.composioEntityId).toBe(deviceId);
      expect(body.serviceId).toBe("google_calendar");
      expect(body.status).toBe("ACTIVE");
    });

    test("list returns only this device's connections", async () => {
      const { stub, accounts } = makeStub();
      installStub(stub);
      const deviceId = "device-abc";
      accounts.set("conn_1", {
        id: "conn_1",
        userId: deviceId,
        authConfig: {
          id: AUTH_CONFIG_ID,
          isComposioManaged: true,
          isDisabled: false,
        },
        status: "ACTIVE",
        statusReason: null,
        toolkit: { slug: "google_calendar" },
        isDisabled: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      accounts.set("conn_other", {
        id: "conn_other",
        userId: "someone-else",
        authConfig: {
          id: AUTH_CONFIG_ID,
          isComposioManaged: true,
          isDisabled: false,
        },
        status: "ACTIVE",
        statusReason: null,
        toolkit: { slug: "google_calendar" },
        isDisabled: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const token = await createJwtToken({ deviceId });

      const res = await fetch(`${baseURL}/api/v2/connections`, {
        method: "GET",
        headers: { "X-Convos-AuthToken": token },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        connections: Array<{ connectionId: string }>;
      };
      expect(body.connections.map((c) => c.connectionId)).toEqual(["conn_1"]);
    });

    test("delete removes owned connection and returns 204", async () => {
      const { stub, accounts, calls } = makeStub();
      installStub(stub);
      const deviceId = "device-abc";
      accounts.set("conn_owned", {
        id: "conn_owned",
        userId: deviceId,
        authConfig: {
          id: AUTH_CONFIG_ID,
          isComposioManaged: true,
          isDisabled: false,
        },
        status: "ACTIVE",
        statusReason: null,
        toolkit: { slug: "google_calendar" },
        isDisabled: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const token = await createJwtToken({ deviceId });

      const res = await fetch(`${baseURL}/api/v2/connections/conn_owned`, {
        method: "DELETE",
        headers: { "X-Convos-AuthToken": token },
      });

      expect(res.status).toBe(204);
      expect(calls.delete).toEqual(["conn_owned"]);
    });
  });

  describe("entity mismatch", () => {
    test("complete returns 403 when connection belongs to another device", async () => {
      const { stub, accounts } = makeStub();
      installStub(stub);
      accounts.set("conn_other", {
        id: "conn_other",
        userId: "some-other-device",
        authConfig: {
          id: AUTH_CONFIG_ID,
          isComposioManaged: true,
          isDisabled: false,
        },
        status: "ACTIVE",
        statusReason: null,
        toolkit: { slug: "google_calendar" },
        isDisabled: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const token = await createJwtToken({ deviceId: "device-abc" });

      const res = await fetch(`${baseURL}/api/v2/connections/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Convos-AuthToken": token,
        },
        body: JSON.stringify({ connectionRequestId: "conn_other" }),
      });

      expect(res.status).toBe(403);
    });

    test("delete returns 403 when connection belongs to another device", async () => {
      const { stub, accounts, calls } = makeStub();
      installStub(stub);
      accounts.set("conn_other", {
        id: "conn_other",
        userId: "some-other-device",
        authConfig: {
          id: AUTH_CONFIG_ID,
          isComposioManaged: true,
          isDisabled: false,
        },
        status: "ACTIVE",
        statusReason: null,
        toolkit: { slug: "google_calendar" },
        isDisabled: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const token = await createJwtToken({ deviceId: "device-abc" });

      const res = await fetch(`${baseURL}/api/v2/connections/conn_other`, {
        method: "DELETE",
        headers: { "X-Convos-AuthToken": token },
      });

      expect(res.status).toBe(403);
      expect(calls.delete).toEqual([]);
    });
  });

  describe("validation", () => {
    test("initiate returns 400 when Composio has no enabled auth config for serviceId", async () => {
      const { stub } = makeStub({
        authConfigsOverride: {
          list: () =>
            Promise.resolve({ items: [], nextCursor: null, totalPages: 0 }),
        },
      });
      installStub(stub);
      const token = await createJwtToken({ deviceId: "device-abc" });
      const res = await fetch(`${baseURL}/api/v2/connections/initiate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Convos-AuthToken": token,
        },
        body: JSON.stringify({ serviceId: "unknown_service" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
