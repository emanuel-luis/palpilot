"""
Palworld coordinator — Cloud Function (gen2, HTTP).

Always-on control plane:
  - serves the admin panel UI (index.html)
  - starts / stops / reports status of the Palworld VM
  - proxies config + REST-API calls to the VM's local agent (panel.py on :8080)
  - manages panel users and their permissions (users.json in GCS)
  - manages the idle-watchdog timeout at runtime (watchdog.json in GCS)

Permissions (per user), granular (v3):
  view      see status / overview / players / metrics
  power     start / stop the VM
  saves     manage save slots (create/activate/clone/rename/delete/backup/restore)
  mods      manage mods
  settings  edit PalWorldSettings.ini (+ /api/restart)
  watchdog  edit the idle-watchdog timeout
  commands  run REST commands (announce/kick/ban/save/shutdown/...)
  users     manage panel users AND roles

  Legacy records/roles holding the old coarse "config" permission expand to
  {saves, mods, settings, watchdog} at read time via _expand_perms() -- never
  breaks an existing admin. Users may also hold a "role" (see roles.json):
  when set (and not "custom"), the role's perms are the effective set;
  _effective_perms() resolves role-vs-per-user-perms in one place.

Auth (session tokens):
  POST /api/login {username,password} verifies against the existing PBKDF2 users.json
  record (and the existing per-IP throttle) and, on success, issues a compact
  hand-rolled session token (no JWT dependency):
    base64url(header).base64url(payload).hex(HMAC-SHA256("header.payload", INTERNAL_TOKEN))
  payload = {u, perms, iat, exp, ver}; exp = iat + 12h. Every protected route accepts
  `Authorization: Bearer <token>` (verified for signature + expiry + that payload.ver
  still matches the user's current users.json "ver") OR HTTP Basic (kept for /api/login
  callers that prefer Basic, and as break-glass). users.json records carry a "ver" int
  (default 0 for legacy records); POST /api/logout-all bumps the caller's ver to
  invalidate all outstanding tokens, and POST /api/account/password {old,new} re-hashes
  at the current PBKDF2 count and also bumps ver. POST /api/logout is a client-side no-op
  (200 OK) since tokens are stateless and just get dropped by the browser.

Routing:
  Routes are declared in ROUTES as (method_spec, path_matcher, required_perm, handler)
  tuples so every route's permission gate lives right next to its path/method. A
  method_spec of "NOT_GET" matches any method except GET (used for saves/mods writes,
  which accept POST/DELETE/etc., gated by the "saves"/"mods" permission respectively).
  A required_perm of None means "authenticated user, no extra permission needed".

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
  PANEL_BUCKET                       GCS bucket holding users.json / roles.json / watchdog.json
  PANEL_USER, PANEL_PASSWORD         seed super-admin + agent proxy creds
  INTERNAL_TOKEN                     shared secret for the watchdog endpoints + RBAC signing
  IDLE_POLL_DEFAULT, IDLE_GRACE_DEFAULT  seed watchdog timeout
  GAME_PORT                          UDP port players connect to (status/join address)
  DISCORD_PUBLIC_KEY, DISCORD_GUILD_ID, DISCORD_ADMIN_ROLE_IDS,
  DISCORD_USER_ROLE_IDS              Discord bot (see discord_bot.py; empty key = off)

Discord bot:
  POST /api/discord/interactions is Discord's Interactions Endpoint URL. It is
  handled before the auth gate (Discord can't send our session token) and is
  instead verified by Ed25519 signature in discord_bot.verify(). Commands map
  the caller's Discord roles to a pseudo-user whose perms then flow through the
  normal _rbac_headers() path, so the agent applies the same RBAC as a console
  user. discord_bot.py owns the protocol; _DiscordOps below owns the actions.
"""

import base64
import hashlib
import hmac
import json
import os
import time

import functions_framework
import requests
from google.cloud import compute_v1, storage

import discord_bot

