import { mock } from "bun:test";

// mock Firebase functions

void mock.module("firebase-admin/app-check", () => ({
  getAppCheck: () => ({
    verifyToken: (token: string) => {
      if (token === "valid-app-check-token") {
        return Promise.resolve(true);
      }
      return Promise.reject(new Error("Invalid AppCheck token"));
    },
  }),
}));

void mock.module("firebase-admin", () => ({
  credential: {
    cert: () => {},
  },
}));

void mock.module("firebase-admin/app", () => ({
  initializeApp: () => {},
}));
