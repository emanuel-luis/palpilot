#!/usr/bin/env python3
"""
Palworld admin panel backend.

Runs on the Palworld VM. Serves the frontend, edits PalWorldSettings.ini,
restarts the systemd service, and proxies the Palworld REST API
(localhost:RESTAPIPort, HTTP Basic 'admin':AdminPassword).

Config via env vars:
  PANEL_USER, PANEL_PASSWORD   basic-auth for the panel itself (break-glass)
  ADMIN_PASSWORD               Palworld REST API admin password
  REST_PORT                    Palworld REST API port (default 8212)
  REST_HOST                    Palworld REST API host (default 127.0.0.1)
  INI_PATH                     path to PalWorldSettings.ini
  DEFAULT_INI_PATH             path to DefaultPalWorldSettings.ini (seed)
  SERVICE_NAME                 systemd unit to restart (default palworld)
  STEAM_USER                   owner to chown files back to (default steam)
  PANEL_PORT                   port to listen on (default 8080)
  INDEX_PATH                   path to index.html
  INTERNAL_TOKEN                HMAC key shared with the coordinator for the
                                signed RBAC-propagation headers (X-Coord-*).
                                Empty => signed mode disabled, Basic-Auth only.
  BACKUP_KEEP                   backups kept per slot, local + remote (default 5)
  MOD_MAX_BYTES                 byte ceiling for mod upload/url-install (default 500MB)
  SAVE_MAX_BYTES                byte ceiling for an imported world archive, compressed and
                                 uncompressed (default 2GB)
  UPLOAD_PART_MAX_BYTES         byte ceiling per upload part (default 24MB; must stay under
                                 Cloud Run's 32MiB request cap, since parts come via the
                                 coordinator)
  UPLOAD_SESSION_TTL            seconds before an abandoned upload session is swept (default 6h)
  RUNTIME_MODE                  "native" (default, unchanged) or "proton"; gates the UE4SS
                                 mod capability -- native servers can only run pak/LogicMods
  LOGICMODS_DIR                 path to Paks/LogicMods (default under STEAM_DIR)
  UE4SS_ROOT_DIR / UE4SS_MODS_DIR  path to the UE4SS tree / its Mods dir (Proton-only)
  UE4SS_DEFAULT_URL             optional default source for /api/mods/ue4ss/install
                                 when the caller doesn't pass a url (empty => url required)

CLI:
  python panel.py bootstrap    ensure REST API keys exist in the ini, then exit
  python panel.py serve        run the web server (default)
"""

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PANEL_USER = os.environ.get("PANEL_USER", "admin")
PANEL_PASSWORD = os.environ.get("PANEL_PASSWORD", "changeme")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
REST_HOST = os.environ.get("REST_HOST", "127.0.0.1")
REST_PORT = int(os.environ.get("REST_PORT", "8212"))
INI_PATH = os.environ.get(
    "INI_PATH",
    "/home/steam/Steam/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini",
)
DEFAULT_INI_PATH = os.environ.get(
    "DEFAULT_INI_PATH", "/home/steam/Steam/DefaultPalWorldSettings.ini"
)
SERVICE_NAME = os.environ.get("SERVICE_NAME", "palworld")
STEAM_USER = os.environ.get("STEAM_USER", "steam")
PANEL_PORT = int(os.environ.get("PANEL_PORT", "8080"))
PANEL_BUCKET = os.environ.get("PANEL_BUCKET", "")
PANEL_DIR = os.environ.get(
    "PANEL_DIR", os.path.dirname(os.path.abspath(__file__))
)
INDEX_PATH = os.environ.get(
    "INDEX_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
)

# RBAC-propagation from the coordinator (H1). Empty => signed headers are
# never trusted and every request falls back to Basic Auth.
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")

# --- save-slot + mod manipulation ---
# Base of the persistent data disk. PalServer stores everything under here.
STEAM_DIR = os.environ.get("STEAM_DIR", "/home/steam/Steam")
# Worlds live in SaveGames/0/<WorldGUID>; the active one is named by
# DedicatedServerName in GameUserSettings.ini. All worlds coexist here.
SAVEGAMES_DIR = os.environ.get(
    "SAVEGAMES_DIR", f"{STEAM_DIR}/Pal/Saved/SaveGames/0"
)
GUS_PATH = os.environ.get(
    "GUS_PATH", f"{STEAM_DIR}/Pal/Saved/Config/LinuxServer/GameUserSettings.ini"
)
# .pak mods drop into Pal/Content/Paks/~mods (created on demand).
MODS_DIR = os.environ.get("MODS_DIR", f"{STEAM_DIR}/Pal/Content/Paks/~mods")
# Friendly-name metadata for slots (guid -> {name, created, last_backup}).
SLOTS_META = os.environ.get("SLOTS_META", f"{STEAM_DIR}/Pal/Saved/palworld-slots.json")
# Sidecar metadata for mods (filename -> {source_url, installed_at, enabled}).
MODS_META = os.environ.get("MODS_META", f"{STEAM_DIR}/Pal/Saved/palworld-mods.json")
# LogicMods .pak files drop into Paks/LogicMods instead of ~mods.
LOGICMODS_DIR = os.environ.get("LOGICMODS_DIR", f"{STEAM_DIR}/Pal/Content/Paks/LogicMods")
# UE4SS script-mod tree (Proton-only; native servers can't load UE4SS).
UE4SS_ROOT_DIR = os.environ.get("UE4SS_ROOT_DIR", f"{STEAM_DIR}/Pal/Binaries/Win64/ue4ss")
UE4SS_MODS_DIR = os.environ.get("UE4SS_MODS_DIR", f"{UE4SS_ROOT_DIR}/Mods")
# Optional default source for `POST /api/mods/ue4ss/install` when the caller
# doesn't pass a url. Empty by default -- nothing is hardcoded/guessed; the
# caller (or the operator, via env) must supply a real RE-UE4SS download URL.
UE4SS_DEFAULT_URL = os.environ.get("UE4SS_DEFAULT_URL", "")
# Server runtime this VM is configured for. "native" (default, unchanged
# today) can only run .pak/LogicMods; "proton" additionally unlocks UE4SS
# script mods. Purely a capability gate here -- switching runtimes is a
# startup.sh/Terraform concern, not this file's.
RUNTIME_MODE = os.environ.get("RUNTIME_MODE", "native")

# Number of per-slot backups kept, both locally and in GCS (prune-on-write).
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "5"))
# Byte ceiling for mod uploads / url-installs (default 500MB).
MOD_MAX_BYTES = int(os.environ.get("MOD_MAX_BYTES", str(500 * 1024 * 1024)))
# Save import: ceiling for a whole uploaded archive (and for its uncompressed
# payload, which is the zip-bomb guard), plus the per-part ceiling. Parts exist
# because the console uploads through the coordinator, and that's a Cloud
# Function: Cloud Run rejects a request body over 32 MiB, so 24 MiB parts leave
# headroom for headers/encoding.
SAVE_MAX_BYTES = int(os.environ.get("SAVE_MAX_BYTES", str(2 * 1024 * 1024 * 1024)))
UPLOAD_PART_MAX_BYTES = int(os.environ.get("UPLOAD_PART_MAX_BYTES", str(24 * 1024 * 1024)))
# Abandoned upload sessions (browser closed mid-upload) are swept on the next init.
UPLOAD_SESSION_TTL = int(os.environ.get("UPLOAD_SESSION_TTL", str(6 * 3600)))


