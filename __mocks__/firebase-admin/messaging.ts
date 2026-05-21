// Vitest auto-mock for firebase-admin/messaging.
// Test files activate this via `vi.mock("firebase-admin/messaging")` (factory-less).

export const getMessaging = () => ({
  send: (message: { token?: string }) => {
    if (message.token === "valid-fcm-token") {
      return Promise.resolve("mock-message-id");
    }
    if (message.token === "trigger-payload-size-limit") {
      const error = new Error("Payload too large") as Error & { code: string };
      error.code = "messaging/payload-size-limit-exceeded";
      return Promise.reject(error);
    }
    const error = new Error("Invalid registration token") as Error & {
      code: string;
    };
    error.code = "messaging/invalid-registration-token";
    return Promise.reject(error);
  },
});
