"""
Discord slash-command bot for PalPilot — runs inside the coordinator function.

There is no always-on process: Discord posts every slash command to
POST /api/discord/interactions (an "Interactions Endpoint URL"), which the
coordinator entrypoint routes here. That keeps the bot as cheap as the rest of
the control plane and lets it start the VM while the VM is off.

Trust model (this endpoint is unauthenticated at the HTTP layer, by design):
  1. Every request must carry a valid Ed25519 signature over
     "<X-Signature-Timestamp><raw body>" for DISCORD_PUBLIC_KEY. Discord signs
     with the app's private key, so a valid signature proves Discord sent it.
  2. The interaction's guild_id must equal DISCORD_GUILD_ID.
  3. The caller's Discord role IDs decide the PalPilot permission set:
       DISCORD_ADMIN_ROLE_IDS -> every permission (elevated)
       DISCORD_USER_ROLE_IDS  -> ["view", "power"]  (empty = any guild member)
     The resulting pseudo-user ("discord:<name>") flows through the same
     _rbac_headers() signing as a console user, so the VM agent enforces the
     same permissions it would for a panel login. Nothing here bypasses RBAC.
  Empty DISCORD_PUBLIC_KEY disables the endpoint entirely (404) — fails closed.

Commands (register them with scripts/discord_register.py):
  /palworld status | address | players | start
  /paladmin announce | kick | ban | unban | save | shutdown | stop | poweroff
            | user-create | user-list | user-delete
  /palworld is open to members; /paladmin requires an admin role AND the
  matching permission, so a misconfigured role can't silently gain commands.

Timing: Discord drops an interaction that isn't answered within ~3s, so every
handler answers synchronously and the ops layer fans its VM calls out in
parallel with short timeouts. No deferred/followup path — a Cloud Run instance
has no guaranteed CPU after the response is flushed.

Ops (injected by main.py so this module stays protocol-only; see _DISCORD_OPS):
  overview()                  -> {status, ip, port, info, metrics, players, settings}
  vm_start() / vm_stop()      -> bool
  rest(endpoint, body, user)  -> (http_status, payload dict)
  user_create(name, pw, role) -> {ok, error?}
  user_list()                 -> [{username, role, effective_perms}]
  user_delete(name)           -> {ok, error?}
"""

import json
import os
import secrets

PUBLIC_KEY = os.environ.get("DISCORD_PUBLIC_KEY", "")
GUILD_ID = os.environ.get("DISCORD_GUILD_ID", "")
ADMIN_ROLE_IDS = {r.strip() for r in os.environ.get("DISCORD_ADMIN_ROLE_IDS", "").split(",") if r.strip()}
USER_ROLE_IDS = {r.strip() for r in os.environ.get("DISCORD_USER_ROLE_IDS", "").split(",") if r.strip()}

ALL_PERMS = ["view", "power", "saves", "mods", "settings", "watchdog", "commands", "users"]
MEMBER_PERMS = ["view", "power"]

EPHEMERAL = 64  # InteractionResponseFlags.EPHEMERAL

COLOR_OK = 0x2E8B57
COLOR_OFF = 0xB4413C
COLOR_BUSY = 0xD9A62E
COLOR_INFO = 0x4A6572

# Rates shown by /palworld status, in display order: (settings key, label).
RATE_KEYS = [
    ("ExpRate", "EXP"),
    ("PalCaptureRate", "Capture"),
    ("PalSpawnNumRate", "Pal spawns"),
    ("CollectionDropRate", "Gathering"),
    ("EnemyDropItemRate", "Enemy drops"),
    ("DeathPenalty", "Death penalty"),
]

# Roles a Discord admin may hand out with /paladmin user-create. Deliberately
# excludes nothing built-in, but "owner" is included so an operator can bootstrap
# a second full admin; the coordinator still refuses unknown roles.
CREATABLE_ROLES = ["viewer", "moderator", "operator", "owner"]


def enabled():
    return bool(PUBLIC_KEY)


# ---------------------------------------------------------------------------
# request verification
# ---------------------------------------------------------------------------


