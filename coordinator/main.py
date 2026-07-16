"""
Palworld coordinator — Cloud Function (gen2, HTTP).

Always-on control plane:
  - serves the admin panel UI (index.html)
  - starts / stops / reports status of the Palworld VM
  - proxies config + REST-API calls to the VM's local agent (panel.py on :8080)
  - manages panel users and their permissions (stored as users.json in GCS)

Permissions (per user):
  view      see status / metrics / players
  power     start / stop the VM
  config    edit PalWorldSettings.ini
  commands  run REST commands (announce/kick/ban/save/shutdown/...)
  users     manage panel users

The VM's idle watchdog calls POST /api/vm/stop with the internal token to
power the machine down after the server has been empty past the grace window.

Env vars (set by Terraform):
  PROJECT_ID, VM_ZONE, VM_INSTANCE   target instance
  VM_IP, VM_PORT                     VM static IP + local agent port (8080)
  PANEL_BUCKET                       GCS bucket holding users.json
  PANEL_USER, PANEL_PASSWORD         seed super-admin (created if no users.json)
  INTERNAL_TOKEN                     shared secret for the watchdog stop call
"""

import hashlib
import json
import os
import time

import functions_framework
import requests
from google.cloud import compute_v1, storage

PROJECT_ID = os.environ["PROJECT_ID"]
VM_ZONE = os.environ["VM_ZONE"]
VM_INSTANCE = os.environ["VM_INSTANCE"]
VM_IP = os.environ.get("VM_IP", "")
VM_PORT = os.environ.get("VM_PORT", "8080")
PANEL_BUCKET = os.environ.get("PANEL_BUCKET", "")
PANEL_USER = os.environ.get("PANEL_USER", "admin")
PANEL_PASSWORD = os.environ.get("PANEL_PASSWORD", "")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")

INDEX_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
VM_BASE = f"http://{VM_IP}:{VM_PORT}"
USERS_OBJECT = "users.json"
PERMS = ["view", "power", "config", "commands", "users"]

_inst = compute_v1.InstancesClient()
_gcs = storage.Client()
_cache = {"data": None, "ts": 0.0}
_CACHE_TTL = 10.0


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _json(obj, status=200):
    return (json.dumps(obj), status, {"Content-Type": "application/json"})


def _hash_pw(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 100_000).hex()


def _new_user(password, perms):
    salt = os.urandom(16).hex()
    return {"salt": salt, "hash": _hash_pw(password, salt), "perms": perms}


def _blob():
    return _gcs.bucket(PANEL_BUCKET).blob(USERS_OBJECT)


def _load_users(force=False):
    now = time.time()
    if not force and _cache["data"] is not None and now - _cache["ts"] < _CACHE_TTL:
        return _cache["data"]
    blob = _blob()
    if blob.exists():
        data = json.loads(blob.download_as_text())
    else:
        # seed super-admin from env creds
        data = {"users": {PANEL_USER: _new_user(PANEL_PASSWORD, list(PERMS))}}
        blob.upload_from_string(json.dumps(data, indent=2), content_type="application/json")
    _cache["data"] = data
    _cache["ts"] = now
    return data


def _save_users(data):
    _blob().upload_from_string(json.dumps(data, indent=2), content_type="application/json")
    _cache["data"] = data
    _cache["ts"] = time.time()


def _authenticate(request):
    a = request.authorization
    if not a or not a.username:
        return None
    rec = _load_users().get("users", {}).get(a.username)
    if not rec:
        return None
    if _hash_pw(a.password or "", rec["salt"]) != rec["hash"]:
        return None
    return {"name": a.username, "perms": rec.get("perms", [])}


def _vm_status():
    return _inst.get(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE).status


def _proxy(request, path, method):
    try:
        st = _vm_status()
    except Exception as e:  # noqa: BLE001
        return _json({"error": f"status check failed: {e}"}, 502)
    if st != "RUNNING":
        return _json({"error": "vm_offline", "status": st}, 503)
    qs = request.query_string.decode() if request.query_string else ""
    url = VM_BASE + path + (("?" + qs) if qs else "")
    try:
        r = requests.request(
            method,
            url,
            auth=(PANEL_USER, PANEL_PASSWORD),
            data=request.get_data() if method == "POST" else None,
            headers={"Content-Type": request.headers.get("Content-Type", "application/json")}
            if method == "POST"
            else {},
            timeout=30,
        )
        return (r.content, r.status_code, {"Content-Type": r.headers.get("Content-Type", "application/json")})
    except requests.RequestException as e:
        return _json({"error": f"vm unreachable: {e}"}, 502)