PROJECT_ID = os.environ["PROJECT_ID"]
VM_ZONE = os.environ["VM_ZONE"]
VM_INSTANCE = os.environ["VM_INSTANCE"]
VM_IP = os.environ.get("VM_IP", "")
VM_PORT = os.environ.get("VM_PORT", "8080")
GAME_PORT = os.environ.get("GAME_PORT", "8211")  # UDP port players connect to (main.tf firewall)
PANEL_BUCKET = os.environ.get("PANEL_BUCKET", "")
PANEL_USER = os.environ.get("PANEL_USER", "admin")
PANEL_PASSWORD = os.environ.get("PANEL_PASSWORD", "")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")
IDLE_POLL_DEFAULT = int(os.environ.get("IDLE_POLL_DEFAULT", "60"))
IDLE_GRACE_DEFAULT = int(os.environ.get("IDLE_GRACE_DEFAULT", "1800"))

INDEX_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
VM_BASE = f"http://{VM_IP}:{VM_PORT}"
USERS_OBJECT = "users.json"
ROLES_OBJECT = "roles.json"
WD_OBJECT = "watchdog.json"
PERMS = ["view", "power", "saves", "mods", "settings", "watchdog", "commands", "users"]

# Preset permission bundles, seeded into roles.json on first load. Perms are
# editable afterwards (even for builtins) but a builtin's identity/deletion
# is protected -- see _handle_roles().
BUILTIN_ROLES = {
    "owner": {"perms": list(PERMS), "builtin": True},
    "operator": {
        "perms": ["view", "power", "saves", "mods", "settings", "watchdog", "commands"],
        "builtin": True,
    },
    "moderator": {"perms": ["view", "commands"], "builtin": True},
    "viewer": {"perms": ["view"], "builtin": True},
}

# PBKDF2 iteration counts: new/rotated passwords use the current (OWASP-ish) count;
# records created before this change carry no "iterations" field and are treated as
# the legacy count until the user's next successful login re-hashes them.
PBKDF2_ITERATIONS = 600_000
PBKDF2_ITERATIONS_LEGACY = 100_000

# Session tokens: compact hand-rolled JWT-alike, signed with INTERNAL_TOKEN. No jwt dep.
TOKEN_TTL_SECONDS = 12 * 3600

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


def _store(name, data, if_generation_match=None):
    blob = _blob(name)
    kwargs = {} if if_generation_match is None else {"if_generation_match": if_generation_match}
    blob.upload_from_string(json.dumps(data, indent=2), content_type="application/json", **kwargs)
    _cache[name] = {"data": data, "ts": time.time()}


def _load_versioned(name, seed):
    """Read a GCS-JSON doc plus its current generation, bypassing the read cache
    (for read-modify-write). Returns (data, generation)."""
    blob = _blob(name)
    if blob.exists():
        data = json.loads(blob.download_as_text())
    else:
        data = seed()
        blob.upload_from_string(json.dumps(data, indent=2), content_type="application/json")
    blob.reload()  # ensure blob.generation reflects the just-read object
    _cache[name] = {"data": data, "ts": time.time()}
    return data, blob.generation


def _update(name, seed, mutate, attempts=6):
    """Optimistic-concurrency read-modify-write on a GCS-JSON doc.

    `mutate(data)` edits `data` in place and returns (commit: bool, result). On
    commit, the write asserts the generation that was read; a concurrent writer
    (generation mismatch) triggers a reload + re-run of `mutate`, so no edit is
    silently lost. `commit=False` skips the write (validation failures) and
    returns `result` immediately."""
    from google.api_core.exceptions import PreconditionFailed

    for _ in range(attempts):
        data, gen = _load_versioned(name, seed)
        data = json.loads(json.dumps(data))  # deep copy to mutate
        commit, result = mutate(data)
        if not commit:
            return result
        try:
            _store(name, data, if_generation_match=gen)
            return result
        except PreconditionFailed:
            continue
    return _err("conflict: concurrent update, please retry", 409)


# Seed factories, shared by _load_* (cached reads) and _update (versioned writes).
def _seed_users():
    return {"users": {PANEL_USER: _new_user(PANEL_PASSWORD, list(PERMS), role="owner")}}


