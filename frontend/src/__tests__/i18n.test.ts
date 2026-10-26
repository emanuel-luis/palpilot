import { describe, expect, it } from "vitest";
import en, { t, type TKey } from "@/i18n/en";

function leaves(o: unknown, path = ""): [string, unknown][] {
  if (typeof o !== "object" || o === null) return [[path, o]];
  return Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
}

describe("en catalogue", () => {
  it("has only non-empty strings at the leaves", () => {
    for (const [path, v] of leaves(en)) {
      expect(typeof v, path).toBe("string");
      expect((v as string).length, path).toBeGreaterThan(0);
    }
  });

  it("has the app and nav basics", () => {
    expect(en.app.name).toBe("PalPilot");
    expect(Object.keys(en)).toEqual(expect.arrayContaining(["app", "common", "nav", "header", "status", "users"]));
  });
});

describe("t", () => {
  it("interpolates variables and leaves unknown placeholders visible", () => {
    expect(t("header.signedInAs", { user: "ana" })).toBe("Signed in as ana");
    expect(t("header.signedInAs", {})).toBe("Signed in as {user}");
  });
  it("returns the key for a path that is not a string", () => {
    expect(t("nope.missing" as TKey)).toBe("nope.missing");
  });
});
