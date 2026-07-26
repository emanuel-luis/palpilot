// Mock request router. Handles every path the app calls.

type Ctx = {
  method: string; path: string; query: URLSearchParams;
  body: BodyInit | null | undefined;
  fixtures: any; knobs: any;
};

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function textRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
async function readJson(b: BodyInit | null | undefined): Promise<any> {
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  if (b instanceof Blob) { try { return JSON.parse(await b.text()); } catch { return {}; } }
  return {};
}
function makeToken(user: string, perms: string[]): string {
  const header = btoa(JSON.stringify({ typ: "PP", alg: "HS256" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({ u: user, perms, iat: now, exp: now + 3600 * 12, ver: 1 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const sig = "mocksig";
  return `${header}.${payload}.${sig}`;
}

export async function handle(ctx: Ctx): Promise<Response> {
  const { method, path, query, fixtures: fx, knobs } = ctx;

  // ── auth ────────────────────────────────────────────────────────────
  if (path === "/api/login" && method === "POST") {
    const b = await readJson(ctx.body);
    if (!b.username || !b.password) return json({ ok: false, error: "invalid credentials" }, 401);
    const user = fx.users.find((u: any) => u.username === b.username);
    if (!user) return json({ ok: false, error: "invalid credentials" }, 401);
    const perms = user.effective_perms;
    return json({ ok: true, error: null, token: makeToken(user.username, perms), user: user.username, perms, exp: Math.floor(Date.now() / 1000) + 3600 * 12 });
  }
  if (path === "/api/session" && method === "GET") {
    // In mocks we honor the role knob: switching the knob returns those perms.
    const uname = knobs.role;
    const user = fx.users.find((u: any) => u.username === uname) || fx.users[0];
    return json({ ok: true, error: null, user: user.username, perms: user.effective_perms });
  }
  if (path === "/api/logout" && method === "POST") return json({ ok: true, error: null });
  if (path === "/api/logout-all" && method === "POST") return json({ ok: true, error: null, ver: 2 });
  if (path === "/api/account/password" && method === "POST") {
    const b = await readJson(ctx.body);
    if (!b.old) return json({ ok: false, error: "current password is incorrect" }, 401);
    if (!b.new || b.new.length < 8) return json({ ok: false, error: "new password must be at least 8 characters" }, 400);
    return json({ ok: true, error: null, ver: 3 });
  }

  // ── overview ────────────────────────────────────────────────────────
  if (path === "/api/overview" && method === "GET") {
    const force = knobs.vmForce;
    let vm = fx.vm;
    let server = fx.server;
    if (force === "off")      { vm = { ...vm, status: "TERMINATED" }; server = null; }
    else if (force === "starting") { vm = { ...vm, status: "RUNNING" }; server = null; }
    else if (force === "on")  {
      vm = { ...vm, status: "RUNNING" };
      server = {
        info: { version: "0.5.0", servername: fx.config.options.ServerName, description: fx.config.options.ServerDescription },
        metrics: { serverfps: 60, currentplayernum: knobs.showPlayers ? fx.playersSample.length : 0, maxplayernum: 16, uptime: 8123, days: 47, serverframetime: 16.7 },
        players: knobs.showPlayers ? fx.playersSample : [],
      };
    } else if (force === "STOPPING") { vm = { ...vm, status: "STOPPING" }; server = null; }
    return json({ ok: true, error: null, vm, server });
  }
  if (path === "/api/vm/start" && method === "POST") {
    fx.vm.status = "RUNNING"; fx.server = null;
    setTimeout(() => {
      fx.server = {
        info: { version: "0.5.0", servername: fx.config.options.ServerName, description: fx.config.options.ServerDescription },
        metrics: { serverfps: 60, currentplayernum: 0, maxplayernum: 16, uptime: 0, days: 47, serverframetime: 16.7 },
        players: [],
      };
    }, 4000);
    return json({ ok: true, error: null, starting: true });
  }
  if (path === "/api/vm/stop" && method === "POST") {
    fx.vm.status = "TERMINATED"; fx.server = null;
    return json({ ok: true, error: null, stopping: true });
  }

  // ── watchdog ────────────────────────────────────────────────────────
  if (path === "/api/watchdog" && method === "GET") return json({ ok: true, error: null, ...fx.watchdog });
  if (path === "/api/watchdog" && method === "POST") {
    const b = await readJson(ctx.body);
    if (b.poll_seconds < 10 || b.poll_seconds > 3600) return json({ ok: false, error: "poll_seconds out of range" }, 400);
    if (b.grace_seconds < 60 || b.grace_seconds > 86400) return json({ ok: false, error: "grace_seconds out of range" }, 400);
    fx.watchdog = { poll_seconds: b.poll_seconds, grace_seconds: b.grace_seconds };
    return json({ ok: true, error: null, ...fx.watchdog });
  }

  // ── vm_offline gate for VM-required routes ──────────────────────────
  const vmRequired = /^\/api\/(rest|config|saves|mods|restart)/.test(path);
  if (vmRequired && fx.vm.status !== "RUNNING") {
    return json({ ok: false, error: "vm_offline", status: fx.vm.status }, 503);
  }
  if (knobs.next503) { knobs.next503 = false; return json({ ok: false, error: "vm_offline", status: fx.vm.status }, 503); }

  // ── rest passthrough ────────────────────────────────────────────────
  if (path.startsWith("/api/rest/") && method === "GET") {
    const ep = path.slice("/api/rest/".length);
    if (ep === "info") return json(fx.server?.info || {});
    if (ep === "players") return json({ players: fx.server?.players || [] });
    if (ep === "metrics") return json(fx.server?.metrics || {});
    if (ep === "settings") return json({ ...fx.config.options });
    return json({ detail: "unknown endpoint" }, 404);
  }
  if (path.startsWith("/api/rest/") && method === "POST") {
    return textRes("OK");
  }
  if (path === "/api/restart" && method === "POST") {
    return json({ restarted: true });
  }

  // ── settings ────────────────────────────────────────────────────────
  if (path === "/api/config" && method === "GET") return json({ ...fx.config });
  if (path === "/api/config" && method === "POST") {
    const b = await readJson(ctx.body);
    if (b.options) Object.assign(fx.config.options, b.options);
    if (b.raw) fx.config.raw = b.raw;
    return json({ saved: true, restarted: query.get("restart") === "true" });
  }
  if (path === "/api/config/reset" && method === "POST") {
    return json({ ok: true, error: null, reset: true, raw: fx.config.raw, options: { ...fx.config.options }, path: fx.config.path });
  }

  // ── saves ───────────────────────────────────────────────────────────
  if (path === "/api/saves" && method === "GET") return json({ ok: true, error: null, active: fx.saves.active, slots: fx.saves.slots });
  if (path === "/api/saves" && method === "POST") {
    const b = await readJson(ctx.body);
    const guid = "slot-" + Math.random().toString(36).slice(2, 8);
    const slot = { guid, name: b.name, created: Math.floor(Date.now()/1000), active: false, size: 0, empty: true, last_backup: null };
    fx.saves.slots.push(slot);
    return json({ ok: true, error: null, ...slot });
  }
  const slotMatch = path.match(/^\/api\/saves\/([^/]+)(\/.*)?$/);
  if (slotMatch) {
    const guid = slotMatch[1];
    const sub = slotMatch[2] || "";
    const slot = fx.saves.slots.find((s: any) => s.guid === guid);
    if (!slot) return json({ ok: false, error: "not_found" }, 404);

    if (sub === "" && method === "DELETE") {
      if (slot.active) return json({ ok: false, error: "cannot delete the active slot" }, 409);
      fx.saves.slots = fx.saves.slots.filter((s: any) => s.guid !== guid);
      return json({ ok: true, error: null, deleted: guid, backup: "pre-delete-…tar.gz" });
    }
    if (sub === "/clone" && method === "POST") {
      const b = await readJson(ctx.body);
      const newGuid = "slot-" + Math.random().toString(36).slice(2, 8);
      const newSlot = { ...slot, guid: newGuid, name: b.name, active: false, created: Math.floor(Date.now()/1000) };
      fx.saves.slots.push(newSlot);
      return json({ ok: true, error: null, guid: newGuid, name: b.name, created: newSlot.created, cloned_from: guid, ...(slot.active ? { note: "cloned from the active slot" } : {}) });
    }
    if (sub === "/rename" && method === "POST") {
      const b = await readJson(ctx.body);
      slot.name = b.name;
      return json({ ok: true, error: null, guid, name: b.name });
    }
    if (sub === "/activate" && method === "POST") {
      if (slot.active) return json({ ok: true, error: null, active: guid, note: "already active" });
      const previous = fx.saves.active;
      fx.saves.slots.forEach((s: any) => (s.active = false));
      slot.active = true;
      fx.saves.active = guid;
      return json({ ok: true, error: null, previous, active: guid, backup: "pre-switch-…tar.gz", restarted: query.get("restart") === "true" });
    }
    if (sub === "/backup" && method === "POST") {
      const now = Math.floor(Date.now()/1000);
      slot.last_backup = now;
      const b = { ref: "b" + now, file: `${slot.name}-${now}.tar.gz`, size: slot.size, created: now, location: "local" as const };
      (fx.backups[guid] = fx.backups[guid] || []).unshift(b);
      return json({ ok: true, error: null, backed_up: true, guid, file: b.file, local: true, remote: true });
    }
    if (sub === "/backups" && method === "GET") return json({ ok: true, error: null, guid, backups: fx.backups[guid] || [] });
    if (sub === "/restore" && method === "POST") {
      const b = await readJson(ctx.body);
      const previous = fx.saves.active;
      if (b.as_new_slot) {
        const newGuid = "slot-" + Math.random().toString(36).slice(2, 8);
        fx.saves.slots.forEach((s: any) => (s.active = false));
        fx.saves.slots.push({ guid: newGuid, name: b.name || `${slot.name} (restored)`, created: Math.floor(Date.now()/1000), active: true, size: slot.size, empty: false, last_backup: null });
        fx.saves.active = newGuid;
        return json({ ok: true, error: null, guid: newGuid, source_guid: guid, ref: b.ref, as_new_slot: true, previous_active: previous, pre_restore_backup: "pre-restore-…tar.gz", restarted: true });
      }
      fx.saves.slots.forEach((s: any) => (s.active = false));
      slot.active = true; fx.saves.active = guid;
      return json({ ok: true, error: null, guid, source_guid: guid, ref: b.ref, as_new_slot: false, previous_active: previous, pre_restore_backup: "pre-restore-…tar.gz", restarted: true });
    }
    if ((sub === "/download" || /^\/backups\/[^/]+\/download$/.test(sub)) && method === "GET") {
      // Mock download: a tiny fake gzip payload
      const data = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0, 0]);
      return new Response(data, { status: 200, headers: { "Content-Type": "application/gzip" } });
    }
  }

  // ── save uploads (chunked) ──────────────────────────────────────────
  if (path === "/api/saves/upload" && method === "POST") {
    const b = await readJson(ctx.body);
    const id = "up-" + Math.random().toString(36).slice(2, 10);
    fx.uploads[id] = { name: b.name, filename: b.filename, parts: 0, bytes: 0 };
    return json({ ok: true, error: null, upload_id: id, part_max_bytes: 24 * 1024 * 1024, max_bytes: 2 * 1024 * 1024 * 1024 });
  }
  const upMatch = path.match(/^\/api\/saves\/upload\/([^/]+)(\/.*)?$/);
  if (upMatch) {
    const id = upMatch[1]; const sub = upMatch[2] || "";
    const up = fx.uploads[id];
    if (!up) return json({ detail: "unknown upload" }, 404);
    if (sub === "/part" && method === "POST") {
      const expected = up.parts;
      const idx = Number(query.get("index"));
      if (knobs.next409) { knobs.next409 = false; return json({ detail: `expected part ${expected}, got ${idx}` }, 409); }
      if (idx !== expected) return json({ detail: `expected part ${expected}, got ${idx}` }, 409);
      const body = ctx.body;
      const size = body instanceof Blob ? body.size : (body instanceof ArrayBuffer ? body.byteLength : (typeof body === "string" ? body.length : 0));
      up.parts += 1;
      up.bytes += size;
      return json({ ok: true, error: null, parts: up.parts, bytes: up.bytes });
    }
    if (sub === "/finish" && method === "POST") {
      const b = await readJson(ctx.body);
      const guid = "slot-" + Math.random().toString(36).slice(2, 8);
      const slot = { guid, name: b.name || up.name, created: Math.floor(Date.now()/1000), active: false, size: up.bytes, empty: false, last_backup: null };
      fx.saves.slots.push(slot);
      delete fx.uploads[id];
      return json({ ok: true, error: null, guid, name: slot.name, size: slot.size });
    }
    if (sub === "" && method === "DELETE") {
      delete fx.uploads[id];
      return json({ ok: true, error: null });
    }
  }

  // ── mods ────────────────────────────────────────────────────────────
  if (path === "/api/mods" && method === "GET") return json({ ok: true, error: null, dir: fx.mods.dir, runtime_mode: fx.mods.runtime_mode, capabilities: fx.mods.capabilities, mods: fx.mods.mods });
  if (path === "/api/mods/upload" && method === "POST") {
    const name = query.get("name") || "mod.pak";
    const body = ctx.body as Blob | undefined;
    const size = body instanceof Blob ? body.size : 0;
    const type = name.endsWith(".pak") ? "pak" : "logic";
    fx.mods.mods.push({ name, type, size, enabled: true, installed_at: Math.floor(Date.now()/1000) });
    return json({ ok: true, error: null, name, type });
  }
  if (path === "/api/mods/url" && method === "POST") {
    const b = await readJson(ctx.body);
    const name = b.name || b.url.split("/").pop() || "mod.pak";
    fx.mods.mods.push({ name, type: "pak", size: 1_500_000, enabled: true, source_url: b.url, installed_at: Math.floor(Date.now()/1000) });
    return json({ ok: true, error: null, name, type: "pak" });
  }
  if (path === "/api/mods/ue4ss/install" && method === "POST") {
    if (!fx.mods.capabilities.ue4ss) return json({ detail: "requires Proton runtime (enable it in server settings)" }, 409);
    return json({ ok: true, error: null });
  }
  const modMatch = path.match(/^\/api\/mods\/([^/]+)(\/.*)?$/);
  if (modMatch && !path.startsWith("/api/mods/upload") && !path.startsWith("/api/mods/url") && !path.startsWith("/api/mods/ue4ss")) {
    const name = decodeURIComponent(modMatch[1]);
    const sub = modMatch[2] || "";
    const mod = fx.mods.mods.find((m: any) => m.name === name);
    if (!mod) return json({ ok: false, error: "not_found" }, 404);
    if (sub === "/enable" && method === "POST") { mod.enabled = true; return json({ ok: true, error: null, name, type: mod.type, enabled: true }); }
    if (sub === "/disable" && method === "POST") { mod.enabled = false; return json({ ok: true, error: null, name, type: mod.type, enabled: false }); }
    if (sub === "" && method === "DELETE") {
      fx.mods.mods = fx.mods.mods.filter((m: any) => m.name !== name);
      return json({ ok: true, error: null, deleted: name, type: mod.type });
    }
  }

  // ── users & roles ───────────────────────────────────────────────────
  if (path === "/api/users" && method === "GET") return json({ ok: true, error: null, users: fx.users, all_perms: fx.all_perms, roles: fx.roles.map((r: any) => r.name) });
  if (path === "/api/users" && method === "POST") {
    const b = await readJson(ctx.body);
    const existing = fx.users.find((u: any) => u.username === b.username);
    const role = b.role !== undefined ? b.role : existing?.role || "viewer";
    const perms = b.perms !== undefined ? b.perms : existing?.perms || [];
    const effective = role === "custom" ? perms : (fx.role_bundles[role] || []);
    if (existing) {
      existing.role = role;
      existing.perms = perms;
      existing.effective_perms = effective;
    } else {
      fx.users.push({ username: b.username, role, perms, effective_perms: effective });
    }
    return json({ ok: true, error: null, users: fx.users, all_perms: fx.all_perms, roles: fx.roles.map((r: any) => r.name) });
  }
  const userDel = path.match(/^\/api\/users\/([^/]+)$/);
  if (userDel && method === "DELETE") {
    const name = decodeURIComponent(userDel[1]);
    fx.users = fx.users.filter((u: any) => u.username !== name);
    return json({ ok: true, error: null, users: fx.users, all_perms: fx.all_perms, roles: fx.roles.map((r: any) => r.name) });
  }
  if (path === "/api/roles" && method === "GET") return json({ ok: true, error: null, roles: fx.roles, all_perms: fx.all_perms });
  if (path === "/api/roles" && method === "POST") {
    const b = await readJson(ctx.body);
    if (b.name === "custom") return json({ ok: false, error: '"custom" is reserved' }, 400);
    const existing = fx.roles.find((r: any) => r.name === b.name);
    if (existing) existing.perms = b.perms;
    else fx.roles.push({ name: b.name, perms: b.perms, builtin: false });
    fx.role_bundles[b.name] = b.perms;
    // refresh effective_perms for any users on this role
    fx.users.forEach((u: any) => { if (u.role === b.name) u.effective_perms = b.perms; });
    return json({ ok: true, error: null, roles: fx.roles, all_perms: fx.all_perms });
  }
  const roleDel = path.match(/^\/api\/roles\/([^/]+)$/);
  if (roleDel && method === "DELETE") {
    const name = decodeURIComponent(roleDel[1]);
    const r = fx.roles.find((x: any) => x.name === name);
    if (!r) return json({ ok: false, error: "not_found" }, 404);
    if (r.builtin) return json({ ok: false, error: "cannot delete a built-in role" }, 400);
    if (fx.users.some((u: any) => u.role === name)) return json({ ok: false, error: "role is still in use" }, 400);
    fx.roles = fx.roles.filter((x: any) => x.name !== name);
    return json({ ok: true, error: null, roles: fx.roles, all_perms: fx.all_perms });
  }

  return json({ detail: `unknown ${method} ${path}` }, 404);
}
