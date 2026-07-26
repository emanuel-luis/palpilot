"""Static console routing in main.py: assets, SPA fallback, and the guarantee
that none of it opened a hole in the API's auth gate.

main.py imports the GCP SDKs at module scope, so those are stubbed — the routing
under test is pure stdlib. Run from the repo root or from coordinator/.
"""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_COORDINATOR = os.path.dirname(_HERE)


def _stub_cloud_sdks():
    def mod(name, **attrs):
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m
        return m

    mod("functions_framework", http=lambda fn: fn)
    mod("requests", get=None, post=None, request=None)
    google = mod("google")
    cloud = mod("google.cloud")
    cloud.compute_v1 = mod("google.cloud.compute_v1", InstancesClient=object)
    cloud.storage = mod("google.cloud.storage", Client=object)
    google.cloud = cloud
    mod("nacl")
    mod("nacl.signing", VerifyKey=object)
    mod("nacl.exceptions", BadSignatureError=Exception)


REQUIRED_ENV = (
    "PROJECT_ID", "VM_ZONE", "VM_INSTANCE", "VM_IP", "VM_PORT",
    "GAME_PORT", "PANEL_BUCKET", "PANEL_USER", "PANEL_PASSWORD", "INTERNAL_TOKEN",
)


def _import_main():
    _stub_cloud_sdks()
    for key in REQUIRED_ENV:
        os.environ.setdefault(key, "test")
    if _COORDINATOR not in sys.path:
        sys.path.insert(0, _COORDINATOR)
    import main  # noqa: PLC0415

    return main


main = _import_main()


class _Req:
    def __init__(self, path, method="GET"):
        self.path = path
        self.method = method
        self.headers = {}
        self.authorization = None
        self.args = {}

    def get_json(self, silent=False):
        return {}


def call(path, method="GET"):
    """-> (status, headers, body)"""
    r = main.coordinator(_Req(path, method))
    if isinstance(r, tuple):
        body, status = r[0], r[1]
        headers = r[2] if len(r) > 2 else {}
        return status, headers, body
    return 200, {}, r


def _an_asset():
    d = os.path.join(_COORDINATOR, "assets")
    if not os.path.isdir(d):
        return None
    return next((f for f in os.listdir(d) if f.endswith(".js")), None)


class TestAppShell(unittest.TestCase):
    def test_root_serves_html(self):
        status, headers, _ = call("/")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "text/html; charset=utf-8")

    def test_shell_is_never_cached(self):
        # A cached shell gated on stale permissions would silently hide sections.
        _, headers, _ = call("/")
        self.assertEqual(headers.get("Cache-Control"), "no-store, must-revalidate")

    def test_client_routes_fall_back_to_the_shell(self):
        for path in ("/console", "/users", "/users/roles", "/account"):
            status, headers, _ = call(path)
            self.assertEqual(status, 200, path)
            self.assertEqual(headers.get("Content-Type"), "text/html; charset=utf-8", path)

    def test_fallback_is_get_only(self):
        # A POST to a client route is not a navigation; it must not get the shell.
        status, _, _ = call("/console", "POST")
        self.assertEqual(status, 401)


@unittest.skipIf(_an_asset() is None, "no built assets; run the frontend build first")
class TestAssets(unittest.TestCase):
    def test_hashed_asset_is_served_with_type_and_immutable_cache(self):
        status, headers, body = call(f"/assets/{_an_asset()}")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "text/javascript; charset=utf-8")
        # Safe because Vite puts a content hash in every filename.
        self.assertEqual(headers.get("Cache-Control"), "public, max-age=31536000, immutable")
        self.assertIsInstance(body, bytes)

    def test_traversal_cannot_escape_the_assets_directory(self):
        for path in ("/assets/../main.py", "/assets/../../startup.sh", "/assets/./../main.py"):
            status, _, _ = call(path)
            self.assertEqual(status, 404, path)

    def test_missing_asset_is_404(self):
        status, _, _ = call("/assets/does-not-exist.js")
        self.assertEqual(status, 404)


class TestAuthGateIntact(unittest.TestCase):
    def test_api_is_still_gated(self):
        for path in ("/api/overview", "/api/saves", "/api/users", "/api/nope"):
            status, _, _ = call(path)
            self.assertEqual(status, 401, path)

    def test_missing_file_404s_instead_of_demanding_auth(self):
        # 401 carries WWW-Authenticate: Basic, which can pop a browser credential
        # prompt over something as incidental as a missing favicon.
        for path in ("/favicon.ico", "/robots.txt", "/nope.png"):
            status, _, _ = call(path)
            self.assertEqual(status, 404, path)


class TestRouteClassifier(unittest.TestCase):
    def test_api_is_never_an_app_route(self):
        self.assertFalse(main._is_app_route("/api/overview"))

    def test_dotted_last_segment_is_a_file_not_a_route(self):
        self.assertFalse(main._is_app_route("/favicon.ico"))
        self.assertTrue(main._is_app_route("/console"))
        self.assertTrue(main._is_app_route("/a/b/c"))


if __name__ == "__main__":
    unittest.main()