def _seed_roles():
    return {"roles": {k: dict(v) for k, v in BUILTIN_ROLES.items()}}


def _seed_wd():
    return {"poll_seconds": IDLE_POLL_DEFAULT, "grace_seconds": IDLE_GRACE_DEFAULT}


# ---------------------------------------------------------------------------
# permissions — legacy expansion + role resolution
# ---------------------------------------------------------------------------


def _expand_perms(perms):
    """Expand the legacy coarse "config" permission into the granular set it
    replaced ({saves, mods, settings, watchdog}), preserving order and
    deduping. Idempotent -- safe to call more than once on the same list, and
    a no-op for a list that never held "config"."""
    expanded = []
    for p in perms or []:
        if p == "config":
            for q in ("saves", "mods", "settings", "watchdog"):
                if q not in expanded:
                    expanded.append(q)
        elif p not in expanded:
            expanded.append(p)
    return expanded


def _load_roles():
    return _load(ROLES_OBJECT, _seed_roles)


def _effective_perms(rec):
    """Resolve a user record's effective permissions (v3 roles).

    If the record holds a "role" other than "custom" (and that role still
    exists in roles.json), the role's perms are authoritative -- any
    per-user "perms" override is ignored. Otherwise (role == "custom", role
    unset/legacy, or a role that's since been deleted) the per-user "perms"
    list is used directly. Either way, the legacy "config" perm is expanded.
    """
    role = rec.get("role")
    if role and role != "custom":
        role_rec = _load_roles().get("roles", {}).get(role)
        if role_rec:
            return _expand_perms(role_rec.get("perms", []))
    return _expand_perms(rec.get("perms", []))


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------


def _hash_pw(password, salt, iterations):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), iterations).hex()


def _new_user(password, perms, iterations=PBKDF2_ITERATIONS, role="custom"):
    salt = os.urandom(16).hex()
    return {
        "salt": salt,
        "hash": _hash_pw(password, salt, iterations),
        "perms": perms,
        "role": role,
        "iterations": iterations,
        "ver": 0,
    }


def _load_users():
    return _load(
        USERS_OBJECT,
        _seed_users,
    )


def _users_public(data):
    return [
        {
            "username": u,
            "role": r.get("role", "custom"),
            "perms": r.get("perms", []),
            "effective_perms": _effective_perms(r),
        }
        for u, r in data.get("users", {}).items()
    ]


def _client_ip(request):
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        # GCP's front end APPENDS the real client IP as the LAST entry; earlier
        # entries are attacker-supplied. Taking [0] would let a client bypass the
        # login throttle by rotating a fake first hop, so use the last hop.
        return fwd.split(",")[-1].strip()
    return request.remote_addr or "unknown"


def _login_throttled(ip):
    now = time.time()
    hits = [t for t in _failed_logins.get(ip, []) if now - t < _THROTTLE_WINDOW_SECONDS]
    _failed_logins[ip] = hits
    return len(hits) >= _THROTTLE_MAX_FAILURES


def _throttle_retry_after(ip):
    now = time.time()
    hits = [t for t in _failed_logins.get(ip, []) if now - t < _THROTTLE_WINDOW_SECONDS]
    if not hits:
        return 0
    return max(1, int(_THROTTLE_WINDOW_SECONDS - (now - min(hits))) + 1)


def _note_failed_login(ip):
    _failed_logins.setdefault(ip, []).append(time.time())


def _clear_failed_login(ip):
    _failed_logins.pop(ip, None)


def _rehash_user(username, password):
    """Re-hash a user's password at the current PBKDF2 iteration count.

    Called after a successful login against a record stored with the legacy
    (lower) iteration count, so credentials migrate forward without a forced
    password reset. This is a transparent migration, not a security event, so
    it must NOT bump "ver" (that would silently invalidate live sessions).
    """
    def mutate(data):
        rec = data.get("users", {}).get(username)
        if not rec:
            return False, None
        new_fields = _new_user(password, rec.get("perms", []), role=rec.get("role", "custom"))
        new_fields["ver"] = rec.get("ver", 0)
        rec.update(new_fields)
        return True, None

    try:
        _update(USERS_OBJECT, _seed_users, mutate)
    except Exception as e:  # noqa: BLE001
        print(f"password re-hash failed for user {username!r}: {e}")


