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
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

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

# Number of per-slot backups kept, both locally and in GCS (prune-on-write).
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "5"))
# Byte ceiling for mod uploads / url-installs (default 500MB).
MOD_MAX_BYTES = int(os.environ.get("MOD_MAX_BYTES", str(500 * 1024 * 1024)))


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

# RBAC permission set propagated from the coordinator (view/power/config/
# commands/users). Basic-Auth (break-glass) is granted all of them.
ALL_PERMS = {"view", "power", "config", "commands", "users"}

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
    set_active_world(guid)
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
    _save_slots_meta(meta)
    set_active_world(target_guid)
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
    meta = _load_slots_meta()
    meta.pop(guid, None)
    _save_slots_meta(meta)
    return {"ok": True, "error": None, "deleted": guid, "backup": backup}


# ---- mods (.pak into ~mods, sidecar metadata, enable via rename) ----


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


def _mod_path(name: str) -> str | None:
    safe = _safe_name(name)
    if not safe.lower().endswith(".pak") or safe in (".pak",):
        return None
    return os.path.join(MODS_DIR, safe)


def list_mods() -> dict:
    meta = _load_mods_meta()
    mods = []
    seen = set()
    if os.path.isdir(MODS_DIR):
        for n in sorted(os.listdir(MODS_DIR)):
            full = os.path.join(MODS_DIR, n)
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
                    "size": os.path.getsize(full),
                    "enabled": enabled,
                    "source_url": m.get("source_url"),
                    "installed_at": m.get("installed_at"),
                }
            )
    stale = [k for k in meta if k not in seen]
    if stale:
        for k in stale:
            meta.pop(k, None)
        _save_mods_meta(meta)
    return {"ok": True, "error": None, "dir": MODS_DIR, "mods": mods}


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
    }
    _save_mods_meta(meta)
    return {"ok": True, "error": None, "name": base, "size": size}


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
    if not re.match(r"^https?://", url or ""):
        return {"ok": False, "reason": "validation", "error": "url must be http(s)"}
    parsed = urllib.parse.urlparse(url)
    if not parsed.hostname or _is_blocked_host(parsed.hostname):
        return {"ok": False, "reason": "validation", "error": "target host is not allowed"}
    fname = name or os.path.basename(parsed.path)
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
        meta.setdefault(r["name"], {})["source_url"] = url
        _save_mods_meta(meta)
    return r


def set_mod_enabled(name: str, enabled: bool) -> dict:
    """Enable/disable = rename `.pak` <-> `.pak.disabled` (no delete)."""
    dest = _mod_path(name)
    if not dest:
        return {"ok": False, "reason": "validation", "error": "invalid mod name"}
    disabled = dest + ".disabled"
    base = os.path.basename(dest)
    if enabled:
        if os.path.isfile(disabled) and not os.path.isfile(dest):
            os.replace(disabled, dest)
        elif not os.path.isfile(dest):
            return {"ok": False, "reason": "not_found", "error": "not found"}
    else:
        if os.path.isfile(dest) and not os.path.isfile(disabled):
            os.replace(dest, disabled)
        elif not os.path.isfile(disabled):
            return {"ok": False, "reason": "not_found", "error": "not found"}
    _chown_steam(dest if os.path.isfile(dest) else disabled)
    meta = _load_mods_meta()
    meta.setdefault(base, {})["enabled"] = enabled
    _save_mods_meta(meta)
    return {"ok": True, "error": None, "name": base, "enabled": enabled}


