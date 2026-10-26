#!/usr/bin/env python3
"""
Register (or refresh) PalPilot's Discord slash commands for one guild.

Run this once after creating the Discord app, and again whenever
coordinator/discord_bot.py's COMMAND_DEFS changes. Guild-scoped commands appear
instantly (global ones can take an hour), and the bot token is only needed here
-- the coordinator never stores it.

Usage (PowerShell):
  $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_APP_ID="..."; $env:DISCORD_GUILD_ID="..."
  python scripts/discord_register.py            # register/replace
  python scripts/discord_register.py --list      # show what's registered
  python scripts/discord_register.py --clear     # remove every guild command

Stdlib only: no pip install, no deps shared with the function.
"""

import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "coordinator"))

import discord_bot  # noqa: E402  (needs the path tweak above)

API = "https://discord.com/api/v10"

TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
APP_ID = os.environ.get("DISCORD_APP_ID", "")
GUILD_ID = os.environ.get("DISCORD_GUILD_ID", "")


def _call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", f"Bot {TOKEN}")
    req.add_header("User-Agent", "PalPilot (https://github.com/, 1.0)")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        return e.code, (json.loads(text) if text.startswith(("{", "[")) else text)


def main():
    missing = [
        k
        for k, v in (
            ("DISCORD_BOT_TOKEN", TOKEN),
            ("DISCORD_APP_ID", APP_ID),
            ("DISCORD_GUILD_ID", GUILD_ID),
        )
        if not v
    ]
    if missing:
        print(f"missing env: {', '.join(missing)}")
        return 2

    base = f"/applications/{APP_ID}/guilds/{GUILD_ID}/commands"
    arg = sys.argv[1] if len(sys.argv) > 1 else ""

    if arg == "--list":
        status, payload = _call("GET", base)
        print(status, json.dumps(payload, indent=2, ensure_ascii=False))
        return 0 if status == 200 else 1

    if arg == "--clear":
        status, payload = _call("PUT", base, [])
        print(status, "cleared" if status == 200 else payload)
        return 0 if status == 200 else 1

    # PUT replaces the whole guild command set in one call (no stale leftovers).
    status, payload = _call("PUT", base, discord_bot.COMMAND_DEFS)
    if status != 200:
        print(f"registration failed: {status} {payload}")
        return 1
    for cmd in payload:
        subs = ", ".join(o["name"] for o in cmd.get("options", []) if o.get("type") == 1)
        print(f"/{cmd['name']}: {subs}")
    print(f"registered {len(payload)} command(s) in guild {GUILD_ID}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