def _check_password(username, password):
    """Verify a username/password pair against users.json.

    Returns the user record on success (None on failure). Side effect: migrates
    a legacy (lower-iteration) record forward on a successful check. No throttle
    bookkeeping here — callers own that (throttle policy differs slightly between
    /api/login and Basic-Auth call sites, but both wrap this).
    """
    if not username:
        return None
    rec = _load_users().get("users", {}).get(username)
    if not rec:
        # Spend ~the same time as a real check so a missing username can't be
        # distinguished from a wrong password by timing (username enumeration).
        _hash_pw(password or "", "00" * 16, PBKDF2_ITERATIONS)
        return None
    iterations = rec.get("iterations", PBKDF2_ITERATIONS_LEGACY)
    computed = _hash_pw(password or "", rec["salt"], iterations)
    if not hmac.compare_digest(computed, rec["hash"]):
        return None
    if iterations < PBKDF2_ITERATIONS:
        _rehash_user(username, password)
    return rec


def _authenticate_basic(request):
    a = request.authorization
    if not a or not a.username:
        return None
    ip = _client_ip(request)
    if _login_throttled(ip):
        print(f"login throttled for ip={ip}")
        return None
    rec = _check_password(a.username, a.password or "")
    if not rec:
        _note_failed_login(ip)
        return None
    _clear_failed_login(ip)
    return {"name": a.username, "perms": _effective_perms(rec)}


# ---------------------------------------------------------------------------
# session tokens (hand-rolled compact JWT-alike; no jwt dependency)
#   base64url(header) "." base64url(payload) "." hex(HMAC-SHA256(header.payload, key))
#   payload: {u, perms, iat, exp, ver}
# ---------------------------------------------------------------------------


def _b64url_encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(s):
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(signing_input):
    return hmac.new(INTERNAL_TOKEN.encode(), signing_input.encode(), hashlib.sha256).hexdigest()


def _make_token(username, perms, ver):
    now = int(time.time())
    exp = now + TOKEN_TTL_SECONDS
    header_b64 = _b64url_encode(json.dumps({"alg": "HS256", "typ": "PPT"}, separators=(",", ":")).encode())
    payload = {"u": username, "perms": perms, "iat": now, "exp": exp, "ver": ver}
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    sig = _sign(f"{header_b64}.{payload_b64}")
    return f"{header_b64}.{payload_b64}.{sig}", exp