def verify(request):
    """True when this request really came from Discord (Ed25519 over ts+body)."""
    sig = request.headers.get("X-Signature-Ed25519", "")
    ts = request.headers.get("X-Signature-Timestamp", "")
    if not sig or not ts:
        return False
    try:
        from nacl.exceptions import BadSignatureError
        from nacl.signing import VerifyKey

        key = VerifyKey(bytes.fromhex(PUBLIC_KEY))
        key.verify(ts.encode() + request.get_data(), bytes.fromhex(sig))
        return True
    except (BadSignatureError, ValueError, TypeError) as e:
        print(f"discord signature rejected: {type(e).__name__}")
        return False


# ---------------------------------------------------------------------------
# response builders
# ---------------------------------------------------------------------------


def _reply(payload):
    return (json.dumps(payload), 200, {"Content-Type": "application/json"})


def _msg(content, ephemeral=True):
    data = {"content": content}
    if ephemeral:
        data["flags"] = EPHEMERAL
    return _reply({"type": 4, "data": data})


def _embed(embed, ephemeral=False):
    data = {"embeds": [embed]}
    if ephemeral:
        data["flags"] = EPHEMERAL
    return _reply({"type": 4, "data": data})


def _fmt_uptime(seconds):
    try:
        s = max(0, int(float(seconds)))
    except (TypeError, ValueError):
        return "—"
    h, m = s // 3600, (s % 3600) // 60
    return f"{h}h {m}m" if h else f"{m}m"


def _opts(node):
    """Flatten an option list into {name: value} (subcommand args)."""
    return {o.get("name"): o.get("value") for o in (node.get("options") or [])}


# ---------------------------------------------------------------------------
# caller -> PalPilot pseudo-user
# ---------------------------------------------------------------------------


def _caller(body):
    """Map the interaction's member to a coordinator user dict, or None if the
    caller isn't an allowed member of the configured guild."""
    if GUILD_ID and body.get("guild_id") != GUILD_ID:
        print(f"discord interaction from unexpected guild {body.get('guild_id')!r}")
        return None
    member = body.get("member") or {}
    user = member.get("user") or {}
    name = user.get("username") or user.get("id") or "unknown"
    roles = set(member.get("roles") or [])
    if ADMIN_ROLE_IDS and roles & ADMIN_ROLE_IDS:
        return {"name": f"discord:{name}", "perms": list(ALL_PERMS), "elevated": True}
    if USER_ROLE_IDS and not (roles & USER_ROLE_IDS):
        return None
    return {"name": f"discord:{name}", "perms": list(MEMBER_PERMS), "elevated": False}


# ---------------------------------------------------------------------------
# /palworld — open to members
# ---------------------------------------------------------------------------


def _cmd_status(ops, user, args):
    ov = ops.overview(user)
    st = ov.get("status") or "UNKNOWN"
    addr = f"{ov.get('ip')}:{ov.get('port')}" if ov.get("ip") else "—"
    running = st == "RUNNING"
    info = ov.get("info") or {}
    metrics = ov.get("metrics") or {}
    settings = ov.get("settings") or {}
    players = ov.get("players") or []

    embed = {
        "title": info.get("servername") or "Palworld",
        "color": COLOR_OK if running else (COLOR_OFF if st in ("TERMINATED", "STOPPED") else COLOR_BUSY),
        "fields": [
            {
                "name": "Status",
                "value": "🟢 Online" if running else ("🔴 Offline" if st in ("TERMINATED", "STOPPED") else f"🟡 {st}"),
                "inline": True,
            },
            {"name": "Address", "value": f"`{addr}`", "inline": True},
        ],
    }

    if running:
        cur = metrics.get("currentplayernum")
        mx = metrics.get("maxplayernum") or settings.get("ServerPlayerMaxNum")
        embed["fields"] += [
            {"name": "Players", "value": f"{cur if cur is not None else '—'} / {mx if mx is not None else '—'}", "inline": True},
            {"name": "Uptime", "value": _fmt_uptime(metrics.get("uptime")), "inline": True},
            {"name": "In-game day", "value": str(metrics.get("days", "—")), "inline": True},
        ]
        if players:
            names = ", ".join((p.get("name") or p.get("accountName") or "?") for p in players[:20])
            if len(players) > 20:
                names += f" … (+{len(players) - 20})"
            embed["fields"].append({"name": "Online now", "value": names[:1024], "inline": False})
        rates = [f"**{label}** {settings[key]}" for key, label in RATE_KEYS if key in settings]
        if rates:
            embed["fields"].append({"name": "Rates", "value": " · ".join(rates)[:1024], "inline": False})
        if not metrics and not settings:
            embed["footer"] = {"text": "VM is up but the game server isn't answering yet — try again shortly."}
    else:
        embed["footer"] = {"text": "Use /palworld start to power it on (2–3 min to accept players)."}

    return _embed(embed)