# ---------------------------------------------------------------------------
# user management
# ---------------------------------------------------------------------------


def _users_public(data):
    return [{"username": u, "perms": r.get("perms", [])} for u, r in data.get("users", {}).items()]


def _handle_users(request, method, path):
    data = _load_users(force=True)
    users = data.setdefault("users", {})

    if method == "GET":
        return _json({"users": _users_public(data), "all_perms": PERMS})

    if method == "POST":
        body = request.get_json(silent=True) or {}
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        perms = [p for p in (body.get("perms") or []) if p in PERMS]
        if not username:
            return _json({"error": "username required"}, 400)
        if username in users:
            users[username]["perms"] = perms
            if password:
                users[username] = {**users[username], **_new_user(password, perms)}
        else:
            if not password:
                return _json({"error": "password required for new user"}, 400)
            users[username] = _new_user(password, perms)
        # never leave the system without a user manager
        if not any("users" in r.get("perms", []) for r in users.values()):
            return _json({"error": "at least one user must keep the 'users' permission"}, 400)
        _save_users(data)
        return _json({"ok": True, "users": _users_public(data)})

    if method == "DELETE":
        username = path.split("/api/users/", 1)[1] if "/api/users/" in path else ""
        if username not in users:
            return _json({"error": "not found"}, 404)
        remaining = {u: r for u, r in users.items() if u != username}
        if not any("users" in r.get("perms", []) for r in remaining.values()):
            return _json({"error": "cannot delete the last user manager"}, 400)
        del users[username]
        _save_users(data)
        return _json({"ok": True, "users": _users_public(data)})

    return _json({"error": "method not allowed"}, 405)


# ---------------------------------------------------------------------------
# entrypoint
# ---------------------------------------------------------------------------


@functions_framework.http
def coordinator(request):
    path = request.path or "/"
    method = request.method

    # public: panel UI
    if path == "/" and method == "GET":
        with open(INDEX_PATH, encoding="utf-8") as f:
            return (f.read(), 200, {"Content-Type": "text/html; charset=utf-8"})

    # watchdog stop (token auth, no basic)
    if (
        path == "/api/vm/stop"
        and method == "POST"
        and INTERNAL_TOKEN
        and request.headers.get("X-Internal-Token") == INTERNAL_TOKEN
    ):
        _inst.stop(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE)
        return _json({"stopping": True, "by": "watchdog"})

    # everything below needs a valid user
    user = _authenticate(request)
    if not user:
        return ("Unauthorized", 401, {"WWW-Authenticate": "Basic"})
    perms = user["perms"]

    def need(p):
        return p in perms

    if path == "/api/session":
        return _json({"ok": True, "user": user["name"], "perms": perms})

    # --- user management ---
    if path == "/api/users" or path.startswith("/api/users/"):
        if not need("users"):
            return _json({"error": "forbidden"}, 403)
        return _handle_users(request, method, path)

    # --- VM power / status ---
    if path == "/api/vm/status":
        if not need("view"):
            return _json({"error": "forbidden"}, 403)
        try:
            return _json({"status": _vm_status(), "ip": VM_IP})
        except Exception as e:  # noqa: BLE001
            return _json({"status": "UNKNOWN", "error": str(e)}, 500)

    if path == "/api/vm/start" and method == "POST":
        if not need("power"):
            return _json({"error": "forbidden"}, 403)
        _inst.start(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE)
        return _json({"starting": True})

    if path == "/api/vm/stop" and method == "POST":
        if not need("power"):
            return _json({"error": "forbidden"}, 403)
        _inst.stop(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE)
        return _json({"stopping": True})

    # --- proxy to VM agent (config / REST / restart) ---
    if path.startswith("/api/config"):
        if method == "GET" and not need("view"):
            return _json({"error": "forbidden"}, 403)
        if method == "POST" and not need("config"):
            return _json({"error": "forbidden"}, 403)
        return _proxy(request, path, method)

    if path.startswith("/api/rest/"):
        if method == "GET" and not need("view"):
            return _json({"error": "forbidden"}, 403)
        if method == "POST" and not need("commands"):
            return _json({"error": "forbidden"}, 403)
        return _proxy(request, path, method)

    if path == "/api/restart" and method == "POST":
        if not need("config"):
            return _json({"error": "forbidden"}, 403)
        return _proxy(request, path, method)

    return _json({"error": "not found", "path": path}, 404)