def _gce_project_id() -> str:
    """Ask the GCE metadata server for this VM's project id (empty if off-GCE)."""
    try:
        req = urllib.request.Request(
            "http://metadata.google.internal/computeMetadata/v1/project/project-id",
            headers={"Metadata-Flavor": "Google"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.read().decode().strip()
    except (urllib.error.URLError, OSError):
        return ""


# GCS bucket for safety backups. Prefer the env var; otherwise derive
# "<project>-palworld-backups" from metadata so no VM recreate is needed to
# wire it up (matches the bucket name in main.tf).
BACKUP_BUCKET = os.environ.get("BACKUP_BUCKET", "")
if not BACKUP_BUCKET:
    _proj = _gce_project_id()
    BACKUP_BUCKET = f"{_proj}-palworld-backups" if _proj else ""

OPTION_HEADER = "[/Script/Pal.PalGameWorldSettings]"
GUS_HEADER = "[/Script/Pal.PalGameLocalSettings]"

# RBAC permission set propagated from the coordinator (v3, granular):
# view/power/saves/mods/settings/watchdog/commands/users. Basic-Auth
# (break-glass) is granted all of them. The legacy coarse "config" perm
# (if ever seen on an incoming X-Coord-Perms header from an older
# coordinator) is expanded via _expand_perms() before being checked.
ALL_PERMS = {"view", "power", "saves", "mods", "settings", "watchdog", "commands", "users"}


def _expand_perms(perms):
    """Mirror of the coordinator's _expand_perms(): expand the legacy coarse
    "config" permission into the granular set it replaced ({saves, mods,
    settings, watchdog}). Idempotent, dedups, preserves order. Accepts any
    iterable (list or set) of perm strings."""
    expanded = []
    for p in perms or []:
        if p == "config":
            for q in ("saves", "mods", "settings", "watchdog"):
                if q not in expanded:
                    expanded.append(q)
        elif p not in expanded:
            expanded.append(p)
    return expanded


# ---------------------------------------------------------------------------
# fsutil — atomic writes, safe names
# ---------------------------------------------------------------------------


def atomic_write(path: str, data, mode: str = "w", encoding: str | None = "utf-8"):
    """Write `data` to `path` atomically: temp file in the same dir + os.replace.

    Avoids readers ever observing a partially-written file, and avoids
    corrupting the file if the process dies mid-write.
    """
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=f".{os.path.basename(path)}.tmp-")
    try:
        if "b" in mode:
            with os.fdopen(fd, mode) as f:
                f.write(data)
        else:
            with os.fdopen(fd, mode, encoding=encoding) as f:
                f.write(data)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _safe_name(name: str) -> str:
    """A friendly slot/mod name reduced to a filesystem-safe token."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", (name or "").strip())[:64]


def _timestamp() -> str:
    return time.strftime("%Y-%m-%d_%H-%M-%S")


# ---------------------------------------------------------------------------
# System ops — sudo-aware helpers (chown / systemctl)
# ---------------------------------------------------------------------------
#
# panel.py may run as root (legacy) or as the non-root `steam` service user
# (target state, M8/L4). In the latter case, startup.sh grants a narrow
# sudoers allowlist for exactly `systemctl {start,stop,restart}` and `chown`,
# so the same code path works either way.


def _sudo_prefix() -> list:
    return [] if os.geteuid() == 0 else ["sudo", "-n"]


def _run_privileged(args: list, **kwargs):
    kwargs.setdefault("check", True)
    kwargs.setdefault("capture_output", True)
    return subprocess.run(_sudo_prefix() + args, **kwargs)


def _chown_steam(path: str, recursive: bool = False):
    """Give a path back to the steam user so PalServer can read/write it."""
    try:
        import pwd

        pw = pwd.getpwnam(STEAM_USER)
    except KeyError:
        return
    if os.geteuid() == 0:
        try:
            if recursive:
                for root, dirs, files in os.walk(path):
                    os.chown(root, pw.pw_uid, pw.pw_gid)
                    for n in dirs + files:
                        try:
                            os.chown(os.path.join(root, n), pw.pw_uid, pw.pw_gid)
                        except OSError:
                            pass
            else:
                os.chown(path, pw.pw_uid, pw.pw_gid)
        except (PermissionError, FileNotFoundError):
            pass
        return
    # Non-root: shell out through the sudoers-allowlisted chown helper.
    try:
        args = ["chown"] + (["-R"] if recursive else []) + [f"{STEAM_USER}:{STEAM_USER}", path]
        _run_privileged(args)
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        pass


def restart_service():
    _run_privileged(["systemctl", "restart", SERVICE_NAME])


def stop_service():
    _run_privileged(["systemctl", "stop", SERVICE_NAME])


def start_service():
    _run_privileged(["systemctl", "start", SERVICE_NAME])


def _service_active() -> bool:
    r = subprocess.run(["systemctl", "is-active", "--quiet", SERVICE_NAME])
    return r.returncode == 0


# ---------------------------------------------------------------------------
# OptionSettings parsing / editing
# ---------------------------------------------------------------------------


def _split_top_level(body: str):
    """Split OptionSettings body on commas that are not inside quotes or
    parens. Mirrors `_find_option_body`'s depth tracking so struct/array
    values like Foo=(A=1,B=2) are not mis-split into separate pairs (M3)."""
    parts, buf, in_quotes, depth = [], [], False, 0
    for ch in body:
        if ch == '"':
            in_quotes = not in_quotes
            buf.append(ch)
        elif not in_quotes and ch == "(":
            depth += 1
            buf.append(ch)
        elif not in_quotes and ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "," and not in_quotes and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))
    return [p for p in (s.strip() for s in parts) if p]


def _find_option_body(raw: str):
    """Return (start_index, end_index, body) of the OptionSettings=(...) parens."""
    key = "OptionSettings=("
    i = raw.find(key)
    if i == -1:
        return None
    open_paren = i + len(key) - 1  # index of '('
    depth, j, in_quotes = 0, open_paren, False
    while j < len(raw):
        ch = raw[j]
        if ch == '"':
            in_quotes = not in_quotes
        elif not in_quotes:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    body = raw[open_paren + 1 : j]
                    return (open_paren + 1, j, body)
        j += 1
    return None


def parse_options(raw: str) -> dict:
    found = _find_option_body(raw)
    if not found:
        return {}
    _, _, body = found
    out = {}
    for pair in _split_top_level(body):
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
            v = v[1:-1]
        out[k] = v
    return out


# Keys whose values are free-form strings and MUST be quoted, even when the
# value happens to look numeric/enum-like (e.g. an all-digit password).
# Palworld reads an unquoted string value as empty.
STRING_KEYS = {
    "AdminPassword",
    "ServerPassword",
    "ServerName",
    "ServerDescription",
    "PublicIP",
    "RCONPassword",
    "Region",
    "BanListURL",
}

# Known Palworld enum literals that must stay bare. This is deliberately a
# small, explicit allowlist rather than a "looks capitalized" heuristic
# (M4): anything NOT in here (and not a bool/number) gets quoted, so a
# schema entry we don't know about fails safe instead of writing an
# unquoted string that Palworld silently reads as empty.
ENUM_VALUES = {
    "None",
    "Easy",
    "Normal",
    "Hard",
    "Difficult",
    "Casual",
    "Peaceful",
    "Sandbox",
    "Custom",
}


def _format_value(key: str, value: str) -> str:
    """Reproduce Palworld's quoting: quote unless known numeric/bool/enum."""
    v = str(value)
    if key in STRING_KEYS:
        return '"' + v.replace('"', "") + '"'
    low = v.lower()
    if low in ("true", "false"):
        return v.capitalize() if v[0].islower() else v
    # numeric (int/float, incl. negative)
    try:
        float(v)
        return v
    except ValueError:
        pass
    if v in ENUM_VALUES:
        return v
    # fail safe: anything unrecognized is quoted, not passed through bare
    return '"' + v.replace('"', "") + '"'


def set_options(raw: str, updates: dict) -> str:
    """Upsert keys inside OptionSettings=(...). Creates the block if missing."""
    found = _find_option_body(raw)
    if not found:
        block = OPTION_HEADER + "\nOptionSettings=(" + ",".join(
            f"{k}={_format_value(k, v)}" for k, v in updates.items()
        ) + ")\n"
        if raw and not raw.endswith("\n"):
            raw += "\n"
        return raw + block

    start, end, body = found
    pairs = _split_top_level(body)
    keys_order, kv = [], {}
    for pair in pairs:
        if "=" in pair:
            k = pair.split("=", 1)[0].strip()
            keys_order.append(k)
            kv[k] = pair
        else:
            keys_order.append(pair)
            kv[pair] = pair
    for k, v in updates.items():
        entry = f"{k}={_format_value(k, v)}"
        if k in kv:
            kv[k] = entry
        else:
            keys_order.append(k)
            kv[k] = entry
    new_body = ",".join(kv[k] for k in keys_order)
    return raw[:start] + new_body + raw[end:]


# ---------------------------------------------------------------------------
# File IO
# ---------------------------------------------------------------------------


def read_ini() -> str:
    if os.path.exists(INI_PATH):
        with open(INI_PATH, "r", encoding="utf-8") as f:
            return f.read()
    if os.path.exists(DEFAULT_INI_PATH):
        with open(DEFAULT_INI_PATH, "r", encoding="utf-8") as f:
            return f.read()
    return OPTION_HEADER + "\nOptionSettings=()\n"


def write_ini(raw: str):
    atomic_write(INI_PATH, raw)
    # Hand the file back to the steam user so PalServer can read it.
    _chown_steam(INI_PATH)


# ---------------------------------------------------------------------------
# Per-slot settings
# ---------------------------------------------------------------------------
#
# Each save slot carries its OWN PalWorldSettings.ini, so settings are tied to
# the save, not the server. The live ini (INI_PATH) always mirrors the ACTIVE
# slot's config:
#   - editing config (POST /api/config) snapshots the live ini into the active
#     slot's store,
#   - activating a slot swaps its stored config into the live ini,
#   - cloning copies the config too.
# Infra-critical keys (RESTAPIEnabled/RESTAPIPort/AdminPassword) are re-asserted
# by bootstrap() after every swap, so switching worlds can never break the
# panel<->game REST link regardless of what a slot's config held.

SLOT_CONFIG_DIR = os.environ.get(
    "SLOT_CONFIG_DIR", f"{STEAM_DIR}/Pal/Saved/palworld-slot-configs"
)


def _slot_config_path(guid: str) -> str:
    return os.path.join(SLOT_CONFIG_DIR, f"{_safe_name(guid)}.ini")


def save_active_config_to_slot(guid: str = "") -> None:
    """Snapshot the live PalWorldSettings.ini into a slot's config store."""
    guid = guid or get_active_world()
    if not guid or not os.path.exists(INI_PATH):
        return
    atomic_write(_slot_config_path(guid), read_ini())
    _chown_steam(_slot_config_path(guid))


def apply_slot_config(guid: str) -> bool:
    """Make the slot's stored config the live ini. Returns True if the slot had
    a stored config (and it was applied), False if it had none (live ini kept)."""
    src = _slot_config_path(guid)
    if guid and os.path.exists(src):
        with open(src, "r", encoding="utf-8") as f:
            write_ini(f.read())
        return True
    return False


def copy_slot_config(src_guid: str, dst_guid: str) -> None:
    """Copy one slot's stored config to another (used on clone / restore-as-new)."""
    src = _slot_config_path(src_guid)
    if src_guid and dst_guid and os.path.exists(src):
        os.makedirs(SLOT_CONFIG_DIR, exist_ok=True)
        with open(src, "r", encoding="utf-8") as f:
            atomic_write(_slot_config_path(dst_guid), f.read())
        _chown_steam(_slot_config_path(dst_guid))


def reset_config() -> str:
    """Reset PalWorldSettings.ini to defaults for the active save.

    Uses DefaultPalWorldSettings.ini if present, else an empty OptionSettings
    block (Palworld then falls back to its built-in defaults). REST/admin keys
    are re-asserted by bootstrap() so the panel<->game link survives, and the
    reset is snapshotted to the active slot (settings are per-save). Returns the
    resulting raw ini. A game restart is still required to apply it in-world."""
    if os.path.exists(DEFAULT_INI_PATH):
        with open(DEFAULT_INI_PATH, "r", encoding="utf-8") as f:
            raw = f.read()
    else:
        raw = OPTION_HEADER + "\nOptionSettings=()\n"
    write_ini(raw)
    bootstrap()  # force RESTAPIEnabled/RESTAPIPort/AdminPassword back into the ini
    save_active_config_to_slot()  # persist the reset to the active save
    return read_ini()


# ---------------------------------------------------------------------------
# Save slots + mods (file manipulation)
# ---------------------------------------------------------------------------


# ---- GameUserSettings.ini (picks the active world) ----


def read_gus() -> str:
    if os.path.exists(GUS_PATH):
        with open(GUS_PATH, "r", encoding="utf-8") as f:
            return f.read()
    return ""


def write_gus(raw: str):
    atomic_write(GUS_PATH, raw)
    _chown_steam(GUS_PATH)


def get_active_world() -> str:
    for line in read_gus().splitlines():
        s = line.strip()
        if s.startswith("DedicatedServerName="):
            return s.split("=", 1)[1].strip()
    return ""


def set_active_world(guid: str):
    """Point DedicatedServerName at `guid`, creating the section if needed."""
    raw = read_gus()
    line = f"DedicatedServerName={guid}"
    if not raw.strip():
        raw = GUS_HEADER + "\n" + line + "\n"
    elif re.search(r"(?m)^\s*DedicatedServerName=.*$", raw):
        raw = re.sub(r"(?m)^\s*DedicatedServerName=.*$", line, raw, count=1)
    elif GUS_HEADER in raw:
        raw = raw.replace(GUS_HEADER, GUS_HEADER + "\n" + line, 1)
    else:
        if not raw.endswith("\n"):
            raw += "\n"
        raw += GUS_HEADER + "\n" + line + "\n"
    write_gus(raw)


# ---- slot metadata (friendly names) ----


def _load_slots_meta() -> dict:
    if os.path.exists(SLOTS_META):
        try:
            with open(SLOTS_META, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_slots_meta(meta: dict):
    atomic_write(SLOTS_META, json.dumps(meta, indent=2))
    _chown_steam(SLOTS_META)


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for n in files:
            try:
                total += os.path.getsize(os.path.join(root, n))
            except OSError:
                pass
    return total


def list_slots() -> dict:
    """List save slots. The filesystem is the source of truth (M9): any
    metadata entry whose GUID folder no longer exists is garbage-collected,
    rather than accumulating forever."""
    active = get_active_world()
    meta = _load_slots_meta()
    guids = set()
    if os.path.isdir(SAVEGAMES_DIR):
        for entry in os.listdir(SAVEGAMES_DIR):
            full = os.path.join(SAVEGAMES_DIR, entry)
            if os.path.isdir(full) and not entry.startswith("_"):
                guids.add(entry)

    stale = [g for g in meta if g not in guids and g != active]
    if stale:
        for g in stale:
            meta.pop(g, None)
        _save_slots_meta(meta)

    slots = []
    for entry in sorted(guids):
        full = os.path.join(SAVEGAMES_DIR, entry)
        m = meta.get(entry, {})
        slots.append(
            {
                "guid": entry,
                "name": m.get("name", entry),
                "created": m.get("created"),
                "active": entry == active,
                "size": _dir_size(full),
                "empty": not os.listdir(full),
                "last_backup": m.get("last_backup"),
            }
        )
    # An active world whose folder doesn't exist yet (fresh slot not booted).
    if active and active not in guids:
        m = meta.get(active, {})
        slots.append(
            {
                "guid": active,
                "name": m.get("name", active),
                "created": m.get("created"),
                "active": True,
                "size": 0,
                "empty": True,
                "pending": True,
                "last_backup": m.get("last_backup"),
            }
        )
    return {"ok": True, "error": None, "active": active, "slots": slots}


def create_slot(name: str) -> dict:
    """Register a fresh world slot. Palworld fills it on next boot."""
    guid = secrets.token_hex(16).upper()  # 32-char hex, matches Palworld's form
    full = os.path.join(SAVEGAMES_DIR, guid)
    os.makedirs(full, exist_ok=True)
    _chown_steam(full, recursive=True)
    meta = _load_slots_meta()
    meta[guid] = {"name": _safe_name(name) or guid, "created": _timestamp()}
    _save_slots_meta(meta)
    return {
        "ok": True,
        "error": None,
        "guid": guid,
        "name": meta[guid]["name"],
        "created": meta[guid]["created"],
    }


def clone_slot(guid: str, name: str) -> dict:
    """Copy a world folder to a brand-new guid and register it as its own
    slot (metadata carries `cloned_from`). Copy-only: if `guid` is the
    active slot, this clones whatever is on disk right now, which may lag
    behind unsaved in-game state -- callers are told to save first."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
        return {"ok": False, "reason": "validation", "error": "invalid guid"}
    src = os.path.join(SAVEGAMES_DIR, guid)
    if not os.path.isdir(src):
        return {"ok": False, "reason": "not_found", "error": "source slot not found"}
    new_guid = secrets.token_hex(16).upper()
    dest = os.path.join(SAVEGAMES_DIR, new_guid)
    shutil.copytree(src, dest)
    _chown_steam(dest, recursive=True)
    # Settings travel with the save: capture the active slot's latest edits, then
    # copy the source slot's config to the clone.
    if guid == get_active_world():
        save_active_config_to_slot(guid)
    copy_slot_config(guid, new_guid)
    friendly = _safe_name(name) or new_guid
    created = _timestamp()
    meta = _load_slots_meta()
    meta[new_guid] = {"name": friendly, "created": created, "cloned_from": guid}
    _save_slots_meta(meta)
    result = {
        "ok": True,
        "error": None,
        "guid": new_guid,
        "name": friendly,
        "created": created,
        "cloned_from": guid,
    }
    if guid == get_active_world():
        result["note"] = (
            "cloned the active slot's last saved state on disk; "
            "save in-game first if you want the freshest copy"
        )
    return result


def rename_slot(guid: str, name: str) -> dict:
    """Update a slot's friendly name in metadata only -- no filesystem move."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
        return {"ok": False, "reason": "validation", "error": "invalid guid"}
    friendly = _safe_name(name)
    if not friendly:
        return {"ok": False, "reason": "validation", "error": "name is required"}
    exists = guid == get_active_world() or os.path.isdir(os.path.join(SAVEGAMES_DIR, guid))
    if not exists:
        return {"ok": False, "reason": "not_found", "error": "slot not found"}
    meta = _load_slots_meta()
    entry = meta.setdefault(guid, {})
    entry["name"] = friendly
    entry.setdefault("created", _timestamp())
    _save_slots_meta(meta)
    return {"ok": True, "error": None, "guid": guid, "name": friendly}


# ---- backups: one policy, naming scheme, local+GCS, retention pruning ----

# world-<guid>-<label>-<timestamp>.tar.gz ; timestamp is sortable (ISO-ish).
_BACKUP_TS_RE = re.compile(r"(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.tar\.gz$")


def _backup_sort_key(filename: str) -> str:
    m = _BACKUP_TS_RE.search(filename)
    return m.group(1) if m else filename


def _slot_backups_dir() -> str:
    d = os.path.join(SAVEGAMES_DIR, "_slot_backups")
    os.makedirs(d, exist_ok=True)
    return d


def _prune_local_backups(guid: str):
    d = _slot_backups_dir()
    prefix = f"world-{guid}-"
    try:
        files = [n for n in os.listdir(d) if n.startswith(prefix) and n.endswith(".tar.gz")]
    except OSError:
        return
    files.sort(key=_backup_sort_key, reverse=True)
    for stale in files[BACKUP_KEEP:]:
        try:
            os.remove(os.path.join(d, stale))
        except OSError:
            pass


def _prune_remote_backups(guid: str):
    if not BACKUP_BUCKET:
        return
    try:
        out = subprocess.run(
            ["gsutil", "ls", f"gs://{BACKUP_BUCKET}/slots/world-{guid}-*.tar.gz"],
            capture_output=True,
            timeout=30,
        )
        names = [
            line.strip()
            for line in out.stdout.decode(errors="replace").splitlines()
            if line.strip()
        ]
        names.sort(key=lambda uri: _backup_sort_key(uri.rsplit("/", 1)[-1]), reverse=True)
        for stale in names[BACKUP_KEEP:]:
            subprocess.run(["gsutil", "rm", stale], capture_output=True, timeout=30)
    except (subprocess.SubprocessError, OSError):
        pass


def _local_backups_for(guid: str) -> list:
    d = _slot_backups_dir()
    prefix = f"world-{guid}-"
    items = []
    try:
        names = os.listdir(d)
    except OSError:
        names = []
    for n in names:
        if not (n.startswith(prefix) and n.endswith(".tar.gz")):
            continue
        full = os.path.join(d, n)
        try:
            size = os.path.getsize(full)
            created = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(full)))
        except OSError:
            continue
        items.append({"ref": n, "file": n, "size": size, "created": created, "location": "local"})
    items.sort(key=lambda b: _backup_sort_key(b["file"]), reverse=True)
    return items