def _cmd_address(ops, user, args):
    ov = ops.overview(user, fast=True)
    if not ov.get("ip"):
        return _msg("Server address is unavailable.")
    return _msg(f"Join via IP: `{ov['ip']}:{ov['port']}`", ephemeral=False)


def _cmd_players(ops, user, args):
    ov = ops.overview(user)
    if (ov.get("status") or "") != "RUNNING":
        return _msg("Server is offline — nobody online.", ephemeral=False)
    players = ov.get("players") or []
    if not players:
        return _msg("Nobody online right now.", ephemeral=False)
    # userId is the value /paladmin kick|ban expects, so show that one.
    lines = [
        f"• **{p.get('name') or p.get('accountName') or '?'}** — lvl {p.get('level', '?')}"
        f", ping {round(p['ping']) if isinstance(p.get('ping'), (int, float)) else '?'}"
        f" · `{p.get('userId') or p.get('playerId') or '?'}`"
        for p in players[:25]
    ]
    if len(players) > 25:
        lines.append(f"… (+{len(players) - 25})")
    return _embed(
        {"title": f"Players online ({len(players)})", "description": "\n".join(lines)[:4000], "color": COLOR_OK},
        ephemeral=False,
    )


def _cmd_start(ops, user, args):
    ov = ops.overview(user, fast=True)
    st = ov.get("status") or ""
    if st == "RUNNING":
        return _msg(f"Server is already online — `{ov.get('ip')}:{ov.get('port')}`", ephemeral=False)
    if st in ("STAGING", "PROVISIONING"):
        return _msg("Server is already starting — give it 2–3 minutes.", ephemeral=False)
    if not ops.vm_start():
        return _msg("Failed to start the server. Ask an admin to check the console.")
    return _msg(
        f"⏻ Starting the server — ready in about 2–3 minutes. Address: `{ov.get('ip')}:{ov.get('port')}`",
        ephemeral=False,
    )


# ---------------------------------------------------------------------------
# /paladmin — elevated
# ---------------------------------------------------------------------------


def _rest_reply(ops, user, endpoint, body, done):
    status, payload = ops.rest(endpoint, body, user)
    if status == 503:
        return _msg("Server is offline — nothing to do.")
    if not (200 <= status < 300):
        err = (payload or {}).get("error") or (payload or {}).get("detail") or f"HTTP {status}"
        return _msg(f"`{endpoint}` failed: {err}")
    return _msg(done, ephemeral=False)


def _cmd_announce(ops, user, args):
    message = (args.get("message") or "").strip()
    if not message:
        return _msg("A message is required.")
    return _rest_reply(ops, user, "announce", {"message": message}, f"📣 Announced: {message}")


def _cmd_kick(ops, user, args):
    uid = (args.get("userid") or "").strip()
    reason = args.get("reason") or ""
    if not uid:
        return _msg("A userid is required (see /palworld players for who's online).")
    return _rest_reply(ops, user, "kick", {"userid": uid, "message": reason}, f"👢 Kicked `{uid}`")


def _cmd_ban(ops, user, args):
    uid = (args.get("userid") or "").strip()
    reason = args.get("reason") or ""
    if not uid:
        return _msg("A userid is required.")
    return _rest_reply(ops, user, "ban", {"userid": uid, "message": reason}, f"🔨 Banned `{uid}`")


