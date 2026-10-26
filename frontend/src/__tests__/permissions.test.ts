import { describe, expect, it } from "vitest";

// The console must gate on exactly the permission names that the coordinator's route table
// and the agent's require(...) checks use. The app sources are read as text so that a typo in a
// can("...") call or in Users.tsx's KNOWN_PERMS fails here instead of hiding a button forever.
const CANONICAL = ["view", "power", "saves", "mods", "settings", "watchdog", "commands", "users"];

const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/__tests__/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("permission names used by the console", () => {
  it("reads the app sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it("passes only canonical names to can()", () => {
    const used = new Set<string>();
    for (const text of Object.values(sources)) {
      for (const m of text.matchAll(/\bcan\(\s*["']([a-z_]+)["']/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((p) => !CANONICAL.includes(p))).toEqual([]);
  });

  it("lists exactly the canonical names in Users.tsx KNOWN_PERMS", () => {
    const users = sources["/src/views/Users.tsx"];
    expect(users).toBeDefined();
    const block = /const KNOWN_PERMS = \[([^\]]*)\]/.exec(users ?? "");
    if (!block) throw new Error("KNOWN_PERMS not found in src/views/Users.tsx");
    const names = [...block[1].matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1]);
    expect(names.sort()).toEqual([...CANONICAL].sort());
  });
});
