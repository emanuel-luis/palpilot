"""Host-metrics parsers and the log reader.

These are the other two pieces of panel.py with real parsing logic (alongside the
INI parser), and both are Linux-only in production -- /proc doesn't exist on a
dev machine. So the /proc readers are driven through synthetic fixtures and the
log reader against a temp dir, which keeps the suite platform-independent.
"""

import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import panel  # noqa: E402


STAT_A = (
    "cpu  100 0 50 800 20 0 0 0 0 0\n"
    "cpu0 50 0 25 400 10 0 0 0 0 0\n"
    "cpu1 50 0 25 400 10 0 0 0 0 0\n"
    "intr 1\n"
)
STAT_B = (
    "cpu  200 0 100 1400 40 0 0 0 0 0\n"
    "cpu0 100 0 50 700 20 0 0 0 0 0\n"
    "cpu1 100 0 50 700 20 0 0 0 0 0\n"
    "intr 1\n"
)
MEMINFO = (
    "MemTotal:       16384000 kB\n"
    "MemFree:          512000 kB\n"
    "MemAvailable:    8192000 kB\n"
    "Buffers:             100 kB\n"
)
NETDEV = (
    "Inter-|   Receive                            |  Transmit\n"
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes\n"
    "    lo: 999 1 0 0 0 0 0 0 888 1 0 0 0 0 0 0\n"
    "  eth0: 1000 5 0 0 0 0 0 0 2000 7 0 0 0 0 0 0\n"
    "docker0: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n"
)


class ProcPatch:
    """Swap panel._read_proc for a fixture-backed reader."""

    def __init__(self, stat_sequence=None):
        self.stat_sequence = list(stat_sequence or [])
        self._orig_read = panel._read_proc
        self._orig_sleep = panel.time.sleep

    def __enter__(self):
        def fake(path):
            if path == "/proc/stat":
                return self.stat_sequence.pop(0) if self.stat_sequence else STAT_A
            if path == "/proc/meminfo":
                return MEMINFO
            if path == "/proc/net/dev":
                return NETDEV
            if path == "/proc/loadavg":
                return "0.50 0.40 0.30 1/200 123"
            if path == "/proc/uptime":
                return "12345.67 9999.00"
            return ""

        panel._read_proc = fake
        panel.time.sleep = lambda _s: None  # don't pay the sample window in tests
        return self

    def __exit__(self, *exc):
        panel._read_proc = self._orig_read
        panel.time.sleep = self._orig_sleep
        return False


class TestCpu(unittest.TestCase):
    def test_percent_and_core_count(self):
        # total 970 -> 1740 (delta 770); idle+iowait 820 -> 1440 (delta 620)
        # busy = 770 - 620 = 150 -> 150/770 = 19.5%
        with ProcPatch([STAT_A, STAT_B]):
            percent, cores = panel._cpu_percent()
        self.assertEqual(cores, 2)
        self.assertEqual(percent, 19.5)

    def test_no_movement_between_samples_reports_none(self):
        # A stalled counter must not be reported as 0% busy.
        with ProcPatch([STAT_A, STAT_A]):
            percent, cores = panel._cpu_percent()
        self.assertIsNone(percent)
        self.assertEqual(cores, 2)

    def test_unreadable_proc_is_not_fatal(self):
        orig = panel._read_proc
        panel._read_proc = lambda _p: ""
        try:
            self.assertEqual(panel._cpu_percent(), (None, 0))
        finally:
            panel._read_proc = orig


class TestMemory(unittest.TestCase):
    def test_uses_memavailable_not_memfree(self):
        with ProcPatch():
            m = panel._meminfo()
        self.assertEqual(m["total"], 16384000 * 1024)
        self.assertEqual(m["available"], 8192000 * 1024)
        self.assertEqual(m["used"], m["total"] - m["available"])
        self.assertEqual(m["percent"], 50.0)