def _cmd_unban(ops, user, args):
    uid = (args.get("userid") or "").strip()
    if not uid:
        return _msg("A userid is required.")
    return _rest_reply(ops, user, "unban", {"userid": uid}, f"♻️ Unbanned `{uid}`")


def _cmd_save(ops, user, args):
    return _rest_reply(ops, user, "save", {}, "💾 World saved.")


def _cmd_shutdown(ops, user, args):
    try:
        wait = int(args.get("seconds", 30))
    except (TypeError, ValueError):
        return _msg("`seconds` must be a whole number.")
    wait = max(0, min(3600, wait))
    message = args.get("message") or "Server is shutting down"
    return _rest_reply(
        ops,
        user,
        "shutdown",
        {"waittime": wait, "message": message},
        f"🛑 Shutting the game server down in {wait}s.",
    )


def _cmd_stop(ops, user, args):
    return _rest_reply(ops, user, "stop", {}, "🛑 Force-stopped the game server (no save).")


def _cmd_poweroff(ops, user, args):
    if not ops.vm_stop():
        return _msg("Failed to power the VM off.")
    return _msg("⏻ Powering the VM off — billing for compute stops once it's TERMINATED.", ephemeral=False)


def _cmd_user_create(ops, user, args):
    name = (args.get("username") or "").strip()
    role = (args.get("role") or "viewer").strip()
    if not name:
        return _msg("A username is required.")
    if role not in CREATABLE_ROLES:
        return _msg(f"Unknown role `{role}` (pick one of: {', '.join(CREATABLE_ROLES)}).")
    password = secrets.token_urlsafe(12)
    res = ops.user_create(name, password, role)
    if not res.get("ok"):
        return _msg(f"Couldn't create the user: {res.get('error') or 'unknown error'}")
    # Ephemeral so the one-time password stays with the admin who ran the command.
    return _msg(
        f"✅ Panel user created.\n**User:** `{name}`\n**Role:** `{role}`\n"
        f"**Temporary password:** `{password}`\n"
        "Send it to them privately — they should change it under Account after signing in.",
    )


def _cmd_user_list(ops, user, args):
    users = ops.user_list()
    if not users:
        return _msg("No panel users found.")
    lines = [
        f"• **{u['username']}** — role `{u.get('role', 'custom')}` ({', '.join(u.get('effective_perms') or []) or 'no perms'})"
        for u in users
    ]
    return _embed({"title": "Panel users", "description": "\n".join(lines)[:4000], "color": COLOR_INFO}, ephemeral=True)


def _cmd_user_delete(ops, user, args):
    name = (args.get("username") or "").strip()
    if not name:
        return _msg("A username is required.")
    res = ops.user_delete(name)
    if not res.get("ok"):
        return _msg(f"Couldn't delete the user: {res.get('error') or 'unknown error'}")
    return _msg(f"🗑️ Panel user `{name}` deleted.")


# (top-level command, subcommand) -> (required perm, elevated only, handler)
COMMANDS = {
    ("palworld", "status"): ("view", False, _cmd_status),
    ("palworld", "address"): ("view", False, _cmd_address),
    ("palworld", "players"): ("view", False, _cmd_players),
    ("palworld", "start"): ("power", False, _cmd_start),
    ("paladmin", "announce"): ("commands", True, _cmd_announce),
    ("paladmin", "kick"): ("commands", True, _cmd_kick),
    ("paladmin", "ban"): ("commands", True, _cmd_ban),
    ("paladmin", "unban"): ("commands", True, _cmd_unban),
    ("paladmin", "save"): ("commands", True, _cmd_save),
    ("paladmin", "shutdown"): ("commands", True, _cmd_shutdown),
    ("paladmin", "stop"): ("commands", True, _cmd_stop),
    ("paladmin", "poweroff"): ("power", True, _cmd_poweroff),
    ("paladmin", "user-create"): ("users", True, _cmd_user_create),
    ("paladmin", "user-list"): ("users", True, _cmd_user_list),
    ("paladmin", "user-delete"): ("users", True, _cmd_user_delete),
}


