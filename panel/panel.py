#!/usr/bin/env python3
"""
Palworld admin panel backend.

Runs on the Palworld VM. Serves the frontend, edits PalWorldSettings.ini,
restarts the systemd service, and proxies the Palworld REST API
(localhost:RESTAPIPort, HTTP Basic 'admin':AdminPassword).

Config via env vars:
  PANEL_USER, PANEL_PASSWORD   basic-auth for the panel itself
  ADMIN_PASSWORD               Palworld REST API admin password
  REST_PORT                    Palworld REST API port (default 8212)
  REST_HOST                    Palworld REST API host (default 127.0.0.1)
  INI_PATH                     path to PalWorldSettings.ini
  DEFAULT_INI_PATH             path to DefaultPalWorldSettings.ini (seed)
  SERVICE_NAME                 systemd unit to restart (default palworld)
  STEAM_USER                   owner to chown the ini back to (default steam)
  PANEL_PORT                   port to listen on (default 8080)
  INDEX_PATH                   path to index.html

CLI:
  python panel.py bootstrap    ensure REST API keys exist in the ini, then exit
  python panel.py serve        run the web server (default)
"""

import base64
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
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
# Friendly-name metadata for slots (guid -> {name, created}).
SLOTS_META = os.environ.get("SLOTS_META", f"{STEAM_DIR}/Pal/Saved/palworld-slots.json")


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

# ---------------------------------------------------------------------------
# OptionSettings parsing / editing
# ---------------------------------------------------------------------------


def _split_top_level(body: str):
    """Split OptionSettings body on commas that are not inside quotes."""
    parts, buf, in_quotes = [], [], False
    for ch in body:
        if ch == '"':
            in_quotes = not in_quotes
            buf.append(ch)
        elif ch == "," and not in_quotes:
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
# value looks enum-like (e.g. an alphanumeric password). Palworld reads an
# unquoted string value as empty.
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


def _format_value(key: str, value: str) -> str:
    """Reproduce Palworld's quoting: strings quoted, bools/nums/enums bare."""
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
    # enum-like (no spaces, starts uppercase, e.g. Difficulty=None)
    if v and " " not in v and v.replace("_", "").isalnum() and v[0].isupper():
        return v
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
    os.makedirs(os.path.dirname(INI_PATH), exist_ok=True)
    with open(INI_PATH, "w", encoding="utf-8") as f:
        f.write(raw)
    # Hand the file back to the steam user so PalServer can read it.
    try:
        import pwd

        pw = pwd.getpwnam(STEAM_USER)
        os.chown(INI_PATH, pw.pw_uid, pw.pw_gid)
    except (KeyError, PermissionError):
        pass


def restart_service():
    subprocess.run(
        ["systemctl", "restart", SERVICE_NAME], check=True, capture_output=True
    )


def stop_service():
    subprocess.run(
        ["systemctl", "stop", SERVICE_NAME], check=True, capture_output=True
    )


def start_service():
    subprocess.run(
        ["systemctl", "start", SERVICE_NAME], check=True, capture_output=True
    )


def _service_active() -> bool:
    r = subprocess.run(
        ["systemctl", "is-active", "--quiet", SERVICE_NAME]
    )
    return r.returncode == 0


# ---------------------------------------------------------------------------
# Save slots + mods (file manipulation)
# ---------------------------------------------------------------------------


def _chown_steam(path: str, recursive: bool = False):
    """Give a path back to the steam user so PalServer can read/write it."""
    try:
        import pwd

        pw = pwd.getpwnam(STEAM_USER)
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
    except (KeyError, PermissionError, FileNotFoundError):
        pass


def _timestamp() -> str:
    return time.strftime("%Y-%m-%d_%H-%M-%S")


