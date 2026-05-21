// Vitest auto-mock for firebase-admin/app-check.
// Test files activate this via `vi.mock("firebase-admin/app-check")` (factory-less).

export const getAppCheck = () => ({
  verifyToken: (token: string) => {
    if (token === "valid-app-check-token") {
      return Promise.resolve(true);
    }
    return Promise.reject(new Error("Invalid AppCheck token"));
  },
  createToken: (_appId: string) => {
    return Promise.resolve({
      token: "valid-app-check-token",
    });
  },
});