# ---------------------------------------------------------------------------
# slash-command registration payload — single source of truth, consumed by
# scripts/discord_register.py (PUT .../guilds/<id>/commands). Keep it in sync
# with COMMANDS above: a subcommand registered here but missing there answers
# "Unknown command", and vice-versa it simply never shows up in Discord.
# Option types: 1 = SUB_COMMAND, 3 = STRING, 4 = INTEGER.
# ---------------------------------------------------------------------------

_STR = 3
_INT = 4


def _sub(name, description, options=None):
    return {"name": name, "description": description, "type": 1, "options": options or []}


def _opt(name, description, otype=_STR, required=False, choices=None):
    o = {"name": name, "description": description, "type": otype, "required": required}
    if choices:
        o["choices"] = [{"name": c, "value": c} for c in choices]
    return o


COMMAND_DEFS = [
    {
        "name": "palworld",
        "description": "Palworld server — status and power on",
        "options": [
            _sub("status", "Status, address, players online, uptime, in-game day and rates"),
            _sub("address", "Show the ip:port to join the server"),
            _sub("players", "Who is online right now"),
            _sub("start", "Power the server on (takes 2–3 minutes)"),
        ],
    },
    {
        "name": "paladmin",
        "description": "Palworld admin actions (restricted)",
        "options": [
            _sub("announce", "Broadcast an in-game message", [_opt("message", "What to say", required=True)]),
            _sub(
                "kick",
                "Kick a player",
                [_opt("userid", "Player userid (see /palworld players)", required=True), _opt("reason", "Reason shown to the player")],
            ),
            _sub("ban", "Ban a player", [_opt("userid", "Player userid", required=True), _opt("reason", "Reason")]),
            _sub("unban", "Lift a ban", [_opt("userid", "Player userid", required=True)]),
            _sub("save", "Save the world now"),
            _sub(
                "shutdown",
                "Graceful game-server shutdown with a countdown",
                [_opt("seconds", "Countdown in seconds (default 30)", _INT), _opt("message", "Message shown to players")],
            ),
            _sub("stop", "Force-stop the game server (no save)"),
            _sub("poweroff", "Power the VM off (stops compute billing)"),
            _sub(
                "user-create",
                "Create a console (admin panel) user with a one-time password",
                [
                    _opt("username", "Console username", required=True),
                    _opt("role", "Role to grant (default viewer)", choices=CREATABLE_ROLES),
                ],
            ),
            _sub("user-list", "List console users and their roles"),
            _sub("user-delete", "Delete a console user", [_opt("username", "Console username", required=True)]),
        ],
    },
]


# ---------------------------------------------------------------------------
# entrypoint (called by main.coordinator)
# ---------------------------------------------------------------------------


def handle(request, ops):
    if not enabled():
        return ("not found", 404, {"Content-Type": "text/plain"})
    if not verify(request):
        return ("invalid request signature", 401, {"Content-Type": "text/plain"})

    body = request.get_json(silent=True) or {}
    itype = body.get("type")
    if itype == 1:  # PING — Discord's endpoint-URL health check
        return _reply({"type": 1})
    if itype != 2:  # only APPLICATION_COMMAND is wired up
        return _reply({"type": 4, "data": {"content": "Unsupported interaction.", "flags": EPHEMERAL}})

    user = _caller(body)
    if not user:
        return _msg("You're not allowed to use this bot.")

    data = body.get("data") or {}
    top = data.get("name") or ""
    sub_node = next((o for o in (data.get("options") or []) if o.get("type") == 1), None)
    sub = (sub_node or {}).get("name") or ""
    entry = COMMANDS.get((top, sub))
    if not entry:
        return _msg(f"Unknown command `/{top} {sub}`.")

    perm, elevated_only, fn = entry
    if elevated_only and not user.get("elevated"):
        return _msg("That command is for server admins only.")
    if perm not in user["perms"]:
        return _msg("You don't have permission for that.")

    args = _opts(sub_node or {})
    print(f"discord command /{top} {sub} by {user['name']} args={list(args)}")
    try:
        return fn(ops, user, args)
    except Exception as e:  # noqa: BLE001 — never leave Discord hanging on a traceback
        print(f"discord command /{top} {sub} failed: {type(e).__name__}: {e}")
        return _msg("Something broke handling that command. Check the coordinator logs.")
