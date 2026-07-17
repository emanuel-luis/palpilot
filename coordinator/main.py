"""
Palworld coordinator — Cloud Function (gen2, HTTP).

Always-on control plane:
  - serves the admin panel UI (index.html)
  - starts / stops / reports status of the Palworld VM
  - proxies config + REST-API calls to the VM's local agent (panel.py on :8080)
  - manages panel users and their permissions (users.json in GCS)
  - manages the idle-watchdog timeout at runtime (watchdog.json in GCS)

Permissions (per user):
  view      see status / metrics / players
  power     start / stop the VM
  config    edit PalWorldSettings.ini and the watchdog timeout
  commands  run REST commands (announce/kick/ban/save/shutdown/...)
  users     manage panel users

Routing:
  Routes are declared in ROUTES as (method_spec, path_matcher, required_perm, handler)
  tuples so every route's permission gate lives right next to its path/method. A
  method_spec of "NOT_GET" matches any method except GET (used for saves/mods writes,
  which accept POST/DELETE/etc. all gated by the same "config" permission). A
  required_perm of None means "authenticated user, no extra permission needed".

Error envelope:
  Every coordinator-owned JSON response (not the raw Palworld-REST passthrough bodies
  from _proxy) is shaped { "ok": bool, "error": str|null, ...data }. Use _ok()/_err().

RBAC propagation (H1):
  When proxying to the panel agent, the coordinator adds a signed
  X-Coord-User/X-Coord-Perms/X-Coord-Ts/X-Coord-Sig header set (HMAC-SHA256 over
  "<user>\\n<perms>\\n<ts>" keyed by INTERNAL_TOKEN) so the panel can enforce the same
  permission model instead of trusting any holder of the shared Basic-Auth credential.
  Basic Auth is still sent too, so the panel can fall back to it (break-glass) if the
  signed header is absent or stale.

Env vars (set by Terraform):
  PROJECT_ID, VM_ZONE, VM_INSTANCE   target instance
  VM_IP, VM_PORT                     VM static IP + local agent port (8080)
  PANEL_BUCKET                       GCS bucket holding users.json / watchdog.json
  PANEL_USER, PANEL_PASSWORD         seed super-admin + agent proxy creds
  INTERNAL_TOKEN                     shared secret for the watchdog endpoints + RBAC signing
  IDLE_POLL_DEFAULT, IDLE_GRACE_DEFAULT  seed watchdog timeout
"""

import hashlib
import hmac
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
IDLE_POLL_DEFAULT = int(os.environ.get("IDLE_POLL_DEFAULT", "60"))
IDLE_GRACE_DEFAULT = int(os.environ.get("IDLE_GRACE_DEFAULT", "1800"))

INDEX_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
VM_BASE = f"http://{VM_IP}:{VM_PORT}"
USERS_OBJECT = "users.json"
WD_OBJECT = "watchdog.json"
PERMS = ["view", "power", "config", "commands", "users"]

# PBKDF2 iteration counts: new/rotated passwords use the current (OWASP-ish) count;
# records created before this change carry no "iterations" field and are treated as
# the legacy count until the user's next successful login re-hashes them.
PBKDF2_ITERATIONS = 600_000
PBKDF2_ITERATIONS_LEGACY = 100_000

# In-memory per-IP failed-login throttle. Best-effort only (resets per instance /
# cold start on this serverless runtime), but cheap and closes casual brute-forcing.
_THROTTLE_MAX_FAILURES = 5
_THROTTLE_WINDOW_SECONDS = 60.0
_failed_logins = {}  # ip -> [timestamps of recent failures]

_inst = compute_v1.InstancesClient()
_gcs = storage.Client()
_cache = {}  # object name -> {"data":..., "ts":...}
_CACHE_TTL = 10.0


# ---------------------------------------------------------------------------
# GCS-backed JSON documents (users, watchdog)
# ---------------------------------------------------------------------------


def _blob(name):
    return _gcs.bucket(PANEL_BUCKET).blob(name)


def _load(name, seed):
    c = _cache.get(name)
    now = time.time()
    if c and now - c["ts"] < _CACHE_TTL:
        return c["data"]
    blob = _blob(name)
    if blob.exists():
        data = json.loads(blob.download_as_text())
    else:
        data = seed()
        blob.upload_from_string(json.dumps(data, indent=2), content_type="application/json")
    _cache[name] = {"data": data, "ts": now}
    return data


