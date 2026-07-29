"""Game version / auto-update logic.

The parsing here is the risky part: two flavours of Steam KeyValues text
(`app_info_print` output for what upstream serves, `appmanifest_<app>.acf` for
what is installed), plus the rules that turn those two into "what should this
save be running". steamcmd itself is never invoked -- every test either parses a
fixture or drives the pure metadata helpers against temp files.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import panel  # noqa: E402


# Trimmed `steamcmd +app_info_print 2394010`, including the console chatter it
# wraps the tree in and the `branches` block nested INSIDE `depots`.
APPINFO = """
Redirecting stderr to '/home/steam/Steam/logs/stderr.txt'
AppID : 2394010, change number : 28461925/0, last change :
"2394010"
{
        "common"
        {
                "name"          "Palworld Dedicated Server"
                "type"          "Tool"
        }
        "depots"
        {
                "2394011"
                {
                        "name"          "Palworld Dedicated Server Linux"
                        "manifests"
                        {
                                "public"
                                {
                                        "gid"           "8817919762338900001"
                                        "size"          "9000000000"
                                }
                        }
                }
                "2394012"
                {
                        "manifests"
                        {
                                "public"
                                {
                                        "gid"           "1122334455667788990"
                                }
                        }
                }
                "branches"
                {
                        "public"
                        {
                                "buildid"               "17615519"
                                "timeupdated"           "1753000000"
                        }
                        "beta"
                        {
                                "buildid"               "17700000"
                                "pwdrequired"           "1"
                        }
                }
        }
}
"""

# Older appinfo shape: the public manifest gid is the value, not a sub-block.
APPINFO_FLAT_GID = """
"2394010"
{
        "depots"
        {
                "2394011"
                {
                        "manifests"
                        {
                                "public"        "999888777"
                        }
                }
                "branches"
                {
                        "public"
                        {
                                "buildid"       "17000000"
                        }
                }
        }
}
"""

ACF = """"AppState"
{
        "appid"         "2394010"
        "Universe"      "1"
        "buildid"       "17615519"
        "LastUpdated"  "1753000123"
        "InstalledDepots"
        {
                "2394011"
                {
                        "manifest"      "8817919762338900001"
                        "size"          "9000000000"
                }
                "2394012"
                {
                        "manifest"      "1122334455667788990"
                }
        }
}
"""


class VdfParse(unittest.TestCase):
    def test_nested_blocks_and_values(self):
        tree = panel._parse_vdf(APPINFO)
        self.assertEqual(tree["2394010"]["common"]["name"], "Palworld Dedicated Server")
        self.assertEqual(
            tree["2394010"]["depots"]["branches"]["public"]["buildid"], "17615519"
        )

    def test_unbalanced_tail_is_not_fatal(self):
        # Truncated steamcmd output must yield what parsed, never raise.
        tree = panel._parse_vdf('"a"\n{\n"b" "1"\n')
        self.assertEqual(tree["a"]["b"], "1")

    def test_public_branch_buildid_and_manifests(self):
        info = panel._depots_from_appinfo(panel._parse_vdf(APPINFO))
        self.assertEqual(info["buildid"], "17615519")  # public, NOT the beta build
        self.assertEqual(
            info["depots"], {"2394011": "8817919762338900001", "2394012": "1122334455667788990"}
        )

    def test_flat_manifest_gid_shape(self):
        info = panel._depots_from_appinfo(panel._parse_vdf(APPINFO_FLAT_GID))
        self.assertEqual(info["buildid"], "17000000")
        self.assertEqual(info["depots"], {"2394011": "999888777"})

    def test_missing_buildid_yields_none(self):
        info = panel._depots_from_appinfo(panel._parse_vdf('"2394010"\n{\n}\n'))
        self.assertIsNone(info["buildid"])
        self.assertEqual(info["depots"], {})


class DepotStagingPath(unittest.TestCase):
    """Locating what `download_depot` staged.

    The live server hit this: the depot downloaded perfectly and the install was
    reported as "did not download", because steamcmd stages under its OWN install
    dir (not force_install_dir) and prints the path with Windows separators."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.depot_dir = os.path.join(
            self.tmp, "steamcmd", "linux32", "steamapps", "content", "app_2394010", "depot_1004"
        )
        os.makedirs(self.depot_dir)

    def test_parses_the_printed_path_with_backslashes(self):
        # Verbatim shape from the live log, with the real temp base spliced in.
        base = os.path.join(self.tmp, "steamcmd", "linux32").replace("\\", "/")
        log = (
            "Downloading depot 1004 (8 files, 21 MB) ...\n"
            f'Depot download complete : "{base}\\steamapps\\content\\app_2394010\\depot_1004"'
            " (manifest 5612541580377302256)\n"
        )
        found = panel._depot_dir_from_log(log, "1004")
        self.assertTrue(found, "should have parsed the staged depot path")
        self.assertTrue(os.path.isdir(found))
        self.assertTrue(found.endswith("depot_1004"))

    def test_ignores_a_path_for_a_different_depot(self):
        base = os.path.join(self.tmp, "steamcmd", "linux32").replace("\\", "/")
        log = f'Depot download complete : "{base}\\steamapps\\content\\app_2394010\\depot_1004"\n'
        self.assertEqual(panel._depot_dir_from_log(log, "2394012"), "")

    def test_ignores_a_path_that_does_not_exist(self):
        log = 'Depot download complete : "/nope/steamapps/content/app_2394010/depot_1004"\n'
        self.assertEqual(panel._depot_dir_from_log(log, "1004"), "")

    def test_no_completion_line_yields_nothing(self):
        self.assertEqual(panel._depot_dir_from_log("Error! Download failed.\n", "1004"), "")

    def test_fallback_roots_include_the_steamcmd_install_dir(self):
        # The root that was missing is what made a successful download look failed.
        cands = panel._depot_content_dirs("1004")
        self.assertTrue(
            any(os.path.join(".local", "share", "Steam", "steamcmd") in c for c in cands),
            cands,
        )
        self.assertTrue(any(panel.DEPOT_STAGE_HOME in c for c in cands), cands)


