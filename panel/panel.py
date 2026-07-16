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
import secrets
import subprocess
import sys
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

OPTION_HEADER = "[/Script/Pal.PalGameWorldSettings]"

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
    from fastapi import Depends, FastAPI, HTTPException, status
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
