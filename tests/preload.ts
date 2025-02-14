import { mock } from "bun:test";

// mock Firebase AppCheck
void mock.module("firebase-admin/app-check", () => ({
  getAppCheck: () => ({
    verifyToken: () => Promise.resolve(true),
  }),
}));
