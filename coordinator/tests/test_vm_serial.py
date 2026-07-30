"""GET /api/vm/serial — the VM boot/system log the console reads.

Coordinator-owned on purpose: the agent cannot read the journal (that would need
a sudoers/startup.sh change) and the interesting moments are exactly when the
agent is not answering yet. So the tests care about three things: it is gated,
it never leaks a secret that happens to land in serial output, and "the VM is
off" is reported as a state rather than an error.

Reuses the SDK stubs from test_static_routes so main.py imports without GCP.
"""

import json
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from test_static_routes import _Req, main  # noqa: E402


class _Serial:
    """Stands in for compute's SerialPortOutput (note the `next_` field name)."""

    def __init__(self, contents, start=0, next_=0):
        self.contents = contents
        self.start = start
        self.next_ = next_


class _Inst:
    def __init__(self, status="RUNNING", serial=None, raises=False):
        self._status = status
        self._serial = serial or _Serial("", 0, 0)
        self._raises = raises
        self.calls = []

    def get(self, **kw):
        return type("I", (), {"status": self._status})()

    def get_serial_port_output(self, **kw):
        self.calls.append(kw)
        if self._raises:
            raise RuntimeError("resource is not ready")
        return self._serial


def _get(start=None):
    req = _Req("/api/vm/serial")
    req.args = {} if start is None else {"start": str(start)}
    body, status, _headers = main._h_vm_serial(req, {"name": "owner", "perms": ["view"]}, "/api/vm/serial", "GET")
    return status, json.loads(body)


class VmSerialRoute(unittest.TestCase):
    def setUp(self):
        self._saved = main._inst

    def tearDown(self):
        main._inst = self._saved

    def test_route_is_registered_and_gated_view(self):
        entry = next(
            (r for r in main.ROUTES if r[1]("/api/vm/serial") and r[0] == "GET"), None
        )
        self.assertIsNotNone(entry, "GET /api/vm/serial must be in the route table")
        self.assertEqual(entry[2], "view")

    def test_returns_contents_and_the_next_offset(self):
        main._inst = _Inst(serial=_Serial("boot line 1\nboot line 2\n", start=0, next_=24))
        status, body = _get(0)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(body["available"])
        self.assertIn("boot line 2", body["contents"])
        self.assertEqual(body["next"], 24)

    def test_start_offset_is_passed_through_for_tailing(self):
        inst = _Inst(serial=_Serial("", start=500, next_=500))
        main._inst = inst
        _get(500)
        self.assertEqual(inst.calls[0]["start"], 500)
        self.assertEqual(inst.calls[0]["port"], 1)

    def test_garbage_start_does_not_500(self):
        main._inst = _Inst(serial=_Serial("x", 0, 1))
        req = _Req("/api/vm/serial")
        req.args = {"start": "not-a-number"}
        body, status, _h = main._h_vm_serial(req, {"name": "o", "perms": ["view"]}, "/api/vm/serial", "GET")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

    def test_vm_off_is_a_state_not_an_error(self):
        # A stopped instance has no serial port; GCP answers "not ready". The UI
        # renders this as a note, so it must be ok:true with available:false.
        inst = _Inst(status="TERMINATED")
        main._inst = inst
        status, body = _get(0)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertFalse(body["available"])
        self.assertEqual(body["vm_status"], "TERMINATED")
        self.assertEqual(inst.calls, [])  # never even asked

    def test_serial_read_failure_degrades_quietly(self):
        main._inst = _Inst(raises=True)
        status, body = _get(0)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertFalse(body["available"])

    def test_secrets_are_redacted_from_output(self):
        # Serial output is raw VM output; nobody vets every line a failing unit or
        # startup.sh might print, and the coordinator holds these values anyway.
        saved = (main.PANEL_PASSWORD, main.INTERNAL_TOKEN)
        main.PANEL_PASSWORD = "panelpw-secret"
        main.INTERNAL_TOKEN = "tok-secret"
        try:
            main._inst = _Inst(
                serial=_Serial("env PANEL_PASSWORD=panelpw-secret TOKEN=tok-secret\n", 0, 10)
            )
            _status, body = _get(0)
        finally:
            (main.PANEL_PASSWORD, main.INTERNAL_TOKEN) = saved
        self.assertNotIn("panelpw-secret", body["contents"])
        self.assertNotIn("tok-secret", body["contents"])
        self.assertIn("********", body["contents"])

    def test_redaction_ignores_trivially_short_values(self):
        # An empty or 1-2 char secret would otherwise shred unrelated output.
        saved = main.PANEL_PASSWORD
        main.PANEL_PASSWORD = "ab"
        try:
            self.assertEqual(main._redact("a stable boot line"), "a stable boot line")
        finally:
            main.PANEL_PASSWORD = saved


if __name__ == "__main__":
    unittest.main()