class RelevantDepots(unittest.TestCase):
    """Which of a build's depots this install should actually fetch.

    Prod's public branch lists Steamworks redistributable depots (1004, 1005)
    that a dedicated-server install does not contain; fetching them wasted a
    download and then failed the whole install."""

    def setUp(self):
        self._saved = panel.installed_version

    def tearDown(self):
        panel.installed_version = self._saved

    def test_narrows_to_the_installed_depot_set(self):
        panel.installed_version = lambda: {"depots": {"1006": "old", "2394012": "old"}}
        picked, skipped = panel._relevant_depots(
            {"1004": "a", "1005": "b", "1006": "c", "2394011": "d", "2394012": "e"}
        )
        self.assertEqual(picked, {"1006": "c", "2394012": "e"})  # new manifests
        self.assertEqual(sorted(skipped), ["1004", "1005", "2394011"])

    def test_takes_everything_when_nothing_is_installed(self):
        panel.installed_version = lambda: {"depots": {}}
        picked, skipped = panel._relevant_depots({"1004": "a", "2394012": "e"})
        self.assertEqual(picked, {"1004": "a", "2394012": "e"})
        self.assertEqual(skipped, {})

    def test_takes_everything_when_the_build_restructured_depots(self):
        # No overlap at all: installing nothing would be worse than installing all.
        panel.installed_version = lambda: {"depots": {"999": "old"}}
        picked, skipped = panel._relevant_depots({"2394099": "z"})
        self.assertEqual(picked, {"2394099": "z"})
        self.assertEqual(skipped, {})


