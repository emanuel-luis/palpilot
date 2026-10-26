import { describe, expect, it } from "vitest";
import { deCamel, formatBytes, formatDate, formatDuration, tfmt } from "@/lib/format";
import { isNotable, isPollNoise, parseLogLine } from "@/lib/logs";
import { decodeToken, isExpired, tokenExpiresSoon } from "@/lib/session";

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(50 * 1024 ** 3)).toBe("50 GB");
  });
  it("shows a dash for missing or non-finite input", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(Infinity)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("formats HH:MM:SS", () => {
    expect(formatDuration(3725)).toBe("01:02:05");
    expect(formatDuration(0)).toBe("00:00:00");
  });
  it("rejects negative and missing input", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("formatDate", () => {
  it("rejects missing and invalid input", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });
});

describe("tfmt and deCamel", () => {
  it("fills placeholders and blanks unknown ones", () => {
    expect(tfmt("{a} and {b}", { a: 1 })).toBe("1 and ");
  });
  it("turns config keys into labels", () => {
    expect(deCamel("bEnablePlayerToPlayerDamage")).toBe("Enable player to player damage");
    expect(deCamel("ServerPlayerMaxNum")).toBe("Server player max num");
  });
});

describe("parseLogLine", () => {
  it("splits the syslog prefix and tags the source", () => {
    const p = parseLogLine("2026-07-30T19:33:30.001447+00:00 palworld-tf-vm python[3814]: INFO:     started");
    expect(p).toMatchObject({ time: "19:33:30", source: "agent", label: "agent", message: "started" });
  });
  it("falls back to the raw line", () => {
    expect(parseLogLine("[    3.03] kernel thing")).toEqual({
      time: "", source: "raw", label: "", message: "[    3.03] kernel thing",
    });
  });
});

describe("log classifiers", () => {
  it("flags poll chatter but not real events", () => {
    expect(isPollNoise("[LOG] REST accessed endpoint /v1/api/players")).toBe(true);
    expect(isPollNoise("Started palworld")).toBe(false);
  });
  it("flags notable lines", () => {
    expect(isNotable("Setup completed")).toBe(true);
    expect(isNotable("connection refused")).toBe(true);
    expect(isNotable("all quiet")).toBe(false);
  });
});

describe("token helpers", () => {
  const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const mk = (payload: object) => `h.${b64url(payload)}.s`;

  it("decodes the payload and rejects malformed tokens", () => {
    expect(decodeToken(mk({ u: "ana", perms: ["view"] }))).toMatchObject({ u: "ana" });
    expect(decodeToken("nope")).toBeNull();
    expect(decodeToken("a.%%%.c")).toBeNull();
  });
  it("treats missing exp as expired and honours skew", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isExpired(null)).toBe(true);
    expect(isExpired({ u: "a", perms: [] })).toBe(true);
    expect(isExpired({ u: "a", perms: [], exp: now + 3600 })).toBe(false);
    expect(tokenExpiresSoon(mk({ u: "a", perms: [], exp: now + 100 }))).toBe(true);
    expect(tokenExpiresSoon(mk({ u: "a", perms: [], exp: now + 3600 }))).toBe(false);
  });
});