def _store(name, data):
    _blob(name).upload_from_string(json.dumps(data, indent=2), content_type="application/json")
    _cache[name] = {"data": data, "ts": time.time()}


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------


def _hash_pw(password, salt, iterations):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), iterations).hex()


def _new_user(password, perms, iterations=PBKDF2_ITERATIONS):
    salt = os.urandom(16).hex()
    return {
        "salt": salt,
        "hash": _hash_pw(password, salt, iterations),
        "perms": perms,
        "iterations": iterations,
    }


def _load_users():
    return _load(USERS_OBJECT, lambda: {"users": {PANEL_USER: _new_user(PANEL_PASSWORD, list(PERMS))}})


def _users_public(data):
    return [{"username": u, "perms": r.get("perms", [])} for u, r in data.get("users", {}).items()]


def _client_ip(request):
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _login_throttled(ip):
    now = time.time()
    hits = [t for t in _failed_logins.get(ip, []) if now - t < _THROTTLE_WINDOW_SECONDS]
    _failed_logins[ip] = hits
    return len(hits) >= _THROTTLE_MAX_FAILURES


def _note_failed_login(ip):
    _failed_logins.setdefault(ip, []).append(time.time())


def _clear_failed_login(ip):
    _failed_logins.pop(ip, None)


def _rehash_user(username, password):
    """Re-hash a user's password at the current PBKDF2 iteration count.

    Called after a successful login against a record stored with the legacy
    (lower) iteration count, so credentials migrate forward without a forced
    password reset.
    """
    try:
        data = json.loads(json.dumps(_load_users()))
        rec = data.get("users", {}).get(username)
        if not rec:
            return
        rec.update(_new_user(password, rec.get("perms", [])))
        _store(USERS_OBJECT, data)
    except Exception as e:  # noqa: BLE001
        print(f"password re-hash failed for user {username!r}: {e}")


def _authenticate(request):
    a = request.authorization
    if not a or not a.username:
        return None
    ip = _client_ip(request)
    if _login_throttled(ip):
        print(f"login throttled for ip={ip}")
        return None
    rec = _load_users().get("users", {}).get(a.username)
    if rec:
        iterations = rec.get("iterations", PBKDF2_ITERATIONS_LEGACY)
        computed = _hash_pw(a.password or "", rec["salt"], iterations)
        valid = hmac.compare_digest(computed, rec["hash"])
    else:
        valid = False
    if not valid:
        _note_failed_login(ip)
        return None
    _clear_failed_login(ip)
    if rec.get("iterations", PBKDF2_ITERATIONS_LEGACY) < PBKDF2_ITERATIONS:
        _rehash_user(a.username, a.password)
    return {"name": a.username, "perms": rec.get("perms", [])}


# ---------------------------------------------------------------------------
# watchdog config
# ---------------------------------------------------------------------------


def _load_wd():
    return _load(
        WD_OBJECT,
        lambda: {"poll_seconds": IDLE_POLL_DEFAULT, "grace_seconds": IDLE_GRACE_DEFAULT},
    )


# ---------------------------------------------------------------------------
# compute + proxy
# ---------------------------------------------------------------------------


def _json(obj, status=200):
    return (json.dumps(obj), status, {"Content-Type": "application/json"})


def _ok(data=None, status=200):
    body = {"ok": True, "error": None}
    if data:
        body.update(data)
    return _json(body, status)


def _err(message, status=400, **extra):
    body = {"ok": False, "error": message}
    body.update(extra)
    return _json(body, status)


def _vm_status():
    return _inst.get(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE).status


def _vm_start():
    try:
        _inst.start(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"vm start failed: {e}")
        return False


def _vm_stop():
    try:
        _inst.stop(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"vm stop failed: {e}")
        return False