class TestNetwork(unittest.TestCase):
    def setUp(self):
        panel._net_sample.update({"ts": 0.0, "rx": 0, "tx": 0})

    def test_excludes_loopback_and_bridges(self):
        with ProcPatch():
            n = panel._netio()
        self.assertEqual(n["rx_bytes"], 1000)  # eth0 only
        self.assertEqual(n["tx_bytes"], 2000)

    def test_first_sample_has_no_rate(self):
        with ProcPatch():
            self.assertIsNone(panel._netio()["rx_bytes_per_sec"])

    def test_rate_from_previous_sample(self):
        panel._net_sample.update({"ts": time.time() - 2.0, "rx": 600, "tx": 1200})
        with ProcPatch():
            n = panel._netio()
        # 400 bytes over ~2s; integer truncation makes 199 as valid as 200.
        self.assertIn(n["rx_bytes_per_sec"], (199, 200))
        self.assertIn(n["tx_bytes_per_sec"], (399, 400))

    def test_counter_reset_does_not_produce_negative_rate(self):
        panel._net_sample.update({"ts": time.time() - 1.0, "rx": 10**9, "tx": 10**9})
        with ProcPatch():
            n = panel._netio()
        self.assertIsNone(n["rx_bytes_per_sec"])
        self.assertIsNone(n["tx_bytes_per_sec"])


class TestReadLog(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self._orig_dir = panel.LOGS_DIR
        self._orig_max = panel.LOG_MAX_LINES
        panel.LOGS_DIR = self.dir
        panel.LOG_MAX_LINES = 5
        self.path = os.path.join(self.dir, "Pal.log")

    def tearDown(self):
        panel.LOGS_DIR = self._orig_dir
        panel.LOG_MAX_LINES = self._orig_max

    def write(self, text, mode="w"):
        with open(self.path, mode, encoding="utf-8") as f:
            f.write(text)

    def test_missing_directory_is_empty_not_an_error(self):
        panel.LOGS_DIR = os.path.join(self.dir, "nope")
        r = panel.read_log()
        self.assertTrue(r["ok"])
        self.assertEqual(r["lines"], [])
        self.assertEqual(r["file"], "")

    def test_tail_caps_at_max_lines(self):
        self.write("".join(f"line {i}\n" for i in range(1, 9)))
        r = panel.read_log()
        self.assertEqual(r["lines"], [f"line {i}" for i in range(4, 9)])
        self.assertTrue(r["truncated"])
        self.assertEqual(r["cursor"], os.path.getsize(self.path))

    def test_cursor_at_eof_returns_nothing(self):
        self.write("a\nb\n")
        first = panel.read_log()
        again = panel.read_log(cursor=first["cursor"])
        self.assertEqual(again["lines"], [])
        self.assertFalse(again["rotated"])

    def test_cursor_returns_only_appended_lines(self):
        self.write("a\nb\n")
        first = panel.read_log()
        self.write("c\nd\n", mode="a")
        nxt = panel.read_log(cursor=first["cursor"])
        self.assertEqual(nxt["lines"], ["c", "d"])

    def test_truncation_is_flagged_so_the_client_can_resync(self):
        self.write("a\nb\nc\n")
        first = panel.read_log()
        self.write("fresh\n")  # rotated: now shorter than the cursor
        r = panel.read_log(cursor=first["cursor"])
        self.assertTrue(r["rotated"])
        self.assertEqual(r["lines"], ["fresh"])

    def test_unknown_or_traversing_name_is_rejected(self):
        self.write("a\n")
        r = panel.read_log(name="../../etc/passwd")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "not_found")

    def test_newest_file_is_chosen_by_default(self):
        self.write("older\n")
        newer = os.path.join(self.dir, "Pal-2.log")
        with open(newer, "w", encoding="utf-8") as f:
            f.write("newer\n")
        future = time.time() + 10
        os.utime(newer, (future, future))
        self.assertEqual(panel.read_log()["file"], "Pal-2.log")