def _safe_name(name: str) -> str:
    """A friendly slot/mod name reduced to a filesystem-safe token."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", (name or "").strip())[:64]


# ---- GameUserSettings.ini (picks the active world) ----


def read_gus() -> str:
    if os.path.exists(GUS_PATH):
        with open(GUS_PATH, "r", encoding="utf-8") as f:
            return f.read()
    return ""


def write_gus(raw: str):
    os.makedirs(os.path.dirname(GUS_PATH), exist_ok=True)
    with open(GUS_PATH, "w", encoding="utf-8") as f:
        f.write(raw)
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
    os.makedirs(os.path.dirname(SLOTS_META), exist_ok=True)
    with open(SLOTS_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
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
    active = get_active_world()
    meta = _load_slots_meta()
    slots = []
    guids = set()
    if os.path.isdir(SAVEGAMES_DIR):
        for entry in sorted(os.listdir(SAVEGAMES_DIR)):
            full = os.path.join(SAVEGAMES_DIR, entry)
            if not os.path.isdir(full) or entry.startswith("_"):
                continue
            guids.add(entry)
            m = meta.get(entry, {})
            slots.append(
                {
                    "guid": entry,
                    "name": m.get("name", entry),
                    "created": m.get("created"),
                    "active": entry == active,
                    "size": _dir_size(full),
                    "empty": not os.listdir(full),
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
            }
        )
    return {"active": active, "slots": slots}


def create_slot(name: str) -> dict:
    """Register a fresh world slot. Palworld fills it on next boot."""
    guid = secrets.token_hex(16).upper()  # 32-char hex, matches Palworld's form
    full = os.path.join(SAVEGAMES_DIR, guid)
    os.makedirs(full, exist_ok=True)
    _chown_steam(full, recursive=True)
    meta = _load_slots_meta()
    meta[guid] = {"name": _safe_name(name) or guid, "created": _timestamp()}
    _save_slots_meta(meta)
    return {"guid": guid, "name": meta[guid]["name"], "created": meta[guid]["created"]}


def backup_world(guid: str, label: str = "manual") -> dict:
    """Tar a world folder; upload to GCS (if configured) and keep a local copy."""
    if not guid:
        return {"backed_up": False, "error": "no active world"}
    src = os.path.join(SAVEGAMES_DIR, guid)
    if not os.path.isdir(src) or not os.listdir(src):
        return {"backed_up": False, "error": "world folder missing/empty", "guid": guid}
    fn = f"world-{guid}-{label}-{_timestamp()}.tar.gz"
    tmp = os.path.join("/tmp", fn)
    subprocess.run(
        ["tar", "czf", tmp, "-C", SAVEGAMES_DIR, guid], check=True, capture_output=True
    )
    result = {"backed_up": True, "guid": guid, "file": fn}
    # Local safety copy on the persistent data disk (last few kept).
    local_dir = os.path.join(SAVEGAMES_DIR, "_slot_backups")
    os.makedirs(local_dir, exist_ok=True)
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
    return result


def activate_slot(guid: str, restart: bool = True) -> dict:
    """Safely switch the active world: stop, backup current, switch, start."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
        return {"ok": False, "error": "invalid guid"}
    was_active = _service_active()
    current = get_active_world()
    if guid == current:
        return {"ok": True, "active": guid, "note": "already active"}
    # Stop the game so files settle before we touch the active pointer.
    if was_active:
        stop_service()
    backup = backup_world(current, label="pre-switch") if current else {"backed_up": False}
    set_active_world(guid)
    started = False
    if restart and was_active:
        start_service()
        started = True
    return {"ok": True, "previous": current, "active": guid, "backup": backup, "restarted": started}


