import { afterEach, describe, expect, it } from "vitest";
import { session } from "@/stores/session";
import { fixtures } from "@/mocks/fixtures";
import en from "@/i18n/en";

const PERMS = ["view", "power", "saves", "mods", "settings", "watchdog", "commands", "users"];

describe("session.can", () => {
  afterEach(() => session.clear());

  it("is false when signed out", () => {
    session.clear();
    expect(session.can("view")).toBe(false);
  });

  it("grants only the perms the session carries", () => {
    session.setSession("t", "ana", ["view", "power"]);
    expect(session.can("view")).toBe(true);
    expect(session.can("power")).toBe(true);
    expect(session.can("users")).toBe(false);
  });

  it("expands the legacy config perm into saves, mods, settings and watchdog", () => {
    session.setSession("t", "ana", ["view", "config"]);
    for (const p of ["saves", "mods", "settings", "watchdog"]) expect(session.can(p)).toBe(true);
    expect(session.can("users")).toBe(false);
    expect(session.can("commands")).toBe(false);
  });
});

describe("console permission set", () => {
  it("is exactly view, power, saves, mods, settings, watchdog, commands, users", () => {
    expect([...fixtures.all_perms].sort()).toEqual([...PERMS].sort());
  });

  it("has a label for every permission (plus the legacy config)", () => {
    expect(Object.keys(en.users.perm).sort()).toEqual([...PERMS, "config"].sort());
  });
});