class TestSlotConfig(unittest.TestCase):
    """Per-slot settings. The risk here is writing to the wrong file, so every
    case asserts which path was touched, not just the return value."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.saved = {
            "INI_PATH": panel.INI_PATH,
            "SLOT_CONFIG_DIR": panel.SLOT_CONFIG_DIR,
            "get_active_world": panel.get_active_world,
            "list_slots": panel.list_slots,
            "_chown_steam": panel._chown_steam,
        }
        panel.INI_PATH = os.path.join(self.dir, "live.ini")
        panel.SLOT_CONFIG_DIR = os.path.join(self.dir, "slots")
        os.makedirs(panel.SLOT_CONFIG_DIR, exist_ok=True)
        panel._chown_steam = lambda *a, **k: None
        panel.get_active_world = lambda: "ACTIVE1"
        panel.list_slots = lambda: {
            "slots": [{"guid": "ACTIVE1"}, {"guid": "OTHER2"}, {"guid": "FRESH3"}]
        }
        with open(panel.INI_PATH, "w", encoding="utf-8") as f:
            f.write("[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ExpRate=1.000000,Difficulty=None)\n")

    def tearDown(self):
        panel.INI_PATH = self.saved["INI_PATH"]
        panel.SLOT_CONFIG_DIR = self.saved["SLOT_CONFIG_DIR"]
        panel.get_active_world = self.saved["get_active_world"]
        panel.list_slots = self.saved["list_slots"]
        panel._chown_steam = self.saved["_chown_steam"]

    def live(self):
        with open(panel.INI_PATH, encoding="utf-8") as f:
            return f.read()

    def stored(self, guid):
        p = panel._slot_config_path(guid)
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8") as f:
            return f.read()

    # --- reads

    def test_active_slot_reads_the_live_file(self):
        r = panel.read_slot_config("ACTIVE1")
        self.assertTrue(r["ok"])
        self.assertTrue(r["active"])
        self.assertEqual(r["path"], panel.INI_PATH)
        self.assertEqual(r["options"]["ExpRate"], "1.000000")

    def test_slot_with_no_stored_config_says_so(self):
        # Not an error, and not "all defaults" — it will inherit on activation.
        r = panel.read_slot_config("FRESH3")
        self.assertTrue(r["ok"])
        self.assertFalse(r["stored"])
        self.assertEqual(r["options"], {})

    def test_unknown_slot_is_not_found(self):
        r = panel.read_slot_config("NOPE")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "not_found")

    def test_invalid_guid_is_rejected(self):
        for bad in ("../etc", "a/b", ""):
            r = panel.read_slot_config(bad)
            self.assertFalse(r["ok"], bad)
            self.assertEqual(r["reason"], "validation", bad)

    # --- writes

    def test_writing_the_active_slot_updates_the_live_file(self):
        r = panel.write_slot_config("ACTIVE1", options={"ExpRate": "3.000000"})
        self.assertTrue(r["ok"])
        self.assertTrue(r["applied_live"])
        self.assertIn("ExpRate=3.000000", self.live())
        # and keeps the stored snapshot in step, so a later activate() can't
        # resurrect the old value
        self.assertIn("ExpRate=3.000000", self.stored("ACTIVE1") or "")

    def test_writing_another_slot_leaves_the_live_file_alone(self):
        before = self.live()
        r = panel.write_slot_config("OTHER2", options={"ExpRate": "5.000000"})
        self.assertTrue(r["ok"])
        self.assertFalse(r["applied_live"])
        self.assertEqual(self.live(), before)
        self.assertIn("ExpRate=5.000000", self.stored("OTHER2") or "")

    def test_first_write_to_a_bare_slot_starts_from_the_live_config(self):
        # Otherwise the slot would store a fragment holding only the edited key,
        # and activating it would drop every other setting.
        panel.write_slot_config("FRESH3", options={"ExpRate": "2.000000"})
        stored = self.stored("FRESH3") or ""
        self.assertIn("ExpRate=2.000000", stored)
        self.assertIn("Difficulty=None", stored)

    def test_raw_write_replaces_the_whole_file(self):
        panel.write_slot_config("OTHER2", raw="[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ExpRate=9.000000)\n")
        self.assertIn("ExpRate=9.000000", self.stored("OTHER2") or "")

    def test_write_needs_something_to_write(self):
        r = panel.write_slot_config("OTHER2")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "validation")

    def test_write_to_unknown_slot_is_not_found(self):
        r = panel.write_slot_config("NOPE", options={"ExpRate": "2.000000"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "not_found")
if __name__ == "__main__":
    unittest.main()