def delete_slot(guid: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", guid or ""):
        return {"ok": False, "error": "invalid guid"}
    if guid == get_active_world():
        return {"ok": False, "error": "cannot delete the active slot"}
    full = os.path.join(SAVEGAMES_DIR, guid)
    if not os.path.isdir(full):
        return {"ok": False, "error": "not found"}
    backup = backup_world(guid, label="pre-delete")
    shutil.rmtree(full)
    meta = _load_slots_meta()
    meta.pop(guid, None)
    _save_slots_meta(meta)
    return {"ok": True, "deleted": guid, "backup": backup}


# ---- mods (.pak into ~mods) ----


def list_mods() -> dict:
    mods = []
    if os.path.isdir(MODS_DIR):
        for n in sorted(os.listdir(MODS_DIR)):
            full = os.path.join(MODS_DIR, n)
            if os.path.isfile(full) and n.lower().endswith(".pak"):
                mods.append({"name": n, "size": os.path.getsize(full)})
    return {"dir": MODS_DIR, "mods": mods}


def _mod_path(name: str) -> str | None:
    safe = _safe_name(name)
    if not safe.lower().endswith(".pak") or safe in (".pak",):
        return None
    return os.path.join(MODS_DIR, safe)


def save_mod_bytes(name: str, data: bytes) -> dict:
    dest = _mod_path(name)
    if not dest:
        return {"ok": False, "error": "name must be a safe *.pak filename"}
    if not data:
        return {"ok": False, "error": "empty upload"}
    os.makedirs(MODS_DIR, exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)
    _chown_steam(MODS_DIR, recursive=True)
    return {"ok": True, "name": os.path.basename(dest), "size": len(data)}


def install_mod_url(url: str, name: str = "") -> dict:
    if not re.match(r"^https?://", url or ""):
        return {"ok": False, "error": "url must be http(s)"}
    fname = name or os.path.basename(url.split("?", 1)[0])
    dest = _mod_path(fname)
    if not dest:
        return {"ok": False, "error": "resolved name is not a safe *.pak filename"}
    os.makedirs(MODS_DIR, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "palworld-panel"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError) as e:
        return {"ok": False, "error": f"download failed: {e}"}
    with open(dest, "wb") as f:
        f.write(data)
    _chown_steam(MODS_DIR, recursive=True)
    return {"ok": True, "name": os.path.basename(dest), "size": len(data)}


def delete_mod(name: str) -> dict:
    dest = _mod_path(name)
    if not dest or not os.path.isfile(dest):
        return {"ok": False, "error": "not found"}
    os.remove(dest)
    return {"ok": True, "deleted": os.path.basename(dest)}


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
    sec = HTTPBasic()

    def auth(cred: HTTPBasicCredentials = Depends(sec)):
        ok_u = secrets.compare_digest(cred.username, PANEL_USER)
        ok_p = secrets.compare_digest(cred.password, PANEL_PASSWORD)
        if not (ok_u and ok_p):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
                headers={"WWW-Authenticate": "Basic"},
            )
        return cred.username

    @app.get("/", response_class=HTMLResponse)
    def index():
        # Public: the page renders a login form and authenticates the API calls.
        with open(INDEX_PATH, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())

    @app.get("/api/session")
    def session(user: str = Depends(auth)):
        # Used by the login form to validate credentials.
        return {"ok": True, "user": user}

    @app.post("/api/self-update")
    def self_update(_: str = Depends(auth)):
        # Pull the latest panel code from GCS and restart this service.
        if not PANEL_BUCKET:
            raise HTTPException(400, "PANEL_BUCKET not configured")
        try:
            subprocess.run(
                ["gsutil", "-m", "rsync", f"gs://{PANEL_BUCKET}", PANEL_DIR],
                check=True,
                capture_output=True,
                timeout=120,
            )
        except subprocess.CalledProcessError as e:
            raise HTTPException(500, f"rsync failed: {(e.stderr or b'').decode()}")
        # Restart after replying so the client gets a response first.
        subprocess.Popen(
            ["bash", "-c", f"sleep 1; systemctl restart {SERVICE_NAME}-panel {SERVICE_NAME}-watchdog"]
        )
        return {"updated": True, "restarting": True}

    # ---- config (.ini) ----

    @app.get("/api/config")
    def get_config(_: str = Depends(auth)):
        raw = read_ini()
        return {"raw": raw, "options": parse_options(raw), "path": INI_PATH}

    @app.post("/api/config")
    async def post_config(payload: dict, restart: bool = False, _: str = Depends(auth)):
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
    def post_restart(_: str = Depends(auth)):
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
    def rest_get(endpoint: str, _: str = Depends(auth)):
        if endpoint not in GET_EPS:
            raise HTTPException(404, "unknown endpoint")
        code, payload = rest_call("GET", endpoint)
        return JSONResponse(status_code=code, content=payload)

    @app.post("/api/rest/{endpoint}")
    async def rest_post(endpoint: str, body: dict | None = None, _: str = Depends(auth)):
        if endpoint not in POST_EPS:
            raise HTTPException(404, "unknown endpoint")
        code, payload = rest_call("POST", endpoint, body or {})
        return JSONResponse(status_code=code, content=payload)

    # ---- save slots ----

    @app.get("/api/saves")
    def saves_list(_: str = Depends(auth)):
        return list_slots()

    @app.post("/api/saves")
    async def saves_create(payload: dict, _: str = Depends(auth)):
        name = (payload or {}).get("name") or ""
        return create_slot(name)

    @app.post("/api/saves/{guid}/activate")
    def saves_activate(guid: str, restart: bool = True, _: str = Depends(auth)):
        r = activate_slot(guid, restart=restart)
        return JSONResponse(status_code=200 if r.get("ok") else 400, content=r)

    @app.post("/api/saves/{guid}/backup")
    def saves_backup(guid: str, _: str = Depends(auth)):
        r = backup_world(guid, label="manual")
        return JSONResponse(status_code=200 if r.get("backed_up") else 400, content=r)

    @app.delete("/api/saves/{guid}")
    def saves_delete(guid: str, _: str = Depends(auth)):
        r = delete_slot(guid)
        return JSONResponse(status_code=200 if r.get("ok") else 400, content=r)

    # ---- mods ----

    @app.get("/api/mods")
    def mods_list(_: str = Depends(auth)):
        return list_mods()

    @app.post("/api/mods/upload")
    async def mods_upload(request: Request, name: str, restart: bool = False, _: str = Depends(auth)):
        # Raw body upload (no python-multipart dependency).
        data = await request.body()
        r = save_mod_bytes(name, data)
        if r.get("ok") and restart:
            try:
                restart_service()
                r["restarted"] = True
            except subprocess.CalledProcessError:
                r["restarted"] = False
        return JSONResponse(status_code=200 if r.get("ok") else 400, content=r)

    @app.post("/api/mods/url")
    def mods_url(payload: dict, restart: bool = False, _: str = Depends(auth)):
        r = install_mod_url((payload or {}).get("url", ""), (payload or {}).get("name", ""))
        if r.get("ok") and restart:
            try:
                restart_service()
                r["restarted"] = True
            except subprocess.CalledProcessError:
                r["restarted"] = False
        return JSONResponse(status_code=200 if r.get("ok") else 400, content=r)

    @app.delete("/api/mods/{name}")
    def mods_delete(name: str, _: str = Depends(auth)):
        r = delete_mod(name)
        return JSONResponse(status_code=200 if r.get("ok") else 400, content=r)

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
