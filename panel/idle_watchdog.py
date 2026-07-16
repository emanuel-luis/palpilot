#!/usr/bin/env python3
"""
Palworld idle watchdog (runs on the VM).

Polls the local REST API for the online player count every POLL_SECONDS.
While anyone is online the server stays up. Once the server has been empty
for IDLE_GRACE_SECONDS it asks the coordinator to power the VM down.

The empty timer starts at boot, so a machine that is turned on but never
joined also shuts itself back down after the grace window.

Env vars (set by the systemd unit in startup.sh):
  ADMIN_PASSWORD       Palworld REST admin password (basic auth 'admin')
  REST_HOST/REST_PORT  local REST API (default 127.0.0.1:8212)
  COORDINATOR_URL      base URL of the coordinator function
  INTERNAL_TOKEN       shared secret for the coordinator stop call
  POLL_SECONDS         poll interval (default 60)
  IDLE_GRACE_SECONDS   empty tolerance before shutdown (default 1800)
"""

import base64
import json
import os
import time
import urllib.error
import urllib.request

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
REST_HOST = os.environ.get("REST_HOST", "127.0.0.1")
REST_PORT = os.environ.get("REST_PORT", "8212")
COORDINATOR_URL = os.environ.get("COORDINATOR_URL", "").rstrip("/")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))
IDLE_GRACE_SECONDS = int(os.environ.get("IDLE_GRACE_SECONDS", "1800"))


def log(msg):
    print(f"[watchdog] {msg}", flush=True)


def player_count():
    """Return online player count, or None if the REST API is unreachable."""
    url = f"http://{REST_HOST}:{REST_PORT}/v1/api/metrics"
    req = urllib.request.Request(url)
    token = base64.b64encode(f"admin:{ADMIN_PASSWORD}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode() or "{}")
        return int(data.get("currentplayernum", 0))
    except (urllib.error.URLError, ValueError, TimeoutError, OSError):
        return None


def request_shutdown():
    url = f"{COORDINATOR_URL}/api/vm/stop"
    req = urllib.request.Request(url, data=b"{}", method="POST")
    req.add_header("X-Internal-Token", INTERNAL_TOKEN)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status


def main():
    log(
        f"start: poll={POLL_SECONDS}s grace={IDLE_GRACE_SECONDS}s "
        f"coordinator={'set' if COORDINATOR_URL else 'MISSING'}"
    )
    empty_since = time.monotonic()  # treat boot as empty-start
    while True:
        n = player_count()
        now = time.monotonic()
        if n is None:
            log("REST unreachable (server starting or down); idle timer unchanged")
        elif n > 0:
            if empty_since is not None:
                log(f"{n} player(s) online; server active")
            empty_since = None
        else:
            if empty_since is None:
                empty_since = now
            idle = int(now - empty_since)
            log(f"empty for {idle}s / {IDLE_GRACE_SECONDS}s")
            if idle >= IDLE_GRACE_SECONDS:
                if not COORDINATOR_URL or not INTERNAL_TOKEN:
                    log("ERROR: coordinator not configured; cannot shut down")
                else:
                    log("idle grace exceeded -> requesting VM shutdown")
                    try:
                        code = request_shutdown()
                        log(f"coordinator stop returned HTTP {code}; exiting")
                        return
                    except urllib.error.URLError as e:
                        log(f"shutdown request failed: {e}; will retry next cycle")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