def _verify_token(token):
    """Verify signature + expiry; return the decoded payload dict, or None."""
    # Fail closed: with no secret the HMAC key is empty and publicly known, so
    # anyone could forge a token. Never trust (or issue) tokens without a secret.
    if not INTERNAL_TOKEN or not token or token.count(".") != 2:
        return None
    header_b64, payload_b64, sig_hex = token.split(".")
    expected_sig = _sign(f"{header_b64}.{payload_b64}")
    if not hmac.compare_digest(sig_hex, expected_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if float(payload.get("exp", 0)) < time.time():
        return None
    return payload


def _authenticate_bearer(token):
    payload = _verify_token(token)
    if not payload:
        return None
    username = payload.get("u")
    rec = _load_users().get("users", {}).get(username)
    if not rec:
        return None
    if payload.get("ver", 0) != rec.get("ver", 0):
        return None  # token was issued before a logout-all / password change
    # Re-read from users.json (rather than trusting the token's embedded
    # perms) so a role change takes effect on the very next request.
    return {"name": username, "perms": _effective_perms(rec)}


def _authenticate(request):
    """Resolve the acting user: prefer a Bearer session token, fall back to Basic
    (kept for break-glass access and any client that prefers Basic directly)."""
    auth_header = request.headers.get("Authorization", "") or ""
    if auth_header.startswith("Bearer "):
        return _authenticate_bearer(auth_header[len("Bearer "):].strip())
    return _authenticate_basic(request)


# ---------------------------------------------------------------------------
# watchdog config
# ---------------------------------------------------------------------------


def _load_wd():
    return _load(WD_OBJECT, _seed_wd)


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


def _vm_get_json(path, user=None, timeout=15):
    try:
        r = requests.get(
            VM_BASE + path,
            auth=(PANEL_USER, PANEL_PASSWORD),
            headers=_rbac_headers(user),
            timeout=timeout,
        )
        return r.json() if r.ok else None
    except (requests.RequestException, ValueError):
        return None


def _vm_post_json(path, body, user=None, timeout=15):
    """POST JSON to the agent without a Flask request in hand (Discord bot path).
    Returns (http_status, payload dict)."""
    headers = _rbac_headers(user)
    headers["Content-Type"] = "application/json"
    try:
        r = requests.post(
            VM_BASE + path,
            data=json.dumps(body or {}),
            auth=(PANEL_USER, PANEL_PASSWORD),
            headers=headers,
            timeout=timeout,
        )
    except requests.RequestException as e:
        print(f"vm unreachable (post {path}): {e}")
        return 502, {"ok": False, "error": "vm unreachable"}
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {"ok": r.ok, "error": None if r.ok else (r.text or "")[:200]}


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


def _h_login(request):
    """POST /api/login {username,password} -> {ok, token, user, perms, exp}.

    Unauthenticated route (that's the point); handled before the auth gate in
    the entrypoint. Shares the per-IP throttle + PBKDF2 check with Basic-Auth.
    """
    if not INTERNAL_TOKEN:
        # No signing secret -> refuse to issue tokens rather than mint forgeable ones.
        return _err("server auth not configured", 500)
    ip = _client_ip(request)
    if _login_throttled(ip):
        print(f"login throttled for ip={ip}")
        return _json(
            {"ok": False, "error": "too many attempts, try again later", "retry_after": _throttle_retry_after(ip)},
            429,
        )
    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    rec = _check_password(username, password) if username else None
    if not rec:
        _note_failed_login(ip)
        return _err("invalid credentials", 401)
    _clear_failed_login(ip)
    perms = _effective_perms(rec)
    ver = rec.get("ver", 0)
    token, exp = _make_token(username, perms, ver)
    return _ok({"token": token, "user": username, "perms": perms, "exp": exp})


def _h_logout(request, user, path, method):
    # Tokens are stateless; the client just drops it. Nothing to invalidate server-side.
    return _ok()


def _h_logout_all(request, user, path, method):
    """Bump the caller's users.json "ver", invalidating every outstanding token."""

    def mutate(data):
        rec = data.get("users", {}).get(user["name"])
        if not rec:
            return False, _err("user not found", 404)
        rec["ver"] = rec.get("ver", 0) + 1
        return True, _ok({"ver": rec["ver"]})

    return _update(USERS_OBJECT, _seed_users, mutate)


def _h_account_password(request, user, path, method):
    """POST /api/account/password {old,new} -> re-hash at current PBKDF2 count, bump ver."""
    body = request.get_json(silent=True) or {}
    old = body.get("old") or ""
    new = body.get("new") or ""
    if not new or len(new) < 8:
        return _err("new password must be at least 8 characters", 400)
    if not _check_password(user["name"], old):
        return _err("current password is incorrect", 401)

    def mutate(data):
        rec = data.get("users", {}).get(user["name"])
        if not rec:
            return False, _err("user not found", 404)
        new_fields = _new_user(new, rec.get("perms", []), role=rec.get("role", "custom"))
        new_fields["ver"] = rec.get("ver", 0) + 1  # bump: invalidate every outstanding token
        rec.update(new_fields)
        return True, _ok({"ver": rec["ver"]})

    return _update(USERS_OBJECT, _seed_users, mutate)


def _h_overview(request, user, path, method):
    try:
        st = _vm_status()
    except Exception as e:  # noqa: BLE001
        print(f"vm status check failed (overview): {e}")
        return _json(
            {
                "ok": False,
                "error": "status check failed",
                "vm": {"status": "UNKNOWN", "ip": VM_IP, "game_port": GAME_PORT},
            }
        )
    server = None
    if st == "RUNNING":
        server = {
            "info": _vm_get_json("/api/rest/info", user),
            "metrics": _vm_get_json("/api/rest/metrics", user),
            "players": (_vm_get_json("/api/rest/players", user) or {}).get("players", []),
        }
    return _ok({"vm": {"status": st, "ip": VM_IP, "game_port": GAME_PORT}, "server": server})


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

    def mutate(data):
        data.clear()
        data.update(cfg)  # watchdog config is a whole-value replace
        return True, _ok(cfg)

    return _update(WD_OBJECT, _seed_wd, mutate)


def _h_users(request, user, path, method):
    return _handle_users(request, method, path)


def _h_roles(request, user, path, method):
    return _handle_roles(request, method, path)


def _h_vm_status(request, user, path, method):
    try:
        return _ok({"status": _vm_status(), "ip": VM_IP, "game_port": GAME_PORT})
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
# Discord bot ops — the actions discord_bot.py invokes. Kept here (not in
# discord_bot.py) so all VM/GCS access stays in one module and the bot file is
# pure protocol. Every method takes the caller's pseudo-user so the agent sees
# signed RBAC headers for the actual Discord user.
# ---------------------------------------------------------------------------

# Discord kills an interaction that isn't answered in ~3s: keep agent calls
# short and fan them out instead of chaining four 15s timeouts.
_DISCORD_TIMEOUT = 2.5


class _DiscordOps:
    def overview(self, user, fast=False):
        out = {"status": "UNKNOWN", "ip": VM_IP, "port": GAME_PORT}
        try:
            out["status"] = _vm_status()
        except Exception as e:  # noqa: BLE001
            print(f"vm status check failed (discord): {e}")
            return out
        if fast or out["status"] != "RUNNING":
            return out

        from concurrent.futures import ThreadPoolExecutor

        paths = {
            "info": "/api/rest/info",
            "metrics": "/api/rest/metrics",
            "players": "/api/rest/players",
            "settings": "/api/rest/settings",
        }
        with ThreadPoolExecutor(max_workers=len(paths)) as pool:
            futures = {
                key: pool.submit(_vm_get_json, p, user, _DISCORD_TIMEOUT) for key, p in paths.items()
            }
            results = {key: f.result() for key, f in futures.items()}
        out["info"] = results["info"] or {}
        out["metrics"] = results["metrics"] or {}
        out["settings"] = results["settings"] or {}
        out["players"] = (results["players"] or {}).get("players", [])
        return out

    def vm_start(self):
        return _vm_start()

    def vm_stop(self):
        return _vm_stop()

    def rest(self, endpoint, body, user):
        """POST a Palworld REST command through the agent. 503 when the VM is off."""
        try:
            if _vm_status() != "RUNNING":
                return 503, {"ok": False, "error": "vm_offline"}
        except Exception as e:  # noqa: BLE001
            print(f"vm status check failed (discord rest {endpoint}): {e}")
            return 502, {"ok": False, "error": "status check failed"}
        return _vm_post_json(f"/api/rest/{endpoint}", body, user, timeout=_DISCORD_TIMEOUT)

    def user_create(self, username, password, role):
        return _discord_user_create(username, password, role)

    def user_list(self):
        return _users_public(_load_users())

    def user_delete(self, username):
        return _discord_user_delete(username)


def _discord_user_create(username, password, role):
    """Create a panel user (never overwrite an existing one from Discord)."""
    if role != "custom" and role not in _load_roles().get("roles", {}):
        return {"ok": False, "error": f"unknown role {role!r}"}

    def mutate(data):
        users = data.setdefault("users", {})
        if username in users:
            return False, {"ok": False, "error": "user already exists"}
        users[username] = _new_user(password, [], role=role)
        return True, {"ok": True}

    res = _update(USERS_OBJECT, _seed_users, mutate)
    # _update's own conflict path returns an HTTP tuple, not a dict.
    return res if isinstance(res, dict) else {"ok": False, "error": "concurrent update, retry"}


def _discord_user_delete(username):
    def mutate(data):
        users = data.setdefault("users", {})
        if username not in users:
            return False, {"ok": False, "error": "user not found"}
        remaining = {u: r for u, r in users.items() if u != username}
        if not any("users" in _effective_perms(r) for r in remaining.values()):
            return False, {"ok": False, "error": "cannot delete the last user manager"}
        del users[username]
        return True, {"ok": True}

    res = _update(USERS_OBJECT, _seed_users, mutate)
    return res if isinstance(res, dict) else {"ok": False, "error": "concurrent update, retry"}


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


def _roles_path(path):
    return path == "/api/roles" or path.startswith("/api/roles/")


ROUTES = [
    ("GET", _exact("/api/session"), None, _h_session),
    ("POST", _exact("/api/logout"), None, _h_logout),
    ("POST", _exact("/api/logout-all"), None, _h_logout_all),
    ("POST", _exact("/api/account/password"), None, _h_account_password),
    ("GET", _exact("/api/overview"), "view", _h_overview),
    ("GET", _exact("/api/watchdog"), "view", _h_watchdog_get),
    ("POST", _exact("/api/watchdog"), "watchdog", _h_watchdog_post),
    (None, _users_path, "users", _h_users),
    (None, _roles_path, "users", _h_roles),
    ("GET", _exact("/api/vm/status"), "view", _h_vm_status),
    ("POST", _exact("/api/vm/start"), "power", _h_vm_start),
    ("POST", _exact("/api/vm/stop"), "power", _h_vm_stop),
    # config (PalWorldSettings.ini) proxy
    ("GET", _prefix("/api/config"), "view", _h_proxy),
    ("POST", _prefix("/api/config"), "settings", _h_proxy),
    # Palworld REST passthrough
    ("GET", _prefix("/api/rest/"), "view", _h_proxy),
    ("POST", _prefix("/api/rest/"), "commands", _h_proxy),
    # host metrics + game logs (read-only; both answer 503 vm_offline while the
    # VM is down, which is the correct "nothing to show" signal)
    ("GET", _prefix("/api/metrics"), "view", _h_proxy),
    ("GET", _prefix("/api/logs"), "view", _h_proxy),
    # save slots (file manipulation on the VM; covers list/create/activate/
    # backup/backups/restore/delete)
    ("GET", _prefix("/api/saves"), "view", _h_proxy_long),
    ("NOT_GET", _prefix("/api/saves"), "saves", _h_proxy_long),
    # mods (list/upload/url/enable/disable/delete)
    ("GET", _prefix("/api/mods"), "view", _h_proxy_long),
    ("NOT_GET", _prefix("/api/mods"), "mods", _h_proxy_long),
    ("POST", _exact("/api/restart"), "settings", _h_proxy),
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
            # no-store so a browser never serves a stale SPA after a deploy
            # (a cached old bundle gated on pre-v3 perms would hide sections).
            return (
                f.read(),
                200,
                {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store, must-revalidate",
                },
            )

    # --- unauthenticated login endpoint: issues the session token ---
    if path == "/api/login" and method == "POST":
        return _h_login(request)

    # --- Discord interactions: authenticated by Ed25519 signature, not by a
    # session token (Discord can't send one). 404 while the bot is unconfigured.
    if path == "/api/discord/interactions" and method == "POST":
        return discord_bot.handle(request, _DiscordOps())

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
    if method == "GET":
        data = _load_users()
        roles = _load_roles().get("roles", {})
        return _ok({"users": _users_public(data), "all_perms": PERMS, "roles": list(roles.keys())})

    if method == "POST":
        body = request.get_json(silent=True) or {}
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not username:
            return _err("username required", 400)

        roles = _load_roles().get("roles", {})
        role_given = "role" in body
        role = ((body.get("role") or "custom").strip() or "custom") if role_given else None
        if role and role != "custom" and role not in roles:
            return _err(f"unknown role {role!r}", 400)

        perms_given = "perms" in body
        perms = [p for p in (body.get("perms") or []) if p in PERMS] if perms_given else None

        def mutate(data):
            users = data.setdefault("users", {})
            if username in users:
                existing = users[username]
                new_role = role if role_given else existing.get("role", "custom")
                new_perms = perms if perms_given else existing.get("perms", [])
                existing["role"] = new_role
                existing["perms"] = new_perms
                if password:
                    nf = _new_user(password, new_perms, role=new_role)
                    nf["ver"] = existing.get("ver", 0) + 1  # bump, don't reset to 0
                    users[username] = {**existing, **nf}
            else:
                if not password:
                    return False, _err("password required for new user", 400)
                new_role = role if role_given else "custom"
                new_perms = perms if perms_given else []
                users[username] = _new_user(password, new_perms, role=new_role)
            if not any("users" in _effective_perms(r) for r in users.values()):
                return False, _err("at least one user must keep the 'users' permission", 400)
            return True, _ok({"users": _users_public(data)})

        return _update(USERS_OBJECT, _seed_users, mutate)

    if method == "DELETE":
        username = path.split("/api/users/", 1)[1] if "/api/users/" in path else ""

        def mutate(data):
            users = data.setdefault("users", {})
            if username not in users:
                return False, _err("not found", 404)
            remaining = {u: r for u, r in users.items() if u != username}
            if not any("users" in _effective_perms(r) for r in remaining.values()):
                return False, _err("cannot delete the last user manager", 400)
            del users[username]
            return True, _ok({"users": _users_public(data)})

        return _update(USERS_OBJECT, _seed_users, mutate)

    return _err("method not allowed", 405)


def _roles_public(roles):
    return [
        {"name": n, "perms": r.get("perms", []), "builtin": bool(r.get("builtin"))}
        for n, r in roles.items()
    ]


def _handle_roles(request, method, path):
    def _with_builtins(data):
        roles = data.setdefault("roles", {})
        # backfill any builtin missing from the stored doc
        for bn, br in BUILTIN_ROLES.items():
            roles.setdefault(bn, dict(br))
        return roles

    if method == "GET":
        return _ok({"roles": _roles_public(_with_builtins(dict(_load_roles()))), "all_perms": PERMS})

    if method == "POST":
        body = request.get_json(silent=True) or {}
        name = (body.get("name") or "").strip()
        if not name:
            return _err("name required", 400)
        if name == "custom":
            # reserved sentinel: _effective_perms treats role=="custom" as "use
            # the per-user perms override", so a role literally named custom
            # could never take effect. Reject it (matches the frontend guard).
            return _err('"custom" is a reserved role name', 400)
        perms = [p for p in (body.get("perms") or []) if p in PERMS]

        def mutate(data):
            roles = _with_builtins(data)
            builtin = bool(roles.get(name, {}).get("builtin"))
            roles[name] = {"perms": perms, "builtin": builtin}
            return True, _ok({"roles": _roles_public(roles)})

        return _update(ROLES_OBJECT, _seed_roles, mutate)

    if method == "DELETE":
        name = path.split("/api/roles/", 1)[1] if "/api/roles/" in path else ""
        # role-in-use check reads a different doc (users) — do it up front.
        in_use = any(r.get("role") == name for r in _load_users().get("users", {}).values())

        def mutate(data):
            roles = _with_builtins(data)
            role = roles.get(name)
            if not role:
                return False, _err("not found", 404)
            if role.get("builtin"):
                return False, _err("cannot delete a built-in role", 400)
            if in_use:
                return False, _err("cannot delete a role while a user still holds it", 400)
            del roles[name]
            return True, _ok({"roles": _roles_public(roles)})

        return _update(ROLES_OBJECT, _seed_roles, mutate)

    return _err("method not allowed", 405)
