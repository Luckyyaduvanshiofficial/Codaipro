"""Regression tests for the Codai runtime security and reliability fixes."""

from __future__ import annotations

import http.client
import http.server
import json
import os
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dev.config import CodaiConfig  # noqa: E402
from dev.proxy import CodaiProxyHandler, CodaiProxyServer  # noqa: E402
from dev import system as system_module  # noqa: E402

TOKEN = "test-token-123"


# ---------------------------------------------------------------------------
# Configuration validation
# ---------------------------------------------------------------------------

class TestConfigValidation:
    def test_defaults_are_loopback(self):
        assert CodaiConfig().host == "127.0.0.1"

    def test_non_loopback_host_is_rejected(self, tmp_path, monkeypatch):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"host": "0.0.0.0"}))
        cfg = CodaiConfig()
        cfg.load_from_file(str(cfg_file))
        assert cfg.host == "127.0.0.1"

    def test_env_host_override_rejected_for_lan(self, monkeypatch):
        monkeypatch.setenv("CODAI_HOST", "0.0.0.0")
        cfg = CodaiConfig()
        cfg.load_from_env()
        assert cfg.host == "127.0.0.1"

    @pytest.mark.parametrize("port", ["8080", 80, 70000, True, None])
    def test_invalid_port_types_or_ranges_are_ignored(self, tmp_path, port):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"port": port}))
        cfg = CodaiConfig()
        cfg.load_from_file(str(cfg_file))
        assert cfg.port == 8080

    def test_model_name_path_traversal_is_rejected(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"model_name": "../../evil.gguf"}))
        cfg = CodaiConfig()
        cfg.load_from_file(str(cfg_file))
        assert cfg.model_name == "gemma-3-1b-it-Q4_K_M.gguf"

    def test_non_object_json_is_rejected(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text("null")
        cfg = CodaiConfig()
        assert cfg.load_from_file(str(cfg_file)) is False
        assert cfg.port == 8080

    def test_valid_file_values_apply_and_record_overrides(self, tmp_path):
        cfg_file = tmp_path / "config.json"
        cfg_file.write_text(json.dumps({"port": 9000, "threads": 3, "log_level": "debug"}))
        cfg = CodaiConfig()
        cfg.load_from_file(str(cfg_file))
        assert cfg.port == 9000
        assert cfg.threads == 3
        assert cfg.log_level == "DEBUG"
        assert {"port", "threads", "log_level"} <= cfg.overrides

    def test_env_threads_survives_hardware_tuning(self, monkeypatch):
        monkeypatch.setenv("CODAI_THREADS", "1")
        cfg = CodaiConfig()
        cfg.load_from_env()
        system_module.analyze_system_resources(cfg)
        assert cfg.threads == 1


# ---------------------------------------------------------------------------
# Proxy security (live server on loopback)
# ---------------------------------------------------------------------------

class _FakeEngineHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        body = b'{"ok": true}'
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def proxy_server(tmp_path):
    (tmp_path / "ui").mkdir()
    (tmp_path / "ui" / "index.html").write_text("<html><head></head><body>hi</body></html>")
    (tmp_path / "ui" / "secret.js").write_text("console.log(1)")
    (tmp_path / "logs").mkdir()

    cfg = CodaiConfig()
    cfg.debug = False
    shutdown_calls = []

    server = CodaiProxyServer(
        ("127.0.0.1", 0),
        CodaiProxyHandler,
        cfg,
        str(tmp_path),
        engine_port=1,
        api_token=TOKEN,
        shutdown_callback=lambda: shutdown_calls.append(True),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.shutdown_calls = shutdown_calls
    yield server
    server.shutdown()
    server.server_close()


def _request(server, method, path, *, headers=None, body=None):
    port = server.server_address[1]
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, dict(resp.getheaders()), resp.read()
    finally:
        conn.close()


class TestProxySecurity:
    def test_no_wildcard_cors_header(self, proxy_server):
        status, headers, _ = _request(proxy_server, "GET", "/health")
        assert status == 200
        assert "Access-Control-Allow-Origin" not in headers

    def test_api_route_requires_token(self, proxy_server):
        status, _, body = _request(proxy_server, "GET", "/logs")
        assert status == 401
        assert json.loads(body)["error"]["type"] == "unauthorized"

    def test_shutdown_requires_token(self, proxy_server):
        status, _, _ = _request(proxy_server, "POST", "/shutdown", headers={"Content-Length": "0"})
        assert status == 401
        assert proxy_server.shutdown_calls == []

    def test_shutdown_with_token_is_accepted(self, proxy_server):
        status, _, _ = _request(
            proxy_server,
            "POST",
            "/shutdown",
            headers={"Content-Length": "0", "X-Codai-Token": TOKEN},
        )
        assert status == 202

    def test_wrong_token_is_rejected(self, proxy_server):
        status, _, _ = _request(
            proxy_server,
            "POST",
            "/shutdown",
            headers={"Content-Length": "0", "X-Codai-Token": "nope"},
        )
        assert status == 401

    def test_foreign_host_header_is_rejected(self, proxy_server):
        status, _, body = _request(
            proxy_server,
            "GET",
            "/health",
            headers={"Host": "evil.example:8080"},
        )
        assert status == 403
        assert json.loads(body)["error"]["type"] == "forbidden_host"

    def test_index_page_gets_token_meta_tag(self, proxy_server):
        status, _, body = _request(proxy_server, "GET", "/")
        assert status == 200
        assert f'content="{TOKEN}"'.encode() in body

    def test_static_asset_is_served_without_token(self, proxy_server):
        status, _, body = _request(proxy_server, "GET", "/secret.js")
        assert status == 200
        assert b"console.log" in body

    def test_static_path_traversal_is_blocked(self, proxy_server):
        status, _, _ = _request(proxy_server, "GET", "/..%2F..%2Fetc%2Fpasswd")
        assert status in {401, 404}

    def test_chunked_body_is_rejected_with_411(self, proxy_server):
        status, _, body = _request(
            proxy_server,
            "POST",
            "/v1/chat/completions",
            headers={
                "Transfer-Encoding": "chunked",
                "Content-Type": "application/json",
                "X-Codai-Token": TOKEN,
            },
            body=b"0\r\n\r\n",
        )
        assert status == 411
        assert json.loads(body)["error"]["type"] == "length_required"

    def test_upstream_error_message_is_generic_on_internal_failure(self, proxy_server):
        status, _, body = _request(
            proxy_server,
            "POST",
            "/v1/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Content-Length": "2",
                "X-Codai-Token": TOKEN,
            },
            body=b"{}",
        )
        assert status == 400
        assert json.loads(body)["error"]["type"] == "invalid_request"


# ---------------------------------------------------------------------------
# Engine lock
# ---------------------------------------------------------------------------

class TestInstanceLock:
    def test_second_instance_is_blocked_by_live_owner(self, tmp_path):
        import psutil
        import subprocess
        from dev.engine import EngineManager, LOCK_FILENAME

        owner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            (tmp_path / "logs").mkdir()
            create_time = psutil.Process(owner.pid).create_time()
            (tmp_path / "logs" / LOCK_FILENAME).write_text(f"{owner.pid}\n{create_time}\n")
            mgr = EngineManager(CodaiConfig(), str(tmp_path), engine_port=8081)
            with pytest.raises(RuntimeError, match="already running"):
                mgr.acquire_instance_lock()
        finally:
            owner.kill()
            owner.wait()

    def test_stale_lock_from_dead_pid_is_reclaimed(self, tmp_path):
        from dev.engine import EngineManager, LOCK_FILENAME

        lock_dir = tmp_path / "logs"
        lock_dir.mkdir()
        (lock_dir / LOCK_FILENAME).write_text("999999999\n0\n")
        mgr = EngineManager(CodaiConfig(), str(tmp_path), engine_port=8081)
        mgr.acquire_instance_lock()
        assert (lock_dir / LOCK_FILENAME).read_text().split()[0] == str(os.getpid())
        mgr.release_instance_lock()

    def test_reused_pid_with_different_start_time_is_reclaimed(self, tmp_path):
        from dev.engine import EngineManager, LOCK_FILENAME

        lock_dir = tmp_path / "logs"
        lock_dir.mkdir()
        (lock_dir / LOCK_FILENAME).write_text(f"{os.getpid()}\n1.0\n")
        mgr = EngineManager(CodaiConfig(), str(tmp_path), engine_port=8081)
        mgr.acquire_instance_lock()
        mgr.release_instance_lock()

    def test_release_does_not_delete_another_owners_lock(self, tmp_path):
        from dev.engine import EngineManager, LOCK_FILENAME

        mgr = EngineManager(CodaiConfig(), str(tmp_path), engine_port=8081)
        mgr.acquire_instance_lock()
        lock_path = tmp_path / "logs" / LOCK_FILENAME
        lock_path.write_text("1\n0\n")
        mgr.release_instance_lock()
        assert lock_path.exists()