def delete_mod(name: str) -> dict:
    dest = _mod_path(name)
    if not dest:
        return {"ok": False, "reason": "validation", "error": "invalid mod name"}
    disabled = dest + ".disabled"
    target = dest if os.path.isfile(dest) else (disabled if os.path.isfile(disabled) else None)
    if not target:
        return {"ok": False, "reason": "not_found", "error": "not found"}
    os.remove(target)
    meta = _load_mods_meta()
    meta.pop(os.path.basename(dest), None)
    _save_mods_meta(meta)
    return {"ok": True, "error": None, "deleted": os.path.basename(dest)}


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
    perms = {p.strip() for p in perms_h.split(",") if p.strip()}
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
    from fastapi.responses import HTMLResponse, JSONResponse
    from fastapi.security import HTTPBasic, HTTPBasicCredentials

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
        sudo = "sudo -n " if os.geteuid() != 0 else ""
        subprocess.Popen(
            [
                "bash",
                "-c",
                f"sleep 1; {sudo}systemctl restart {SERVICE_NAME}-panel {SERVICE_NAME}-watchdog",
            ]
        )
        return {"updated": True, "restarting": True}

    # ---- config (.ini) ----

    @app.get("/api/config")
    def get_config(_: str = Depends(require("view"))):
        raw = read_ini()
        return {"raw": raw, "options": parse_options(raw), "path": INI_PATH}

    @app.post("/api/config")
    async def post_config(payload: dict, restart: bool = False, _: str = Depends(require("config"))):
        if "raw" in payload and payload["raw"] is not None:
            raw = payload["raw"]
        elif "options" in payload:
            raw = set_options(read_ini(), payload["options"])
        else:
            raise HTTPException(400, "provide 'raw' or 'options'")
        write_ini(raw)
        result = {"saved": True}
        if restart:
            try:
                restart_service()
                result["restarted"] = True
            except subprocess.CalledProcessError as e:
                result["restarted"] = False
                result["error"] = (e.stderr or b"").decode()
        return result

    @app.post("/api/restart")
    def post_restart(_: str = Depends(require("config"))):
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
    async def saves_create(payload: dict, _: str = Depends(require("config"))):
        name = (payload or {}).get("name") or ""
        return _envelope(create_slot(name))

    @app.post("/api/saves/{guid}/activate")
    def saves_activate(guid: str, restart: bool = True, _: str = Depends(require("config"))):
        return _envelope(activate_slot(guid, restart=restart))

    @app.post("/api/saves/{guid}/backup")
    def saves_backup(guid: str, _: str = Depends(require("config"))):
        return _envelope(backup_world(guid, label="manual"))

    @app.get("/api/saves/{guid}/backups")
    def saves_backups(guid: str, _: str = Depends(require("view"))):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
            return _envelope({"ok": False, "reason": "validation", "error": "invalid guid"})
        return list_backups(guid)

    @app.post("/api/saves/{guid}/restore")
    async def saves_restore(guid: str, payload: dict, _: str = Depends(require("config"))):
        payload = payload or {}
        ref = payload.get("ref") or ""
        as_new_slot = bool(payload.get("as_new_slot") or False)
        name = payload.get("name") or ""
        return _envelope(restore_backup(guid, ref, as_new_slot=as_new_slot, name=name))

    @app.delete("/api/saves/{guid}")
    def saves_delete(guid: str, _: str = Depends(require("config"))):
        return _envelope(delete_slot(guid))

    # ---- mods ----

    @app.get("/api/mods")
    def mods_list(_: str = Depends(require("view"))):
        return list_mods()

    @app.post("/api/mods/upload")
    async def mods_upload(
        request: Request, name: str, restart: bool = False, _: str = Depends(require("config"))
    ):
        # Streamed upload (no python-multipart dependency) with a byte
        # ceiling enforced as chunks arrive, so we never buffer the whole
        # file in RAM (M1) and never write past MOD_MAX_BYTES.
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
    def mods_url(payload: dict, restart: bool = False, _: str = Depends(require("config"))):
        r = install_mod_url((payload or {}).get("url", ""), (payload or {}).get("name", ""))
        if r.get("ok") and restart:
            try:
                restart_service()
                r["restarted"] = True
            except subprocess.CalledProcessError:
                r["restarted"] = False
        return _envelope(r)

    @app.post("/api/mods/{name}/enable")
    def mods_enable(name: str, _: str = Depends(require("config"))):
        return _envelope(set_mod_enabled(name, True))

    @app.post("/api/mods/{name}/disable")
    def mods_disable(name: str, _: str = Depends(require("config"))):
        return _envelope(set_mod_enabled(name, False))

    @app.delete("/api/mods/{name}")
    def mods_delete(name: str, _: str = Depends(require("config"))):
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