def _remote_backups_for(guid: str) -> list:
    if not BACKUP_BUCKET:
        return []
    try:
        out = subprocess.run(
            ["gsutil", "ls", "-l", f"gs://{BACKUP_BUCKET}/slots/world-{guid}-*.tar.gz"],
            capture_output=True,
            timeout=30,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    items = []
    for line in out.stdout.decode(errors="replace").splitlines():
        line = line.strip()
        m = re.match(r"^(\d+)\s+(\S+)\s+(gs://\S+)$", line)
        if not m:
            continue
        size, created, uri = int(m.group(1)), m.group(2), m.group(3)
        fname = uri.rsplit("/", 1)[-1]
        items.append(
            {
                "ref": fname,
                "file": fname,
                "size": size,
                "created": created,
                "location": "remote",
                "uri": uri,
            }
        )
    items.sort(key=lambda b: _backup_sort_key(b["file"]), reverse=True)
    return items


def list_backups(guid: str) -> dict:
    """Merge local `_slot_backups` listing + `gsutil ls` of the GCS prefix,
    dedup by filename (local wins), newest first."""
    local = _local_backups_for(guid)
    remote = _remote_backups_for(guid)
    seen = {b["ref"] for b in local}
    merged = list(local) + [b for b in remote if b["ref"] not in seen]
    merged.sort(key=lambda b: _backup_sort_key(b["file"]), reverse=True)
    return {"ok": True, "error": None, "guid": guid, "backups": merged}


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def export_world_tar(guid: str) -> tuple:
    """Tar a world folder's CURRENT on-disk state to a temp file for download.
    Returns (temp_path, download_filename) or ("", "") if the world is missing."""
    src = os.path.join(SAVEGAMES_DIR, guid)
    if not os.path.isdir(src) or not os.listdir(src):
        return "", ""
    name = _load_slots_meta().get(guid, {}).get("name") or guid
    fname = f"{_safe_name(name) or guid}-current-{_timestamp()}.tar.gz"
    tmp = os.path.join(tempfile.gettempdir(), f"dl-{secrets.token_hex(6)}.tar.gz")
    subprocess.run(
        ["tar", "czf", tmp, "-C", SAVEGAMES_DIR, guid], check=True, capture_output=True
    )
    return tmp, fname


def backup_world(guid: str, label: str = "manual") -> dict:
    """Tar a world folder; upload to GCS (if configured) and keep a local
    copy, then prune both to the last BACKUP_KEEP for this slot."""
    if not guid:
        return {"ok": False, "reason": "validation", "error": "no active world", "backed_up": False}
    src = os.path.join(SAVEGAMES_DIR, guid)
    if not os.path.isdir(src) or not os.listdir(src):
        return {
            "ok": False,
            "reason": "not_found",
            "error": "world folder missing/empty",
            "guid": guid,
            "backed_up": False,
        }
    fn = f"world-{guid}-{label}-{_timestamp()}.tar.gz"
    tmp = os.path.join(tempfile.gettempdir(), fn)
    subprocess.run(
        ["tar", "czf", tmp, "-C", SAVEGAMES_DIR, guid], check=True, capture_output=True
    )
    result = {"ok": True, "error": None, "backed_up": True, "guid": guid, "file": fn}
    # Local safety copy on the persistent data disk (last few kept).
    local_dir = _slot_backups_dir()
    shutil.copy2(tmp, os.path.join(local_dir, fn))
    _chown_steam(local_dir, recursive=True)
    result["local"] = os.path.join(local_dir, fn)
    # Remote copy in GCS.
    if BACKUP_BUCKET:
        try:
            subprocess.run(
                ["gsutil", "cp", tmp, f"gs://{BACKUP_BUCKET}/slots/{fn}"],
                check=True,
                capture_output=True,
            )
            result["remote"] = f"gs://{BACKUP_BUCKET}/slots/{fn}"
        except subprocess.CalledProcessError as e:
            result["remote_error"] = (e.stderr or b"").decode()
    try:
        os.remove(tmp)
    except OSError:
        pass
    # Record + retention.
    meta = _load_slots_meta()
    meta.setdefault(guid, {})["last_backup"] = _timestamp()
    _save_slots_meta(meta)
    _prune_local_backups(guid)
    _prune_remote_backups(guid)
    return result


def activate_slot(guid: str, restart: bool = True) -> dict:
    """Safely switch the active world: stop, backup current, switch, start."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
        return {"ok": False, "reason": "validation", "error": "invalid guid"}
    was_active = _service_active()
    current = get_active_world()
    if guid == current:
        return {"ok": True, "error": None, "active": guid, "note": "already active"}
    # Stop the game so files settle before we touch the active pointer.
    if was_active:
        stop_service()
    backup = backup_world(current, label="pre-switch") if current else {"backed_up": False}
    # Persist the outgoing slot's settings, then switch the active-world pointer.
    if current:
        save_active_config_to_slot(current)
    set_active_world(guid)
    # Swap in the target slot's own settings (or seed from the current live ini
    # if it has none yet), then re-assert the REST/admin keys so the panel link
    # survives the swap, and persist the result as this slot's config.
    apply_slot_config(guid)
    bootstrap()
    save_active_config_to_slot(guid)
    started = False
    if restart and was_active:
        start_service()
        started = True
    return {
        "ok": True,
        "error": None,
        "previous": current,
        "active": guid,
        "backup": backup,
        "restarted": started,
    }


def restore_backup(guid: str, ref: str, as_new_slot: bool = False, name: str = "") -> dict:
    """Restore a backup, validated against the slot's own backup listing
    (never an arbitrary path): stop -> snapshot-current -> extract -> chown
    -> start. `as_new_slot` extracts into a fresh guid instead of `guid`."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
        return {"ok": False, "reason": "validation", "error": "invalid guid"}
    if not ref:
        return {"ok": False, "reason": "validation", "error": "ref is required"}

    listing = list_backups(guid)
    match = next((b for b in listing["backups"] if b["ref"] == ref), None)
    if not match:
        return {"ok": False, "reason": "not_found", "error": "backup not found for this slot"}

    target_guid = secrets.token_hex(16).upper() if as_new_slot else guid

    tmp_tar = os.path.join(tempfile.gettempdir(), f"restore-{secrets.token_hex(6)}.tar.gz")
    try:
        if match["location"] == "local":
            shutil.copy2(os.path.join(_slot_backups_dir(), match["file"]), tmp_tar)
        else:
            subprocess.run(
                ["gsutil", "cp", match["uri"], tmp_tar], check=True, capture_output=True, timeout=120
            )
    except (OSError, subprocess.CalledProcessError) as e:
        return {"ok": False, "reason": "conflict", "error": f"could not fetch backup: {e}"}

    was_running = _service_active()
    if was_running:
        stop_service()
    current = get_active_world()
    pre_restore_backup = backup_world(current, label="pre-restore") if current else {"backed_up": False}

    extract_root = os.path.join(tempfile.gettempdir(), f"restore-extract-{secrets.token_hex(6)}")
    try:
        os.makedirs(extract_root, exist_ok=True)
        subprocess.run(
            ["tar", "xzf", tmp_tar, "-C", extract_root], check=True, capture_output=True
        )
        subs = [d for d in os.listdir(extract_root) if os.path.isdir(os.path.join(extract_root, d))]
        if len(subs) != 1:
            raise RuntimeError("unexpected archive layout")
        extracted = os.path.join(extract_root, subs[0])
        dest_dir = os.path.join(SAVEGAMES_DIR, target_guid)
        if os.path.isdir(dest_dir):
            shutil.rmtree(dest_dir)
        shutil.move(extracted, dest_dir)
        _chown_steam(dest_dir, recursive=True)
    except (subprocess.CalledProcessError, RuntimeError, OSError) as e:
        if was_running:
            start_service()
        return {"ok": False, "reason": "conflict", "error": f"restore extract failed: {e}"}
    finally:
        shutil.rmtree(extract_root, ignore_errors=True)
        try:
            os.remove(tmp_tar)
        except OSError:
            pass

    meta = _load_slots_meta()
    if as_new_slot or target_guid not in meta:
        meta[target_guid] = {
            "name": _safe_name(name) or meta.get(target_guid, {}).get("name") or target_guid,
            "created": meta.get(target_guid, {}).get("created") or _timestamp(),
        }
    if as_new_slot:
        # a restored-as-new slot inherits the source slot's settings
        copy_slot_config(guid, target_guid)
    _save_slots_meta(meta)
    save_active_config_to_slot(current) if current else None
    set_active_world(target_guid)
    apply_slot_config(target_guid)
    bootstrap()
    save_active_config_to_slot(target_guid)
    started = False
    if was_running:
        start_service()
        started = True
    return {
        "ok": True,
        "error": None,
        "guid": target_guid,
        "source_guid": guid,
        "ref": ref,
        "as_new_slot": as_new_slot,
        "previous_active": current,
        "pre_restore_backup": pre_restore_backup,
        "restarted": started,
    }


# ---- import (upload) a world: the inverse of the download endpoints ----
#
# Accepts what /download produces (a .tar.gz of the world folder) and also a
# plain .zip of a world directory, since that's what people have lying around
# from a local/host server. Always lands as a NEW slot: importing never
# overwrites a world you already have -- activate it when you're ready.
#
# Uploading goes through an upload *session* (init -> ordered parts -> finish)
# because the console talks to the coordinator, a Cloud Function, and Cloud Run
# refuses a request body over 32 MiB. Parts are appended to one file on the VM's
# own disk, so the archive is only ever assembled here.


def _uploads_root() -> str:
    d = os.path.join(tempfile.gettempdir(), "palworld-uploads")
    os.makedirs(d, exist_ok=True)
    return d


def _prune_upload_sessions():
    now = time.time()
    root = _uploads_root()
    try:
        entries = os.listdir(root)
    except OSError:
        return
    for name in entries:
        path = os.path.join(root, name)
        try:
            if now - os.path.getmtime(path) > UPLOAD_SESSION_TTL:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


def _upload_dir(uid: str) -> str:
    """Session directory for `uid`, or "" if the id is malformed/unknown. The
    strict token shape is what keeps this off arbitrary paths."""
    if not re.fullmatch(r"[a-f0-9]{24}", uid or ""):
        return ""
    path = os.path.join(_uploads_root(), uid)
    return path if os.path.isdir(path) else ""


def _upload_meta_path(d: str) -> str:
    return os.path.join(d, "meta.json")


def _read_upload_meta(d: str) -> dict:
    try:
        with open(_upload_meta_path(d), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _write_upload_meta(d: str, meta: dict):
    atomic_write(_upload_meta_path(d), json.dumps(meta, indent=2))


def start_upload_session(filename: str = "", name: str = "") -> dict:
    _prune_upload_sessions()
    uid = secrets.token_hex(12)
    d = os.path.join(_uploads_root(), uid)
    os.makedirs(d, exist_ok=True)
    _write_upload_meta(
        d,
        {"filename": _safe_name(filename), "name": (name or "").strip(), "parts": 0, "bytes": 0},
    )
    return {
        "ok": True,
        "error": None,
        "upload_id": uid,
        "part_max_bytes": UPLOAD_PART_MAX_BYTES,
        "max_bytes": SAVE_MAX_BYTES,
    }


def abort_upload_session(uid: str) -> dict:
    d = _upload_dir(uid)
    if not d:
        return {"ok": False, "reason": "not_found", "error": "upload session not found"}
    shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "error": None, "aborted": uid}


def _safe_extract_archive(archive: str, dest: str, max_bytes: int) -> int:
    """Extract a .tar.gz / .zip into `dest`, refusing anything that could write
    outside it (absolute paths, "..") and skipping non-regular entries
    (symlinks, hardlinks, devices). Stops if the *uncompressed* payload exceeds
    `max_bytes`, which is the zip-bomb guard. Returns bytes written."""

    def target_for(member_name: str) -> str:
        parts = [p for p in member_name.replace("\\", "/").split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts):
            raise ValueError(f"unsafe path in archive: {member_name!r}")
        return os.path.join(dest, *parts) if parts else ""

    total = 0
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                path = target_for(info.filename)
                if not path:
                    continue
                if info.is_dir():
                    os.makedirs(path, exist_ok=True)
                    continue
                if stat.S_ISLNK(info.external_attr >> 16):
                    continue
                total += info.file_size
                if total > max_bytes:
                    raise ValueError(f"archive contents exceed {max_bytes} bytes")
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with zf.open(info) as src, open(path, "wb") as out:
                    shutil.copyfileobj(src, out, 1024 * 1024)
        return total

    if tarfile.is_tarfile(archive):
        with tarfile.open(archive) as tf:
            for member in tf:
                path = target_for(member.name)
                if not path:
                    continue
                if member.isdir():
                    os.makedirs(path, exist_ok=True)
                    continue
                if not member.isfile():
                    continue
                total += member.size
                if total > max_bytes:
                    raise ValueError(f"archive contents exceed {max_bytes} bytes")
                src = tf.extractfile(member)
                if src is None:
                    continue
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with src, open(path, "wb") as out:
                    shutil.copyfileobj(src, out, 1024 * 1024)
        return total

    raise ValueError("unrecognized archive (expected .tar.gz or .zip)")


def _find_world_dir(root: str) -> str:
    """Shallowest directory under `root` that holds a Level.sav -- that's the
    world folder, whether the archive wrapped it in a GUID directory (what our
    own download produces), nested it under Saved/SaveGames/0/<guid>, or zipped
    the world's files at the top level."""
    best, best_depth = "", 1 << 30
    for current, _dirs, files in os.walk(root):
        if any(f.lower() == "level.sav" for f in files):
            depth = current[len(root):].count(os.sep)
            if depth < best_depth:
                best, best_depth = current, depth
    return best


def import_world_archive(archive_path: str, name: str = "") -> dict:
    """Extract an uploaded world archive into a brand-new slot."""
    extract_root = os.path.join(tempfile.gettempdir(), f"import-{secrets.token_hex(6)}")
    try:
        os.makedirs(extract_root, exist_ok=True)
        try:
            _safe_extract_archive(archive_path, extract_root, SAVE_MAX_BYTES)
        except (ValueError, tarfile.TarError, zipfile.BadZipFile, OSError) as e:
            return {"ok": False, "reason": "validation", "error": f"could not read archive: {e}"}
        world = _find_world_dir(extract_root)
        if not world:
            return {
                "ok": False,
                "reason": "validation",
                "error": "no Palworld world in the archive (no Level.sav found)",
            }
        guid = secrets.token_hex(16).upper()
        dest = os.path.join(SAVEGAMES_DIR, guid)
        try:
            os.makedirs(SAVEGAMES_DIR, exist_ok=True)
            shutil.move(world, dest)
            _chown_steam(dest, recursive=True)
        except OSError as e:
            shutil.rmtree(dest, ignore_errors=True)
            return {"ok": False, "reason": "conflict", "error": f"could not install world: {e}"}
    finally:
        shutil.rmtree(extract_root, ignore_errors=True)

    friendly = _safe_name(name) or f"imported-{_timestamp()}"
    meta = _load_slots_meta()
    meta[guid] = {"name": friendly, "created": _timestamp(), "imported": True}
    _save_slots_meta(meta)
    return {
        "ok": True,
        "error": None,
        "guid": guid,
        "name": friendly,
        "size": _dir_size(dest),
        "note": "imported as a new slot -- activate it when you want to play it",
    }


def finish_upload_session(uid: str, name: str = "") -> dict:
    d = _upload_dir(uid)
    if not d:
        return {"ok": False, "reason": "not_found", "error": "upload session not found"}
    meta = _read_upload_meta(d)
    archive = os.path.join(d, "archive")
    try:
        if not meta.get("bytes") or not os.path.isfile(archive):
            return {"ok": False, "reason": "validation", "error": "no data uploaded"}
        return import_world_archive(archive, name or meta.get("name") or meta.get("filename") or "")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def delete_slot(guid: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
        return {"ok": False, "reason": "validation", "error": "invalid guid"}
    if guid == get_active_world():
        return {"ok": False, "reason": "conflict", "error": "cannot delete the active slot"}
    full = os.path.join(SAVEGAMES_DIR, guid)
    if not os.path.isdir(full):
        return {"ok": False, "reason": "not_found", "error": "not found"}
    backup = backup_world(guid, label="pre-delete")
    shutil.rmtree(full)
    try:
        os.remove(_slot_config_path(guid))
    except OSError:
        pass
    meta = _load_slots_meta()
    meta.pop(guid, None)
    _save_slots_meta(meta)
    return {"ok": True, "error": None, "deleted": guid, "backup": backup}


# ---- mods: dual-mode (native pak/logic vs Proton-only ue4ss) ----
#
# Three on-disk locations, one sidecar metadata file keyed by mod name
# (pak/logic: the *.pak filename; ue4ss: the mod's folder name), each entry
# extended with a "type" field:
#   pak    ~mods/*.pak                         enable = rename .pak<->.pak.disabled
#   logic  Paks/LogicMods/*.pak                enable = rename .pak<->.pak.disabled
#   ue4ss  Binaries/Win64/ue4ss/Mods/<name>/    enable = enabled.txt marker file
# list_mods() self-prunes metadata whose backing file/dir is gone (M9-style).


def _load_mods_meta() -> dict:
    if os.path.exists(MODS_META):
        try:
            with open(MODS_META, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_mods_meta(meta: dict):
    atomic_write(MODS_META, json.dumps(meta, indent=2))
    _chown_steam(MODS_META)


def _pak_style_path(base_dir: str, name: str) -> str | None:
    safe = _safe_name(name)
    if not safe.lower().endswith(".pak") or safe in (".pak",):
        return None
    return os.path.join(base_dir, safe)


def _mod_path(name: str) -> str | None:
    """Path a loose *.pak mod would live at in ~mods."""
    return _pak_style_path(MODS_DIR, name)


def _logic_mod_path(name: str) -> str | None:
    """Path a LogicMods *.pak mod would live at in Paks/LogicMods."""
    return _pak_style_path(LOGICMODS_DIR, name)


def _ue4ss_mod_dir(name: str) -> str | None:
    """Path a UE4SS script mod's folder would live at under ue4ss/Mods."""
    safe = _safe_name(name)
    if not safe or safe.startswith("."):
        return None
    return os.path.join(UE4SS_MODS_DIR, safe)


def _resolve_mod(name: str):
    """Locate `name` across the three mod locations, pak -> logic -> ue4ss.
    Returns (type, active_path_or_dir, disabled_path_or_marker) or None."""
    pak_dest = _mod_path(name)
    if pak_dest and (os.path.isfile(pak_dest) or os.path.isfile(pak_dest + ".disabled")):
        return "pak", pak_dest, pak_dest + ".disabled"
    logic_dest = _logic_mod_path(name)
    if logic_dest and (os.path.isfile(logic_dest) or os.path.isfile(logic_dest + ".disabled")):
        return "logic", logic_dest, logic_dest + ".disabled"
    ue4ss_dir = _ue4ss_mod_dir(name)
    if ue4ss_dir and os.path.isdir(ue4ss_dir):
        return "ue4ss", ue4ss_dir, os.path.join(ue4ss_dir, "enabled.txt")
    return None


def list_mods() -> dict:
    """List mods across all three locations. The filesystem is the source
    of truth: any sidecar entry whose backing file/dir is gone is
    garbage-collected instead of accumulating forever."""
    meta = _load_mods_meta()
    mods = []
    seen = set()

    def _scan_pak_style(base_dir: str, mod_type: str):
        if not os.path.isdir(base_dir):
            return
        for n in sorted(os.listdir(base_dir)):
            full = os.path.join(base_dir, n)
            if not os.path.isfile(full):
                continue
            lower = n.lower()
            if lower.endswith(".pak"):
                base, enabled = n, True
            elif lower.endswith(".pak.disabled"):
                base, enabled = n[: -len(".disabled")], False
            else:
                continue
            seen.add(base)
            m = meta.get(base, {})
            mods.append(
                {
                    "name": base,
                    "type": mod_type,
                    "size": os.path.getsize(full),
                    "enabled": enabled,
                    "source_url": m.get("source_url"),
                    "installed_at": m.get("installed_at"),
                }
            )

    _scan_pak_style(MODS_DIR, "pak")
    _scan_pak_style(LOGICMODS_DIR, "logic")

    if os.path.isdir(UE4SS_MODS_DIR):
        for n in sorted(os.listdir(UE4SS_MODS_DIR)):
            full = os.path.join(UE4SS_MODS_DIR, n)
            if not os.path.isdir(full):
                continue
            seen.add(n)
            m = meta.get(n, {})
            mods.append(
                {
                    "name": n,
                    "type": "ue4ss",
                    "size": _dir_size(full),
                    "enabled": os.path.isfile(os.path.join(full, "enabled.txt")),
                    "source_url": m.get("source_url"),
                    "installed_at": m.get("installed_at"),
                }
            )

    stale = [k for k in meta if k not in seen]
    if stale:
        for k in stale:
            meta.pop(k, None)
        _save_mods_meta(meta)

    return {
        "ok": True,
        "error": None,
        "dir": MODS_DIR,
        "runtime_mode": RUNTIME_MODE,
        "capabilities": {"pak": True, "logic": True, "ue4ss": RUNTIME_MODE == "proton"},
        "mods": mods,
    }


def save_mod_file(name: str, tmp_path: str, size: int) -> dict:
    """Move a fully-written temp file into MODS_DIR as a *.pak, atomically
    (the temp file must already live on MODS_DIR's filesystem for os.replace
    to be atomic)."""
    dest = _mod_path(name)
    if not dest:
        return {"ok": False, "reason": "validation", "error": "name must be a safe *.pak filename"}
    if size <= 0:
        return {"ok": False, "reason": "validation", "error": "empty upload"}
    os.makedirs(MODS_DIR, exist_ok=True)
    os.replace(tmp_path, dest)
    _chown_steam(dest)
    base = os.path.basename(dest)
    meta = _load_mods_meta()
    meta[base] = {
        "source_url": meta.get(base, {}).get("source_url"),
        "installed_at": _timestamp(),
        "enabled": True,
        "type": "pak",
    }
    _save_mods_meta(meta)
    return {"ok": True, "error": None, "name": base, "size": size, "type": "pak"}


# ---- mod archives (.zip): layout detection + file placement only --------
#
# NO cmd/ps1/script execution, ever. This only extracts an archive and
# copies files into the location a Windows setup script would use; it
# never runs anything from inside the archive.


def _safe_zip_extract(zip_path: str, extract_root: str):
    """Extract `zip_path` into `extract_root`, refusing any entry whose
    resolved path would land outside it (zip-slip guard). Raises
    zipfile.BadZipFile for a corrupt archive, ValueError for a zip-slip
    attempt -- callers turn both into a validation error."""
    with zipfile.ZipFile(zip_path) as zf:
        root_abs = os.path.abspath(extract_root)
        for member in zf.namelist():
            dest = os.path.abspath(os.path.join(extract_root, member))
            if not (dest == root_abs or dest.startswith(root_abs + os.sep)):
                raise ValueError("zip entry escapes archive root")
        zf.extractall(extract_root)


def _detect_archive_layout(root: str) -> str | None:
    """Classify an extracted mod archive by walking its tree once. UE4SS
    markers are checked first: a script-mod bundle may also ship a helper
    .pak, but the *dominant* type is what gates the Proton requirement."""
    has_ue4ss = has_logicmods = has_pak = False
    for dirpath, dirnames, filenames in os.walk(root):
        for d in dirnames:
            dl = d.lower()
            if dl in ("mods", "dlls"):
                has_ue4ss = True
            if dl == "logicmods":
                has_logicmods = True
        for f in filenames:
            fl = f.lower()
            if fl == "enabled.txt" or fl.endswith(".dll") or "ue4ss" in fl:
                has_ue4ss = True
            if fl.endswith(".pak"):
                has_pak = True
    if has_ue4ss:
        return "ue4ss"
    if has_logicmods:
        return "logic"
    if has_pak:
        return "pak"
    return None


def _place_pak_files(root: str, source_url: str | None) -> list:
    """Copy every loose *.pak found anywhere in the archive into ~mods."""
    os.makedirs(MODS_DIR, exist_ok=True)
    installed = []
    meta = _load_mods_meta()
    for dirpath, _dirnames, filenames in os.walk(root):
        for f in filenames:
            if not f.lower().endswith(".pak"):
                continue
            safe = _safe_name(f)
            if not safe.lower().endswith(".pak"):
                continue
            dest = os.path.join(MODS_DIR, safe)
            shutil.copy2(os.path.join(dirpath, f), dest)
            _chown_steam(dest)
            meta[safe] = {"source_url": source_url, "installed_at": _timestamp(), "enabled": True, "type": "pak"}
            installed.append(safe)
    _save_mods_meta(meta)
    return installed


def _place_logic_files(root: str, source_url: str | None) -> list:
    """Copy the *.pak files inside any LogicMods/ folder into Paks/LogicMods."""
    os.makedirs(LOGICMODS_DIR, exist_ok=True)
    installed = []
    meta = _load_mods_meta()
    for dirpath, dirnames, _filenames in os.walk(root):
        for d in dirnames:
            if d.lower() != "logicmods":
                continue
            logic_src = os.path.join(dirpath, d)
            for f in sorted(os.listdir(logic_src)):
                if not f.lower().endswith(".pak"):
                    continue
                safe = _safe_name(f)
                if not safe.lower().endswith(".pak"):
                    continue
                dest = os.path.join(LOGICMODS_DIR, safe)
                shutil.copy2(os.path.join(logic_src, f), dest)
                _chown_steam(dest)
                meta[safe] = {
                    "source_url": source_url,
                    "installed_at": _timestamp(),
                    "enabled": True,
                    "type": "logic",
                }
                installed.append(safe)
    _save_mods_meta(meta)
    return installed


def _place_ue4ss_files(root: str, source_url: str | None) -> list:
    """Place a UE4SS script mod into ue4ss/Mods/<name>/, enabled by default
    (an enabled.txt marker is created if the bundle didn't ship one).
    Prefers a `Mods/` wrapper folder (one subfolder per mod); falls back to
    treating the archive's single top-level folder (or its root) as one mod."""
    os.makedirs(UE4SS_MODS_DIR, exist_ok=True)
    installed = []
    meta = _load_mods_meta()

    def _install_one(src: str, name_hint: str):
        safe = _safe_name(name_hint) or ("mod-" + secrets.token_hex(4))
        dest = os.path.join(UE4SS_MODS_DIR, safe)
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
        marker = os.path.join(dest, "enabled.txt")
        if not os.path.exists(marker):
            atomic_write(marker, "")
        _chown_steam(dest, recursive=True)
        meta[safe] = {"source_url": source_url, "installed_at": _timestamp(), "enabled": True, "type": "ue4ss"}
        installed.append(safe)

    mods_wrapper = None
    for dirpath, dirnames, _filenames in os.walk(root):
        for d in dirnames:
            if d.lower() == "mods":
                mods_wrapper = os.path.join(dirpath, d)
                break
        if mods_wrapper:
            break

    if mods_wrapper:
        for entry in sorted(os.listdir(mods_wrapper)):
            full = os.path.join(mods_wrapper, entry)
            if os.path.isdir(full):
                _install_one(full, entry)
    else:
        entries = [e for e in os.listdir(root) if e != "__MACOSX"]
        if len(entries) == 1 and os.path.isdir(os.path.join(root, entries[0])):
            _install_one(os.path.join(root, entries[0]), entries[0])
        else:
            _install_one(root, "mod-" + secrets.token_hex(4))

    _save_mods_meta(meta)
    return installed


def install_mod_archive(zip_path: str, source_url: str | None = None) -> dict:
    """Extract a mod .zip and place its files by detected layout: loose
    *.pak -> ~mods; a LogicMods/ dir -> Paks/LogicMods; a UE4SS layout
    (Mods/, dlls/, enabled.txt, or *ue4ss* files) -> ue4ss/Mods. If the
    detected type is ue4ss and the runtime isn't Proton, refuses (409)."""
    extract_root = tempfile.mkdtemp(prefix="modzip-")
    try:
        try:
            _safe_zip_extract(zip_path, extract_root)
        except zipfile.BadZipFile:
            return {"ok": False, "reason": "validation", "error": "not a valid zip archive"}
        except ValueError as e:
            return {"ok": False, "reason": "validation", "error": str(e)}

        mtype = _detect_archive_layout(extract_root)
        if not mtype:
            return {
                "ok": False,
                "reason": "validation",
                "error": "could not detect mod layout (expected loose .pak, a LogicMods/ folder, or a UE4SS Mods/ layout)",
            }
        if mtype == "ue4ss" and RUNTIME_MODE != "proton":
            return {
                "ok": False,
                "reason": "conflict",
                "error": "requires Proton runtime (enable it in server settings)",
            }
        placer = {"pak": _place_pak_files, "logic": _place_logic_files, "ue4ss": _place_ue4ss_files}[mtype]
        installed = placer(extract_root, source_url)
        if not installed:
            return {"ok": False, "reason": "validation", "error": f"no files placed for detected type '{mtype}'"}
        return {"ok": True, "error": None, "type": mtype, "installed": installed}
    finally:
        shutil.rmtree(extract_root, ignore_errors=True)


def install_ue4ss_runtime(url: str = "") -> dict:
    """Download RE-UE4SS and place it into Pal/Binaries/Win64 (Proton-only).
    File placement only -- nothing from the archive is ever executed."""
    if RUNTIME_MODE != "proton":
        return {"ok": False, "reason": "conflict", "error": "requires Proton runtime (enable it in server settings)"}
    target_url = url or UE4SS_DEFAULT_URL
    if not target_url:
        return {"ok": False, "reason": "validation", "error": "no url provided and UE4SS_DEFAULT_URL is not configured"}
    if not re.match(r"^https?://", target_url):
        return {"ok": False, "reason": "validation", "error": "url must be http(s)"}
    parsed = urllib.parse.urlparse(target_url)
    if not parsed.hostname or _is_blocked_host(parsed.hostname):
        return {"ok": False, "reason": "validation", "error": "target host is not allowed"}

    req = urllib.request.Request(target_url, headers={"User-Agent": "palworld-panel"})
    fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix=".ue4ss-")
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            length = resp.headers.get("Content-Length")
            if length and int(length) > MOD_MAX_BYTES:
                raise ValueError(f"remote file exceeds MOD_MAX_BYTES ({MOD_MAX_BYTES})")
            with os.fdopen(fd, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MOD_MAX_BYTES:
                        raise ValueError(f"remote file exceeds MOD_MAX_BYTES ({MOD_MAX_BYTES})")
                    f.write(chunk)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as e:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return {"ok": False, "reason": "validation", "error": f"download failed: {e}"}

    win64_dir = os.path.join(STEAM_DIR, "Pal", "Binaries", "Win64")
    extract_root = tempfile.mkdtemp(prefix="ue4ss-")
    try:
        os.makedirs(win64_dir, exist_ok=True)
        _safe_zip_extract(tmp_path, extract_root)
        for entry in os.listdir(extract_root):
            src = os.path.join(extract_root, entry)
            dest = os.path.join(win64_dir, entry)
            if os.path.isdir(src):
                if os.path.isdir(dest):
                    shutil.rmtree(dest)
                shutil.copytree(src, dest)
            else:
                shutil.copy2(src, dest)
        _chown_steam(win64_dir, recursive=True)
    except (zipfile.BadZipFile, ValueError, OSError) as e:
        return {"ok": False, "reason": "validation", "error": f"install failed: {e}"}
    finally:
        shutil.rmtree(extract_root, ignore_errors=True)
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    os.makedirs(UE4SS_MODS_DIR, exist_ok=True)
    _chown_steam(UE4SS_MODS_DIR, recursive=True)
    return {"ok": True, "error": None, "installed": True, "dir": win64_dir}


def _is_blocked_host(hostname: str) -> bool:
    """SSRF guard (M2): reject loopback / link-local / RFC1918 / reserved
    targets. Fails safe — an unresolvable host is also blocked."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return True
    if not infos:
        return True
    for info in infos:
        ip = info[4][0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return True
        if (
            addr.is_loopback
            or addr.is_link_local
            or addr.is_private
            or addr.is_reserved
            or addr.is_multicast
            or addr.is_unspecified
        ):
            return True
    return False


def install_mod_url(url: str, name: str = "") -> dict:
    """Same rules as upload: a resolved *.pak downloads straight into
    ~mods; a resolved *.zip is fetched then run through the same
    layout-detecting placement as an uploaded archive (size-capped,
    SSRF-guarded either way)."""
    if not re.match(r"^https?://", url or ""):
        return {"ok": False, "reason": "validation", "error": "url must be http(s)"}
    parsed = urllib.parse.urlparse(url)
    if not parsed.hostname or _is_blocked_host(parsed.hostname):
        return {"ok": False, "reason": "validation", "error": "target host is not allowed"}
    fname = name or os.path.basename(parsed.path)

    if (fname or "").lower().endswith(".zip"):
        req = urllib.request.Request(url, headers={"User-Agent": "palworld-panel"})
        fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix=".fetch-")
        total = 0
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                length = resp.headers.get("Content-Length")
                if length and int(length) > MOD_MAX_BYTES:
                    raise ValueError(f"remote file exceeds MOD_MAX_BYTES ({MOD_MAX_BYTES})")
                with os.fdopen(fd, "wb") as f:
                    while True:
                        chunk = resp.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MOD_MAX_BYTES:
                            raise ValueError(f"remote file exceeds MOD_MAX_BYTES ({MOD_MAX_BYTES})")
                        f.write(chunk)
            return install_mod_archive(tmp_path, source_url=url)
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as e:
            return {"ok": False, "reason": "validation", "error": f"download failed: {e}"}
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    dest = _mod_path(fname)
    if not dest:
        return {"ok": False, "reason": "validation", "error": "resolved name is not a safe *.pak filename"}
    os.makedirs(MODS_DIR, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "palworld-panel"})
    fd, tmp_path = tempfile.mkstemp(dir=MODS_DIR, prefix=".fetch-")
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            length = resp.headers.get("Content-Length")
            if length and int(length) > MOD_MAX_BYTES:
                raise ValueError(f"remote file exceeds MOD_MAX_BYTES ({MOD_MAX_BYTES})")
            with os.fdopen(fd, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MOD_MAX_BYTES:
                        raise ValueError(f"remote file exceeds MOD_MAX_BYTES ({MOD_MAX_BYTES})")
                    f.write(chunk)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as e:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return {"ok": False, "reason": "validation", "error": f"download failed: {e}"}
    r = save_mod_file(fname, tmp_path, total)
    if r.get("ok"):
        meta = _load_mods_meta()
        entry = meta.setdefault(r["name"], {})
        entry["source_url"] = url
        entry["type"] = "pak"
        _save_mods_meta(meta)
    return r


def set_mod_enabled(name: str, enabled: bool) -> dict:
    """Enable/disable across all mod types: pak/logic toggle via the
    `.pak` <-> `.pak.disabled` rename trick; ue4ss toggles the
    `enabled.txt` marker file UE4SS itself looks for inside the mod folder."""
    loc = _resolve_mod(name)
    if not loc:
        return {"ok": False, "reason": "not_found", "error": "not found"}
    mtype, active, marker = loc
    if mtype in ("pak", "logic"):
        if enabled:
            if os.path.isfile(marker) and not os.path.isfile(active):
                os.replace(marker, active)
            elif not os.path.isfile(active):
                return {"ok": False, "reason": "not_found", "error": "not found"}
        else:
            if os.path.isfile(active) and not os.path.isfile(marker):
                os.replace(active, marker)
            elif not os.path.isfile(marker):
                return {"ok": False, "reason": "not_found", "error": "not found"}
        _chown_steam(active if os.path.isfile(active) else marker)
        base = os.path.basename(active)
    else:  # ue4ss: active = mod dir, marker = enabled.txt sentinel inside it
        if enabled:
            atomic_write(marker, "")
        else:
            try:
                os.remove(marker)
            except OSError:
                pass
        _chown_steam(active, recursive=True)
        base = os.path.basename(active)
    meta = _load_mods_meta()
    entry = meta.setdefault(base, {})
    entry["enabled"] = enabled
    entry["type"] = mtype
    _save_mods_meta(meta)
    return {"ok": True, "error": None, "name": base, "type": mtype, "enabled": enabled}


def delete_mod(name: str) -> dict:
    """Delete across all mod types: a pak/logic file (enabled or disabled),
    or a whole ue4ss mod directory."""
    loc = _resolve_mod(name)
    if not loc:
        return {"ok": False, "reason": "not_found", "error": "not found"}
    mtype, active, marker = loc
    if mtype in ("pak", "logic"):
        target = active if os.path.isfile(active) else (marker if os.path.isfile(marker) else None)
        if not target:
            return {"ok": False, "reason": "not_found", "error": "not found"}
        os.remove(target)
        base = os.path.basename(active)
    else:
        shutil.rmtree(active, ignore_errors=True)
        base = os.path.basename(active)
    meta = _load_mods_meta()
    meta.pop(base, None)
    _save_mods_meta(meta)
    return {"ok": True, "error": None, "deleted": base, "type": mtype}


# ---------------------------------------------------------------------------
# Domain error envelope: { ok, error, ...data } with real status codes
# ---------------------------------------------------------------------------

_REASON_STATUS = {"validation": 400, "not_found": 404, "conflict": 409}


def _status_for(r: dict) -> int:
    if r.get("ok"):
        return 200
    return _REASON_STATUS.get(r.get("reason"), 400)


def _envelope(r: dict):
    from fastapi.responses import JSONResponse

    body = {"ok": bool(r.get("ok")), "error": (r.get("error") if not r.get("ok") else None)}
    for k, v in r.items():
        if k not in ("ok", "error", "reason"):
            body[k] = v
    return JSONResponse(status_code=_status_for(r), content=body)


# ---------------------------------------------------------------------------
# Palworld REST API proxy (stdlib urllib)
# ---------------------------------------------------------------------------


def rest_call(method: str, path: str, body: dict | None = None):
    url = f"http://{REST_HOST}:{REST_PORT}/v1/api/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    token = base64.b64encode(f"admin:{ADMIN_PASSWORD}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode() or ""
            status = resp.status
    except urllib.error.HTTPError as e:
        text = e.read().decode() or ""
        status = e.code
    except urllib.error.URLError as e:
        return 502, {"error": f"REST API unreachable: {e.reason}"}
    try:
        payload = json.loads(text) if text else {}
    except json.JSONDecodeError:
        payload = {"raw": text}
    return status, payload


# ---------------------------------------------------------------------------
# RBAC — verify the coordinator's signed propagation headers (H1)
# ---------------------------------------------------------------------------
#
# The coordinator sends, on every proxied call:
#   X-Coord-User, X-Coord-Perms (comma-separated), X-Coord-Ts (unix seconds),
#   X-Coord-Sig = hex HMAC-SHA256("<user>\n<perms>\n<ts>", key=INTERNAL_TOKEN)
# If present, valid, and fresh (<=120s), the request is trusted as that user
# with that permission set. Otherwise we fall back to Basic Auth
# (break-glass), logging that we did so.

_RBAC_MAX_SKEW_SECONDS = 120

# In-memory per-IP sliding-window throttle for failed Basic-Auth attempts.
_FAILED_LOGIN_WINDOW = 60
_FAILED_LOGIN_MAX = 5
_failed_logins: dict = {}


def _verify_coord_headers(headers):
    """Return (user, perms:set) if the signed RBAC headers verify, else None."""
    user = headers.get("X-Coord-User")
    perms_h = headers.get("X-Coord-Perms")
    ts_h = headers.get("X-Coord-Ts")
    sig_h = headers.get("X-Coord-Sig")
    if not INTERNAL_TOKEN or not (user and perms_h is not None and ts_h and sig_h):
        return None
    try:
        ts = int(ts_h)
    except ValueError:
        return None
    if abs(time.time() - ts) > _RBAC_MAX_SKEW_SECONDS:
        return None
    msg = f"{user}\n{perms_h}\n{ts_h}".encode()
    expected = hmac.new(INTERNAL_TOKEN.encode(), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig_h):
        return None
    raw_perms = {p.strip() for p in perms_h.split(",") if p.strip()}
    # Legacy tolerance: an older coordinator (or a stale token) may still send
    # the coarse "config" perm -- expand it so per-endpoint checks below (which
    # use the granular names) keep working.
    perms = set(_expand_perms(raw_perms))
    return user, perms


def _throttle_check(ip: str):
    now = time.time()
    hits = [t for t in _failed_logins.get(ip, []) if now - t < _FAILED_LOGIN_WINDOW]
    _failed_logins[ip] = hits
    return len(hits) >= _FAILED_LOGIN_MAX


def _throttle_fail(ip: str):
    _failed_logins.setdefault(ip, []).append(time.time())


# ---------------------------------------------------------------------------
# Bootstrap (CLI)
# ---------------------------------------------------------------------------


def bootstrap():
    """Ensure REST API is enabled in the ini. Idempotent."""
    raw = read_ini()
    updates = {"RESTAPIEnabled": "True", "RESTAPIPort": str(REST_PORT)}
    opts = parse_options(raw)
    if ADMIN_PASSWORD:
        # Force the configured password so panel and server agree on REST auth.
        updates["AdminPassword"] = ADMIN_PASSWORD
    elif not opts.get("AdminPassword"):
        updates["AdminPassword"] = secrets.token_urlsafe(12)
    raw = set_options(raw, updates)
    write_ini(raw)
    print(f"bootstrap: REST API enabled on port {REST_PORT} in {INI_PATH}")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


def build_app():
    from fastapi import Depends, FastAPI, HTTPException, Request, status
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
    from fastapi.security import HTTPBasic, HTTPBasicCredentials
    from starlette.background import BackgroundTask

    app = FastAPI(title="Palworld Panel", docs_url=None, redoc_url=None)
    sec = HTTPBasic(auto_error=False)

    def _client_ip(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    def require(perm: str):
        """Dependency factory: verify signed RBAC headers first; fall back
        to Basic Auth (break-glass, logged) and enforce `perm` either way."""

        def dep(request: Request, cred: HTTPBasicCredentials | None = Depends(sec)) -> str:
            verified = _verify_coord_headers(request.headers)
            if verified is not None:
                user, perms = verified
            else:
                print(
                    f"panel: no valid signed RBAC headers on "
                    f"{request.method} {request.url.path}; falling back to Basic Auth"
                )
                ip = _client_ip(request)
                if _throttle_check(ip):
                    raise HTTPException(
                        status.HTTP_429_TOO_MANY_REQUESTS,
                        "too many failed login attempts, try again shortly",
                    )
                if cred is None:
                    raise HTTPException(
                        status.HTTP_401_UNAUTHORIZED,
                        "Invalid credentials",
                        headers={"WWW-Authenticate": "Basic"},
                    )
                ok_u = secrets.compare_digest(cred.username, PANEL_USER)
                ok_p = secrets.compare_digest(cred.password, PANEL_PASSWORD)
                if not (ok_u and ok_p):
                    _throttle_fail(ip)
                    raise HTTPException(
                        status.HTTP_401_UNAUTHORIZED,
                        "Invalid credentials",
                        headers={"WWW-Authenticate": "Basic"},
                    )
                user, perms = cred.username, set(ALL_PERMS)
            if perm not in perms:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "insufficient permissions")
            return user

        return dep

    @app.get("/", response_class=HTMLResponse)
    def index():
        # Public: the page renders a login form and authenticates the API calls.
        with open(INDEX_PATH, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())

    @app.get("/api/session")
    def session(user: str = Depends(require("view"))):
        # Used by the login form to validate credentials.
        return {"ok": True, "user": user}

    @app.post("/api/self-update")
    def self_update(_: str = Depends(require("commands"))):
        # Pull the latest panel code from GCS, health-check it, and restart.
        # A syntactically-broken panel.py would otherwise brick this service in
        # a systemd restart loop, so we snapshot the current code first and roll
        # back if the freshly-fetched code fails to compile.
        if not PANEL_BUCKET:
            raise HTTPException(400, "PANEL_BUCKET not configured")

        code_files = ["panel.py", "index.html", "idle_watchdog.py"]
        backup_dir = os.path.join(PANEL_DIR, ".prev")
        os.makedirs(backup_dir, exist_ok=True)
        for fn in code_files:
            src = os.path.join(PANEL_DIR, fn)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(backup_dir, fn))

        try:
            subprocess.run(
                ["gsutil", "-m", "rsync", f"gs://{PANEL_BUCKET}", PANEL_DIR],
                check=True,
                capture_output=True,
                timeout=120,
            )
        except subprocess.CalledProcessError as e:
            raise HTTPException(500, f"rsync failed: {(e.stderr or b'').decode()}")

        # Health-check: the new Python must at least compile. If not, roll back
        # the code files and refuse to restart (the running process is unharmed).
        py = os.path.join(PANEL_DIR, "venv", "bin", "python")
        if not os.path.exists(py):
            py = sys.executable or "python3"
        py_files = [os.path.join(PANEL_DIR, f) for f in ("panel.py", "idle_watchdog.py")]
        check = subprocess.run([py, "-m", "py_compile", *py_files], capture_output=True)
        if check.returncode != 0:
            for fn in code_files:
                bak = os.path.join(backup_dir, fn)
                if os.path.exists(bak):
                    shutil.copy2(bak, os.path.join(PANEL_DIR, fn))
            raise HTTPException(
                500,
                "fetched panel code failed the compile health-check; rolled back, "
                f"not restarting: {(check.stderr or b'').decode()[:500]}",
            )

        # Restart after replying so the client gets a response first.
        #
        # One unit per `systemctl` call, deliberately: the sudoers drop-in
        # (startup.sh) whitelists `systemctl restart palworld-panel` and
        # `systemctl restart palworld-watchdog` as separate commands, and sudo
        # matches the full argument list -- restarting both in a single call
        # matches nothing and is denied. Since this Popen is fire-and-forget,
        # that denial used to be invisible: the endpoint answered
        # {"updated": true, "restarting": true} while the old code kept running,
        # and only a fresh VM boot ever picked up a new agent.
        sudo = "sudo -n " if os.geteuid() != 0 else ""
        units = [f"{SERVICE_NAME}-watchdog", f"{SERVICE_NAME}-panel"]  # panel last: it kills us
        script = "sleep 1; " + "; ".join(f"{sudo}systemctl restart {u}" for u in units)
        subprocess.Popen(["bash", "-c", script])
        return {"updated": True, "restarting": True, "units": units}

    # ---- config (.ini) ----

    @app.get("/api/config")
    def get_config(_: str = Depends(require("view"))):
        raw = read_ini()
        return {"raw": raw, "options": parse_options(raw), "path": INI_PATH}

    @app.post("/api/config")
    async def post_config(payload: dict, restart: bool = False, _: str = Depends(require("settings"))):
        if "raw" in payload and payload["raw"] is not None:
            raw = payload["raw"]
        elif "options" in payload:
            raw = set_options(read_ini(), payload["options"])
        else:
            raise HTTPException(400, "provide 'raw' or 'options'")
        write_ini(raw)
        # Settings are tied to the save: persist this edit to the active slot.
        save_active_config_to_slot()
        result = {"saved": True}
        if restart:
            try:
                restart_service()
                result["restarted"] = True
            except subprocess.CalledProcessError as e:
                result["restarted"] = False
                result["error"] = (e.stderr or b"").decode()
        return result

    @app.post("/api/config/reset")
    def post_config_reset(restart: bool = False, _: str = Depends(require("settings"))):
        raw = reset_config()
        result = {
            "ok": True,
            "error": None,
            "reset": True,
            "raw": raw,
            "options": parse_options(raw),
            "path": INI_PATH,
        }
        if restart:
            try:
                restart_service()
                result["restarted"] = True
            except subprocess.CalledProcessError as e:
                result["restarted"] = False
                result["error"] = (e.stderr or b"").decode()
        return result

    @app.post("/api/restart")
    def post_restart(_: str = Depends(require("settings"))):
        try:
            restart_service()
            return {"restarted": True}
        except subprocess.CalledProcessError as e:
            return JSONResponse(
                status_code=500,
                content={"restarted": False, "error": (e.stderr or b"").decode()},
            )

    # ---- Palworld REST API proxy ----

    GET_EPS = {"info", "players", "settings", "metrics"}
    POST_EPS = {"announce", "kick", "ban", "unban", "save", "shutdown", "stop"}

    @app.get("/api/rest/{endpoint}")
    def rest_get(endpoint: str, _: str = Depends(require("view"))):
        if endpoint not in GET_EPS:
            raise HTTPException(404, "unknown endpoint")
        code, payload = rest_call("GET", endpoint)
        return JSONResponse(status_code=code, content=payload)

    @app.post("/api/rest/{endpoint}")
    async def rest_post(endpoint: str, body: dict | None = None, _: str = Depends(require("commands"))):
        if endpoint not in POST_EPS:
            raise HTTPException(404, "unknown endpoint")
        code, payload = rest_call("POST", endpoint, body or {})
        return JSONResponse(status_code=code, content=payload)

    # ---- save slots ----

    @app.get("/api/saves")
    def saves_list(_: str = Depends(require("view"))):
        return list_slots()

    @app.post("/api/saves")
    async def saves_create(payload: dict, _: str = Depends(require("saves"))):
        name = (payload or {}).get("name") or ""
        return _envelope(create_slot(name))

    # ---- save import: chunked upload session (init -> parts -> finish) ----
    # Declared before the /api/saves/{guid}/* routes so "upload" is never read
    # as a guid.

    @app.post("/api/saves/upload")
    async def saves_upload_init(payload: dict | None = None, _: str = Depends(require("saves"))):
        payload = payload or {}
        return _envelope(
            start_upload_session(payload.get("filename") or "", payload.get("name") or "")
        )

    @app.post("/api/saves/upload/{uid}/part")
    async def saves_upload_part(
        uid: str, request: Request, index: int = 0, _: str = Depends(require("saves"))
    ):
        d = _upload_dir(uid)
        if not d:
            raise HTTPException(404, "upload session not found")
        meta = _read_upload_meta(d)
        already = int(meta.get("bytes") or 0)
        expected = int(meta.get("parts") or 0)
        # Parts must arrive in order: the archive is a single append-only file,
        # so an out-of-order part would silently corrupt it.
        if index != expected:
            raise HTTPException(409, f"expected part {expected}, got {index}")
        archive = os.path.join(d, "archive")
        written = 0
        try:
            with open(archive, "ab") as f:
                async for chunk in request.stream():
                    written += len(chunk)
                    if written > UPLOAD_PART_MAX_BYTES:
                        raise HTTPException(400, f"part exceeds {UPLOAD_PART_MAX_BYTES} bytes")
                    if already + written > SAVE_MAX_BYTES:
                        raise HTTPException(400, f"upload exceeds SAVE_MAX_BYTES ({SAVE_MAX_BYTES})")
                    f.write(chunk)
        except BaseException:
            # Roll the file back to the last complete part so a retry of this
            # index still lines up (a half-written part is worse than none).
            try:
                os.truncate(archive, already)
            except OSError:
                pass
            raise
        meta["parts"] = index + 1
        meta["bytes"] = already + written
        _write_upload_meta(d, meta)
        return _envelope({"ok": True, "parts": meta["parts"], "bytes": meta["bytes"]})

    @app.post("/api/saves/upload/{uid}/finish")
    async def saves_upload_finish(
        uid: str, payload: dict | None = None, _: str = Depends(require("saves"))
    ):
        return _envelope(finish_upload_session(uid, (payload or {}).get("name") or ""))

    @app.delete("/api/saves/upload/{uid}")
    def saves_upload_abort(uid: str, _: str = Depends(require("saves"))):
        return _envelope(abort_upload_session(uid))

    @app.post("/api/saves/{guid}/clone")
    async def saves_clone(guid: str, payload: dict, _: str = Depends(require("saves"))):
        name = (payload or {}).get("name") or ""
        return _envelope(clone_slot(guid, name))

    @app.post("/api/saves/{guid}/rename")
    async def saves_rename(guid: str, payload: dict, _: str = Depends(require("saves"))):
        name = (payload or {}).get("name") or ""
        return _envelope(rename_slot(guid, name))

    @app.post("/api/saves/{guid}/activate")
    def saves_activate(guid: str, restart: bool = True, _: str = Depends(require("saves"))):
        return _envelope(activate_slot(guid, restart=restart))

    @app.post("/api/saves/{guid}/backup")
    def saves_backup(guid: str, _: str = Depends(require("saves"))):
        return _envelope(backup_world(guid, label="manual"))

    @app.get("/api/saves/{guid}/backups")
    def saves_backups(guid: str, _: str = Depends(require("view"))):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
            return _envelope({"ok": False, "reason": "validation", "error": "invalid guid"})
        return list_backups(guid)

    @app.get("/api/saves/{guid}/download")
    def saves_download(guid: str, _: str = Depends(require("view"))):
        """Download the CURRENT on-disk state of a save as a .tar.gz."""
        if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
            raise HTTPException(400, "invalid guid")
        tmp, fname = export_world_tar(guid)
        if not tmp:
            raise HTTPException(404, "world not found or empty")
        return FileResponse(
            tmp,
            media_type="application/gzip",
            filename=fname,
            background=BackgroundTask(_safe_remove, tmp),
        )

    @app.get("/api/saves/{guid}/backups/{ref}/download")
    def saves_backup_download(guid: str, ref: str, _: str = Depends(require("view"))):
        """Download a specific backup, validated against the slot's own listing."""
        if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
            raise HTTPException(400, "invalid guid")
        match = next((b for b in list_backups(guid)["backups"] if b["ref"] == ref), None)
        if not match:
            raise HTTPException(404, "backup not found for this slot")
        if match["location"] == "local":
            path = os.path.join(_slot_backups_dir(), match["file"])
            if not os.path.isfile(path):
                raise HTTPException(404, "backup file missing")
            return FileResponse(path, media_type="application/gzip", filename=match["file"])
        # remote-only: fetch from GCS to a temp file, then stream + clean up
        tmp = os.path.join(tempfile.gettempdir(), f"dl-{secrets.token_hex(6)}.tar.gz")
        try:
            subprocess.run(
                ["gsutil", "cp", match["uri"], tmp], check=True, capture_output=True, timeout=180
            )
        except subprocess.CalledProcessError as e:
            raise HTTPException(502, f"could not fetch backup: {(e.stderr or b'').decode()}")
        return FileResponse(
            tmp,
            media_type="application/gzip",
            filename=match["file"],
            background=BackgroundTask(_safe_remove, tmp),
        )

    @app.post("/api/saves/{guid}/restore")
    async def saves_restore(guid: str, payload: dict, _: str = Depends(require("saves"))):
        payload = payload or {}
        ref = payload.get("ref") or ""
        as_new_slot = bool(payload.get("as_new_slot") or False)
        name = payload.get("name") or ""
        return _envelope(restore_backup(guid, ref, as_new_slot=as_new_slot, name=name))

    @app.delete("/api/saves/{guid}")
    def saves_delete(guid: str, _: str = Depends(require("saves"))):
        return _envelope(delete_slot(guid))

    # ---- mods ----

    @app.get("/api/mods")
    def mods_list(_: str = Depends(require("view"))):
        return list_mods()

    @app.post("/api/mods/upload")
    async def mods_upload(
        request: Request, name: str, restart: bool = False, _: str = Depends(require("mods"))
    ):
        # Streamed upload (no python-multipart dependency) with a byte
        # ceiling enforced as chunks arrive, so we never buffer the whole
        # file in RAM (M1) and never write past MOD_MAX_BYTES. Accepts a
        # loose *.pak (straight into ~mods) or a *.zip bundle (extracted and
        # placed by detected layout -- pak/logic/ue4ss; see install_mod_archive).
        lower = (name or "").lower()
        if lower.endswith(".zip"):
            fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix=".upload-")
            total = 0
            try:
                with os.fdopen(fd, "wb") as f:
                    async for chunk in request.stream():
                        total += len(chunk)
                        if total > MOD_MAX_BYTES:
                            raise HTTPException(400, f"upload exceeds MOD_MAX_BYTES ({MOD_MAX_BYTES})")
                        f.write(chunk)
            except HTTPException:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
                raise
            except Exception:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
                raise
            try:
                r = install_mod_archive(tmp_path, source_url=None)
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            if r.get("ok") and restart:
                try:
                    restart_service()
                    r["restarted"] = True
                except subprocess.CalledProcessError:
                    r["restarted"] = False
            return _envelope(r)

        if not lower.endswith(".pak"):
            return _envelope({"ok": False, "reason": "validation", "error": "name must end in .pak or .zip"})
        if not _mod_path(name):
            return _envelope({"ok": False, "reason": "validation", "error": "name must be a safe *.pak filename"})
        os.makedirs(MODS_DIR, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=MODS_DIR, prefix=".upload-")
        total = 0
        try:
            with os.fdopen(fd, "wb") as f:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > MOD_MAX_BYTES:
                        raise HTTPException(400, f"upload exceeds MOD_MAX_BYTES ({MOD_MAX_BYTES})")
                    f.write(chunk)
        except HTTPException:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise
        except Exception:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise
        r = save_mod_file(name, tmp_path, total)
        if r.get("ok") and restart:
            try:
                restart_service()
                r["restarted"] = True
            except subprocess.CalledProcessError:
                r["restarted"] = False
        return _envelope(r)

    @app.post("/api/mods/url")
    def mods_url(payload: dict, restart: bool = False, _: str = Depends(require("mods"))):
        r = install_mod_url((payload or {}).get("url", ""), (payload or {}).get("name", ""))
        if r.get("ok") and restart:
            try:
                restart_service()
                r["restarted"] = True
            except subprocess.CalledProcessError:
                r["restarted"] = False
        return _envelope(r)

    @app.post("/api/mods/ue4ss/install")
    async def mods_ue4ss_install(payload: dict | None = None, _: str = Depends(require("mods"))):
        url = (payload or {}).get("url") or ""
        return _envelope(install_ue4ss_runtime(url))

    @app.post("/api/mods/{name}/enable")
    def mods_enable(name: str, _: str = Depends(require("mods"))):
        return _envelope(set_mod_enabled(name, True))

    @app.post("/api/mods/{name}/disable")
    def mods_disable(name: str, _: str = Depends(require("mods"))):
        return _envelope(set_mod_enabled(name, False))

    @app.delete("/api/mods/{name}")
    def mods_delete(name: str, _: str = Depends(require("mods"))):
        return _envelope(delete_mod(name))

    return app


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "bootstrap":
        bootstrap()
        return
    import uvicorn

    uvicorn.run(build_app(), host="0.0.0.0", port=PANEL_PORT)


# Module-level app for `uvicorn panel:app`
try:
    app = build_app()
except Exception:  # fastapi not importable during bootstrap-only runs
    app = None


if __name__ == "__main__":
    main()
