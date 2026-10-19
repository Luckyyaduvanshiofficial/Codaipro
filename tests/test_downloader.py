"""Tests for the first-run model downloader and its config wiring."""

import http.server
import os
import sys
import tempfile
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dev.config import CodaiConfig, resolve_model_dir  # noqa: E402
from dev.downloader import DownloadError, discard_partial, download_file  # noqa: E402

PAYLOAD = bytes(range(256)) * 4096  # 1 MiB, deterministic


class _Handler(http.server.BaseHTTPRequestHandler):
    payload = PAYLOAD
    supports_range = True
    hit_count = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        type(self).hit_count += 1
        start = 0
        range_header = self.headers.get("Range")
        if range_header and self.supports_range:
            start = int(range_header.split("=")[1].split("-")[0])
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(self.payload) - 1}/{len(self.payload)}")
        else:
            self.send_response(200)
        body = self.payload[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def server():
    _Handler.hit_count = 0
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}/model.gguf"
    httpd.shutdown()
    httpd.server_close()


def test_download_writes_full_file(server):
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "models", "m.gguf")
        progress = []
        download_file(server, dest, on_progress=lambda d, t: progress.append((d, t)))
        assert open(dest, "rb").read() == PAYLOAD
        assert not os.path.exists(dest + ".part")
        assert progress[-1][0] == len(PAYLOAD)
        assert progress[-1][1] == len(PAYLOAD)


def test_download_resumes_from_partial_file(server):
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "m.gguf")
        os.makedirs(tmp, exist_ok=True)
        with open(dest + ".part", "wb") as handle:
            handle.write(PAYLOAD[:5000])
        download_file(server, dest)
        assert open(dest, "rb").read() == PAYLOAD


def test_download_discards_oversized_partial(server):
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "m.gguf")
        with open(dest + ".part", "wb") as handle:
            handle.write(b"x" * (len(PAYLOAD) + 10))
        download_file(server, dest, expected_size=len(PAYLOAD))
        assert open(dest, "rb").read() == PAYLOAD


def test_size_mismatch_raises():
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "m.gguf")
        with open(dest + ".part", "wb") as handle:
            handle.write(b"short")
        with pytest.raises(DownloadError):
            download_file("http://127.0.0.1:1/none", dest, expected_size=999999)
        discard_partial(dest)
        assert not os.path.exists(dest + ".part")


def test_config_accepts_model_url_and_size():
    cfg = CodaiConfig()
    cfg._apply("model_url", "https://example.com/m.gguf", "test")
    cfg._apply("model_size", 1234, "test")
    assert cfg.model_url.endswith("m.gguf")
    assert cfg.model_size == 1234


def test_config_rejects_bad_model_url_and_size():
    cfg = CodaiConfig()
    cfg._apply("model_url", "ftp://example.com/m.gguf", "test")
    cfg._apply("model_size", -5, "test")
    assert cfg.model_url == ""
    assert cfg.model_size == 0


def test_resolve_model_dir_prefers_bundled_then_writable():
    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, "base")
        res = os.path.join(tmp, "res")
        os.makedirs(os.path.join(res, "models"))
        assert resolve_model_dir("a.gguf", base, res) == os.path.join(base, "models")
        open(os.path.join(res, "models", "a.gguf"), "wb").close()
        assert resolve_model_dir("a.gguf", base, res) == os.path.join(res, "models")
