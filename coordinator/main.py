"""
Palworld coordinator — Cloud Function (gen2, HTTP).

Always-on control plane:
  - serves the admin panel UI (index.html)
  - starts / stops / reports status of the Palworld VM
  - proxies config + REST-API calls to the VM's local agent (panel.py on :8080)

The VM's idle watchdog calls POST /api/vm/stop with the internal token to
power the machine down after the server has been empty past the grace window.

Env vars (set by Terraform):
  PROJECT_ID, VM_ZONE, VM_INSTANCE   target instance
  VM_IP, VM_PORT                     VM static IP + local agent port (8080)
  PANEL_USER, PANEL_PASSWORD         basic-auth for the panel + the VM agent
  INTERNAL_TOKEN                     shared secret for the watchdog stop call
"""

import json
import os

import functions_framework
import requests
from google.cloud import compute_v1

PROJECT_ID = os.environ["PROJECT_ID"]
VM_ZONE = os.environ["VM_ZONE"]
VM_INSTANCE = os.environ["VM_INSTANCE"]
VM_IP = os.environ.get("VM_IP", "")
VM_PORT = os.environ.get("VM_PORT", "8080")
PANEL_USER = os.environ.get("PANEL_USER", "admin")
PANEL_PASSWORD = os.environ.get("PANEL_PASSWORD", "")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")

INDEX_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
VM_BASE = f"http://{VM_IP}:{VM_PORT}"

_inst = compute_v1.InstancesClient()


def _json(obj, status=200):
    return (json.dumps(obj), status, {"Content-Type": "application/json"})


def _basic_ok(request):
    a = request.authorization
    return bool(a) and a.username == PANEL_USER and a.password == PANEL_PASSWORD


def _vm_status():
    return _inst.get(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE).status


@functions_framework.http
def coordinator(request):
    path = request.path or "/"
    method = request.method

    # --- public: panel UI ---
    if path == "/" and method == "GET":
        with open(INDEX_PATH, encoding="utf-8") as f:
            return (f.read(), 200, {"Content-Type": "text/html; charset=utf-8"})

    # --- watchdog stop (token auth, no basic) ---
    if (
        path == "/api/vm/stop"
        and method == "POST"
        and INTERNAL_TOKEN
        and request.headers.get("X-Internal-Token") == INTERNAL_TOKEN
    ):
        _inst.stop(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE)
        return _json({"stopping": True, "by": "watchdog"})

    # --- everything below needs panel basic auth ---
    if not _basic_ok(request):
        return ("Unauthorized", 401, {"WWW-Authenticate": "Basic"})

    if path == "/api/session":
        return _json({"ok": True, "user": PANEL_USER})

    if path == "/api/vm/status":
        try:
            return _json({"status": _vm_status(), "ip": VM_IP})
        except Exception as e:  # noqa: BLE001
            return _json({"status": "UNKNOWN", "error": str(e)}, 500)

    if path == "/api/vm/start" and method == "POST":
        _inst.start(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE)
        return _json({"starting": True})

    if path == "/api/vm/stop" and method == "POST":
        _inst.stop(project=PROJECT_ID, zone=VM_ZONE, instance=VM_INSTANCE)
        return _json({"stopping": True})

    # --- proxy config / REST / restart to the VM agent ---
    if path.startswith("/api/config") or path.startswith("/api/rest/") or path == "/api/restart":
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
            return (
                r.content,
                r.status_code,
                {"Content-Type": r.headers.get("Content-Type", "application/json")},
            )
        except requests.RequestException as e:
            return _json({"error": f"vm unreachable: {e}"}, 502)

    return _json({"error": "not found", "path": path}, 404)
