import { mock } from "bun:test";

// mock Firebase functions

void mock.module("firebase-admin/app-check", () => ({
  getAppCheck: () => ({
    verifyToken: () => Promise.resolve(true),
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
