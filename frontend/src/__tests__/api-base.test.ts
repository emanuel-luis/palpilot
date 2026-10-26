import { afterEach, describe, expect, it, vi } from "vitest";

async function loadBase(): Promise<string> {
  vi.resetModules();
  return (await import("@/lib/api")).BASE;
}

describe("API base", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is empty when VITE_API_BASE is unset", async () => {
    vi.stubEnv("VITE_API_BASE", "");
    expect(await loadBase()).toBe("");
  });

  it("uses VITE_API_BASE and strips trailing slashes", async () => {
    vi.stubEnv("VITE_API_BASE", "/palpilot//");
    expect(await loadBase()).toBe("/palpilot");
  });

  it("is never derived from location.pathname", async () => {
    vi.stubEnv("VITE_API_BASE", "");
    vi.stubGlobal("location", { pathname: "/console/users" });
    expect(await loadBase()).toBe("");
  });
});