class SteamcmdHome(unittest.TestCase):
    def test_home_override_is_passed_to_the_subprocess(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen.update(kw)

            class R:
                stdout = ""
                stderr = ""
                returncode = 0

            return R()

        saved = panel.subprocess.run
        panel.subprocess.run = fake_run
        try:
            panel._run_steamcmd(["+quit"], timeout=5, home="/data/stage")
        finally:
            panel.subprocess.run = saved
        self.assertEqual(seen["env"]["HOME"], "/data/stage")

    def test_no_home_override_inherits_the_environment(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen.update(kw)

            class R:
                stdout = ""
                stderr = ""
                returncode = 0

            return R()

        saved = panel.subprocess.run
        panel.subprocess.run = fake_run
        try:
            panel._run_steamcmd(["+quit"], timeout=5)
        finally:
            panel.subprocess.run = saved
        self.assertIsNone(seen["env"])


class VersionState(unittest.TestCase):
    """installed/latest/pin resolution, all against temp sidecar files."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved = {
            k: getattr(panel, k)
            for k in ("UPDATE_META", "APPMANIFEST", "SLOTS_META", "SAVEGAMES_DIR", "GUS_PATH")
        }
        panel.UPDATE_META = os.path.join(self.tmp, "palworld-update.json")
        panel.APPMANIFEST = os.path.join(self.tmp, "appmanifest_2394010.acf")
        panel.SLOTS_META = os.path.join(self.tmp, "palworld-slots.json")
        panel.SAVEGAMES_DIR = os.path.join(self.tmp, "SaveGames", "0")
        panel.GUS_PATH = os.path.join(self.tmp, "GameUserSettings.ini")
        # Ownership fixups need POSIX (`pwd`); irrelevant to this logic and the
        # suite stays runnable off-Linux.
        self._chown = panel._chown_steam
        panel._chown_steam = lambda *a, **k: None
        # _update_job is module-level: reset it so one test's failed install
        # can't leak into another's assertions.
        panel._update_job.update(
            {"state": "idle", "phase": "", "target": None, "reason": "",
             "started": None, "finished": None, "error": None, "log": ""}
        )
        os.makedirs(os.path.join(panel.SAVEGAMES_DIR, "WORLD1"))
        with open(panel.APPMANIFEST, "w", encoding="utf-8") as f:
            f.write(ACF)
        panel.set_active_world("WORLD1")

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(panel, k, v)
        panel._chown_steam = self._chown

    def test_appmanifest_is_the_installed_build(self):
        inst = panel.installed_version()
        self.assertEqual(inst["buildid"], "17615519")
        self.assertEqual(inst["depots"]["2394011"], "8817919762338900001")
        self.assertEqual(inst["method"], "latest")

    def test_pinned_marker_wins_over_appmanifest(self):
        # download_depot doesn't rewrite the .acf, so the marker is the truth
        # after a pinned install -- otherwise we'd report the build we left.
        panel._mark_installed("17000000", {"2394011": "999888777"}, "pinned")
        self.assertEqual(panel.installed_version()["buildid"], "17000000")

    def test_auto_update_defaults_on(self):
        self.assertTrue(panel.update_policy()["auto_update"])

    def test_policy_persists(self):
        panel.set_update_policy(False)
        self.assertFalse(panel.update_policy()["auto_update"])
        panel.set_update_policy(True)
        self.assertTrue(panel.update_policy()["auto_update"])

    def test_slot_defaults_to_latest(self):
        self.assertEqual(panel.slot_version("WORLD1")["mode"], "latest")

    def test_pin_without_buildid_pins_the_installed_build(self):
        r = panel.set_slot_version("WORLD1", "pinned")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["buildid"], "17615519")
        self.assertEqual(panel.slot_version("WORLD1")["mode"], "pinned")

    def test_pin_to_an_unobserved_build_is_refused(self):
        r = panel.set_slot_version("WORLD1", "pinned", "12345678")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "conflict")  # no manifests -> not installable

    def test_pin_to_a_recorded_build_is_allowed(self):
        meta = panel._load_update_meta()
        panel._record_build(meta, "17000000", {"2394011": "999888777"}, "appinfo")
        panel._save_update_meta(meta)
        r = panel.set_slot_version("WORLD1", "pinned", "17000000")
        self.assertTrue(r["ok"], r)
        self.assertEqual(panel.resolve_target("WORLD1")["buildid"], "17000000")

    def test_unpin_returns_to_latest(self):
        panel.set_slot_version("WORLD1", "pinned")
        r = panel.set_slot_version("WORLD1", "latest")
        self.assertTrue(r["ok"])
        self.assertIsNone(r["buildid"])
        self.assertNotIn("version", panel._load_slots_meta()["WORLD1"])

    def test_pin_on_unknown_slot_is_404_shaped(self):
        r = panel.set_slot_version("NOPE", "pinned")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "not_found")

    def test_invalid_guid_and_mode_rejected(self):
        self.assertEqual(panel.set_slot_version("../etc", "latest")["reason"], "validation")
        self.assertEqual(panel.set_slot_version("WORLD1", "sideways")["reason"], "validation")

    def test_target_follows_cached_latest_when_unpinned(self):
        meta = panel._load_update_meta()
        meta["latest"] = {"buildid": "17700001", "depots": {}, "checked": "x"}
        panel._save_update_meta(meta)
        self.assertEqual(panel.resolve_target("WORLD1"), {
            "mode": "latest", "buildid": "17700001", "guid": "WORLD1",
        })

    def test_pin_travels_with_a_clone(self):
        panel.set_slot_version("WORLD1", "pinned")
        r = panel.clone_slot("WORLD1", "frozen copy")
        self.assertTrue(r["ok"], r)
        self.assertEqual(panel.slot_version(r["guid"])["buildid"], "17615519")

    def test_history_keeps_pinned_builds_when_pruning(self):
        panel.set_slot_version("WORLD1", "pinned")  # pins 17615519
        saved_keep = panel.UPDATE_HISTORY_KEEP
        panel.UPDATE_HISTORY_KEEP = 3
        try:
            meta = panel._load_update_meta()
            panel._record_build(meta, "17615519", {"2394011": "a"}, "installed")
            for i in range(6):
                panel._record_build(meta, f"1800000{i}", {"2394011": f"m{i}"}, "appinfo")
            panel._save_update_meta(meta)
        finally:
            panel.UPDATE_HISTORY_KEEP = saved_keep
        builds = {b["buildid"] for b in panel.known_builds()}
        self.assertIn("17615519", builds)  # the pinned build survives pruning

    def test_status_payload_shape(self):
        # No steamcmd anywhere: latest is read from the cache, absent here.
        st = panel.version_status()
        self.assertEqual(st["installed"]["buildid"], "17615519")
        self.assertEqual(st["active"]["guid"], "WORLD1")
        self.assertEqual(st["job"]["state"], "idle")
        self.assertIn("builds", st)

    def test_reconcile_declines_without_a_known_target(self):
        r = panel.reconcile_version(reason="test", blocking=True)
        self.assertEqual(r["skipped"], "unknown_target")

    def test_reconcile_is_a_noop_when_already_on_target(self):
        meta = panel._load_update_meta()
        meta["latest"] = {"buildid": "17615519", "depots": {}, "checked": "x"}
        panel._save_update_meta(meta)
        r = panel.reconcile_version(reason="test", blocking=True)
        self.assertTrue(r["up_to_date"])
        self.assertFalse(r["changed"])

    def test_reconcile_respects_auto_update_off(self):
        meta = panel._load_update_meta()
        meta["latest"] = {"buildid": "99999999", "depots": {"2394011": "z"}, "checked": "x"}
        panel._save_update_meta(meta)
        panel.set_update_policy(False)
        r = panel.reconcile_version(reason="test", blocking=True)
        self.assertEqual(r["skipped"], "auto_update_off")

    def test_pinned_target_ignores_auto_update_off(self):
        # An explicit pin is an instruction, not a subscription: turning
        # auto-update off must not strand a save on the wrong build.
        meta = panel._load_update_meta()
        panel._record_build(meta, "17000000", {"2394011": "999888777"}, "appinfo")
        panel._save_update_meta(meta)
        panel.set_slot_version("WORLD1", "pinned", "17000000")
        panel.set_update_policy(False)
        calls = []
        saved = panel.apply_update
        panel.apply_update = lambda **kw: (calls.append(kw), {"ok": True, "changed": True})[1]
        try:
            r = panel.reconcile_version(reason="test", blocking=True)
        finally:
            panel.apply_update = saved
        self.assertTrue(r["changed"])
        self.assertEqual(calls[0]["target"], "17000000")

    # ---- install verification (the false-success bug) ----------------------
    #
    # steamcmd exits 0 on a failed update and only says so in its output, so
    # these drive _install_latest with canned steamcmd results.

    def _fake_steamcmd(self, out):
        class R:
            stdout = out
            stderr = ""
            returncode = 0

        return lambda rest, timeout: R()

    def _patch_install(self, steam_out, acf_build):
        self._saved_run = panel._run_steamcmd
        self._saved_acf = panel._read_appmanifest
        self._saved_size = panel._install_size
        self._saved_free = panel._free_bytes
        self._saved_sleep = panel.time.sleep
        # The escalating strategies touch Steam's cache/downloading dirs; stub
        # them so the suite never writes outside its temp dir.
        self._saved_hooks = (panel._steam_clear_appinfo, panel._steam_clear_downloading)
        self._saved_tail = panel._steam_log_tail
        panel._steam_clear_appinfo = lambda: None
        panel._steam_clear_downloading = lambda: None
        panel._run_steamcmd = self._fake_steamcmd(steam_out)
        panel._read_appmanifest = lambda: {"buildid": acf_build, "depots": {"2394011": "m"}, "updated": 1}
        panel._install_size = lambda: 10 * 1024**3
        panel._free_bytes = lambda: 100 * 1024**3
        panel.time.sleep = lambda *_a: None

    def _unpatch_install(self):
        panel._steam_clear_appinfo, panel._steam_clear_downloading = self._saved_hooks
        panel._steam_log_tail = self._saved_tail
        panel._run_steamcmd = self._saved_run
        panel._read_appmanifest = self._saved_acf
        panel._install_size = self._saved_size
        panel._free_bytes = self._saved_free
        panel.time.sleep = self._saved_sleep

    def _set_latest(self, buildid):
        meta = panel._load_update_meta()
        meta["latest"] = {"buildid": buildid, "depots": {"2394011": "m"}, "checked": "x"}
        panel._save_update_meta(meta)

    def test_steamcmd_state_error_is_a_failure(self):
        # The exact line the live server produced while reporting success.
        self._set_latest("24370498")
        self._patch_install(
            "[  0%] Checking for available updates...\n"
            "Error! App '2394010' state is 0x6 after update job.\n",
            "24181105",
        )
        try:
            r = panel._install_latest()
        finally:
            self._unpatch_install()
        self.assertFalse(r["ok"])
        self.assertEqual(r["state"], "0x6")
        self.assertEqual(r["buildid"], "24181105")  # honest about where we are
        self.assertIn("24370498", r["error"])

    def test_build_not_moving_is_a_failure_even_without_an_error_line(self):
        self._set_latest("24370498")
        self._patch_install("Success! App '2394010' fully installed.\n", "24181105")
        try:
            r = panel._install_latest()
        finally:
            self._unpatch_install()
        self.assertFalse(r["ok"])
        self.assertIn("still on build 24181105", r["error"])

    def test_reaching_the_wanted_build_is_a_success(self):
        self._set_latest("24370498")
        self._patch_install("Success! App '2394010' fully installed.\n", "24370498")
        try:
            r = panel._install_latest()
        finally:
            self._unpatch_install()
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["buildid"], "24370498")
        # Recorded in the marker. installed_version() still prefers the .acf for
        # a non-pinned install, and this test's fixture .acf is untouched.
        self.assertEqual(panel._load_update_meta()["installed"]["buildid"], "24370498")

    def test_strategies_escalate_and_report_which_one_worked(self):
        # The live failure repeated identically, so a plain retry is not enough:
        # later attempts must actually change something (refresh/clear caches).
        self._set_latest("24370498")
        self._patch_install("", "24181105")
        seen = []
        builds = {"cur": "24181105"}

        class R:
            stdout = "Error! App '2394010' state is 0x6 after update job.\n"
            stderr = ""
            returncode = 0

        class OK:
            stdout = "Success! App '2394010' fully installed.\n"
            stderr = ""
            returncode = 0

        def fake_run(rest, timeout):
            seen.append(rest)
            # Succeed only once the appinfo cache has been cleared.
            if cleared["appinfo"]:
                builds["cur"] = "24370498"
                return OK()
            return R()

        cleared = {"appinfo": False}
        panel._run_steamcmd = fake_run
        panel._steam_clear_appinfo = lambda: cleared.__setitem__("appinfo", True)
        panel._read_appmanifest = lambda: {"buildid": builds["cur"], "depots": {"2394011": "m"}, "updated": 1}
        try:
            r = panel._install_latest()
        finally:
            self._unpatch_install()
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["strategy"], "clear-appinfo")
        self.assertEqual(r["tried"], ["plain", "refresh-appinfo", "clear-appinfo"])
        # The 2nd attempt onward must ask Steam to refresh appinfo.
        self.assertIn("+app_info_update", seen[1])
        self.assertNotIn("+app_info_update", seen[0])

    def test_failure_carries_steam_own_logs(self):
        self._set_latest("24370498")
        self._patch_install("Error! App '2394010' state is 0x6 after update job.\n", "24181105")
        panel._steam_log_tail = lambda name, limit=2000: f"<{name}>"
        try:
            r = panel._install_latest()
        finally:
            self._unpatch_install()
        self.assertEqual(r["steam_logs"]["content_log"], "<content_log.txt>")
        self.assertEqual(r["tried"], ["plain", "refresh-appinfo", "clear-appinfo", "clear-downloading"])

    def test_low_disk_refuses_before_running_steamcmd(self):
        self._set_latest("24370498")
        self._patch_install("should not run", "24181105")
        panel._free_bytes = lambda: 1 * 1024**3  # 1 GiB against a 10 GiB install
        calls = []
        panel._run_steamcmd = lambda rest, timeout: calls.append(rest)
        try:
            r = panel._install_latest()
        finally:
            self._unpatch_install()
        self.assertFalse(r["ok"])
        self.assertIn("free space", r["error"])
        self.assertEqual(calls, [])  # never even tried

    def test_failed_install_is_reported_by_reconcile(self):
        self._set_latest("24370498")
        self._patch_install("Error! App '2394010' state is 0x6 after update job.\n", "24181105")
        panel._service_active = lambda: False
        try:
            r = panel.reconcile_version(reason="test", blocking=True)
        finally:
            self._unpatch_install()
        self.assertFalse(r["ok"])
        self.assertEqual(panel.update_job()["state"], "error")

    def test_meta_survives_a_corrupt_file(self):
        with open(panel.UPDATE_META, "w", encoding="utf-8") as f:
            f.write("{not json")
        self.assertTrue(panel.update_policy()["auto_update"])
        panel.set_update_policy(True)
        with open(panel.UPDATE_META, "r", encoding="utf-8") as f:
            self.assertIsInstance(json.load(f), dict)


if __name__ == "__main__":
    unittest.main()