def _rbac_headers(user):
    """Signed RBAC-propagation headers for a proxied call (H1). Empty if there's no
    acting user (shouldn't happen post-auth) or no shared token to sign with."""
    if not user or not INTERNAL_TOKEN:
        return {}
    ts = str(int(time.time()))
    perms_str = ",".join(user.get("perms", []))
    msg = f"{user.get('name', '')}\n{perms_str}\n{ts}"
    sig = hmac.new(INTERNAL_TOKEN.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return {
        "X-Coord-User": user.get("name", ""),
        "X-Coord-Perms": perms_str,
        "X-Coord-Ts": ts,
        "X-Coord-Sig": sig,
    }


def _vm_get_json(path, user=None):
    try:
        r = requests.get(
            VM_BASE + path,
            auth=(PANEL_USER, PANEL_PASSWORD),
            headers=_rbac_headers(user),
            timeout=15,
        )
        return r.json() if r.ok else None
    except (requests.RequestException, ValueError):
        return None


def _proxy(request, path, method, user, timeout=30):
    try:
        st = _vm_status()
    except Exception as e:  # noqa: BLE001
        print(f"vm status check failed (proxy {path}): {e}")
        return _err("status check failed", 502)
    if st != "RUNNING":
        return _json({"ok": False, "error": "vm_offline", "status": st}, 503)
    qs = request.query_string.decode() if request.query_string else ""
    url = VM_BASE + path + (("?" + qs) if qs else "")
    headers = _rbac_headers(user)
    if method == "POST":
        headers["Content-Type"] = request.headers.get("Content-Type", "application/json")
    try:
        r = requests.request(
            method,
            url,
            auth=(PANEL_USER, PANEL_PASSWORD),
            data=request.get_data() if method == "POST" else None,
            headers=headers,
            timeout=timeout,
        )
        return (r.content, r.status_code, {"Content-Type": r.headers.get("Content-Type", "application/json")})
    except requests.RequestException as e:
        print(f"vm unreachable (proxy {path}): {e}")
        return _err("vm unreachable", 502)


# ---------------------------------------------------------------------------
# route handlers (user-authenticated)
# ---------------------------------------------------------------------------


def _h_session(request, user, path, method):
    return _ok({"user": user["name"], "perms": user["perms"]})


def _h_overview(request, user, path, method):
    try:
        st = _vm_status()
    except Exception as e:  # noqa: BLE001
        print(f"vm status check failed (overview): {e}")
        return _json({"ok": False, "error": "status check failed", "vm": {"status": "UNKNOWN", "ip": VM_IP}})
    server = None
    if st == "RUNNING":
        server = {
            "info": _vm_get_json("/api/rest/info", user),
            "metrics": _vm_get_json("/api/rest/metrics", user),
            "players": (_vm_get_json("/api/rest/players", user) or {}).get("players", []),
        }
    return _ok({"vm": {"status": st, "ip": VM_IP}, "server": server})


def _h_watchdog_get(request, user, path, method):
    return _ok(_load_wd())


def _h_watchdog_post(request, user, path, method):
    body = request.get_json(silent=True) or {}
    try:
        poll = int(body.get("poll_seconds"))
        grace = int(body.get("grace_seconds"))
    except (TypeError, ValueError):
        return _err("poll_seconds and grace_seconds must be integers", 400)
    if not (10 <= poll <= 3600):
        return _err("poll_seconds must be 10..3600", 400)
    if not (60 <= grace <= 86400):
        return _err("grace_seconds must be 60..86400", 400)
    cfg = {"poll_seconds": poll, "grace_seconds": grace}
    _store(WD_OBJECT, cfg)
    return _ok(cfg)


def _h_users(request, user, path, method):
    return _handle_users(request, method, path)


def _h_vm_status(request, user, path, method):
    try:
        return _ok({"status": _vm_status(), "ip": VM_IP})
    except Exception as e:  # noqa: BLE001
        print(f"vm status check failed (vm/status): {e}")
        return _json({"ok": False, "error": "status check failed", "status": "UNKNOWN"}, 500)


def _h_vm_start(request, user, path, method):
    if not _vm_start():
        return _err("failed to start VM", 502)
    return _ok({"starting": True})


def _h_vm_stop(request, user, path, method):
    if not _vm_stop():
        return _err("failed to stop VM", 502)
    return _ok({"stopping": True})


def _h_proxy(request, user, path, method):
    return _proxy(request, path, method, user)


def _h_proxy_long(request, user, path, method):
    # switching/backing-up a world tars + uploads: allow more time.
    return _proxy(request, path, method, user, timeout=280)


# ---------------------------------------------------------------------------
# route table (L1) — (method_spec, path_matcher, required_perm, handler)
#   method_spec: "GET" / "POST" / ... , "NOT_GET" (any method but GET), or None (any)
#   required_perm: one of PERMS, or None if authentication alone is sufficient
# ---------------------------------------------------------------------------


def _exact(p):
    return lambda path: path == p


def _prefix(p):
    return lambda path: path.startswith(p)


def _users_path(path):
    return path == "/api/users" or path.startswith("/api/users/")


ROUTES = [
    ("GET", _exact("/api/session"), None, _h_session),
    ("GET", _exact("/api/overview"), "view", _h_overview),
    ("GET", _exact("/api/watchdog"), "view", _h_watchdog_get),
    ("POST", _exact("/api/watchdog"), "config", _h_watchdog_post),
    (None, _users_path, "users", _h_users),
    ("GET", _exact("/api/vm/status"), "view", _h_vm_status),
    ("POST", _exact("/api/vm/start"), "power", _h_vm_start),
    ("POST", _exact("/api/vm/stop"), "power", _h_vm_stop),
    # config (PalWorldSettings.ini) proxy
    ("GET", _prefix("/api/config"), "view", _h_proxy),
    ("POST", _prefix("/api/config"), "config", _h_proxy),
    # Palworld REST passthrough
    ("GET", _prefix("/api/rest/"), "view", _h_proxy),
    ("POST", _prefix("/api/rest/"), "commands", _h_proxy),
    # save slots + mods (file manipulation on the VM; covers list/create/activate/
    # backup/backups/restore/delete and list/upload/url/enable/disable/delete)
    ("GET", _prefix("/api/saves"), "view", _h_proxy_long),
    ("NOT_GET", _prefix("/api/saves"), "config", _h_proxy_long),
    ("GET", _prefix("/api/mods"), "view", _h_proxy_long),
    ("NOT_GET", _prefix("/api/mods"), "config", _h_proxy_long),
    ("POST", _exact("/api/restart"), "config", _h_proxy),
]


def _method_matches(spec, method):
    if spec is None:
        return True
    if spec == "NOT_GET":
        return method != "GET"
    return method == spec


# ---------------------------------------------------------------------------
# entrypoint
# ---------------------------------------------------------------------------


@functions_framework.http
def coordinator(request):
    path = request.path or "/"
    method = request.method

    if path == "/" and method == "GET":
        with open(INDEX_PATH, encoding="utf-8") as f:
            return (f.read(), 200, {"Content-Type": "text/html; charset=utf-8"})

    # --- token-authed endpoints for the VM watchdog (no user login) ---
    tok = request.headers.get("X-Internal-Token") or ""
    if INTERNAL_TOKEN and hmac.compare_digest(tok, INTERNAL_TOKEN):
        if path == "/api/vm/stop" and method == "POST":
            if not _vm_stop():
                return _err("failed to stop VM", 502)
            return _ok({"stopping": True, "by": "watchdog"})
        if path == "/api/watchdog-config" and method == "GET":
            return _ok(_load_wd())

    # --- user-authenticated below ---
    user = _authenticate(request)
    if not user:
        return ("Unauthorized", 401, {"WWW-Authenticate": "Basic"})
    perms = user["perms"]

    for method_spec, matcher, required_perm, handler in ROUTES:
        if not matcher(path):
            continue
        if not _method_matches(method_spec, method):
            continue
        if required_perm and required_perm not in perms:
            return _err("forbidden", 403)
        return handler(request, user, path, method)

    return _err("not found", 404, path=path)


def _handle_users(request, method, path):
    data = _load_users()
    # force a fresh copy so cache TTL doesn't hide concurrent edits
    data = json.loads(json.dumps(data))
    users = data.setdefault("users", {})

    if method == "GET":
        return _ok({"users": _users_public(data), "all_perms": PERMS})

    if method == "POST":
        body = request.get_json(silent=True) or {}
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        perms = [p for p in (body.get("perms") or []) if p in PERMS]
        if not username:
            return _err("username required", 400)
        if username in users:
            users[username]["perms"] = perms
            if password:
                users[username] = {**users[username], **_new_user(password, perms)}
        else:
            if not password:
                return _err("password required for new user", 400)
            users[username] = _new_user(password, perms)
        if not any("users" in r.get("perms", []) for r in users.values()):
            return _err("at least one user must keep the 'users' permission", 400)
        _store(USERS_OBJECT, data)
        return _ok({"users": _users_public(data)})

    if method == "DELETE":
        username = path.split("/api/users/", 1)[1] if "/api/users/" in path else ""
        if username not in users:
            return _err("not found", 404)
        remaining = {u: r for u, r in users.items() if u != username}
        if not any("users" in r.get("perms", []) for r in remaining.values()):
            return _err("cannot delete the last user manager", 400)
        del users[username]
        _store(USERS_OBJECT, data)
        return _ok({"users": _users_public(data)})

    return _err("method not allowed", 405)
