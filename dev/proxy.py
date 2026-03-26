"""
Codai Pro — Unified Reverse Proxy
Serves the local UI, exposes runtime health, and forwards engine requests
through a single hardened gateway.
"""

from __future__ import annotations

import http.server
import json
import logging
import mimetypes
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger("codai.proxy")

MAX_BODY_SIZE = 1024 * 1024  # 1 MB hard cap
STREAM_ENDPOINTS = {"/v1/chat/completions"}
CLIENT_DISCONNECT_ERRORS = (
    BrokenPipeError,
    ConnectionAbortedError,
    ConnectionResetError,
)


class CodaiProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *args: object) -> None:
        # Logging is handled centrally through ``logger``.
        return

    def do_OPTIONS(self) -> None:
        self._ensure_request_id()
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Connection", "close")
        self.send_header("X-Request-Id", self.current_req_id)
        self.close_connection = True
        self.end_headers()

    def do_GET(self) -> None:
        self._ensure_request_id()
        try:
            clean_path = self.path.split("?", 1)[0]

            if clean_path == "/health":
                self._handle_health()
                return

            if clean_path == "/logs":
                self._handle_logs()
                return

            if clean_path == "/":
                if self._serve_static("index.html"):
                    return
            elif clean_path == "/telemetry":
                if self._serve_static("logs.html"):
                    return
            else:
                if self._serve_static(clean_path.lstrip("/")):
                    return

            self._proxy_request("GET")
        except CLIENT_DISCONNECT_ERRORS as exc:
            logger.info("Client disconnected during GET %s: %s", self.path, exc)
        except Exception as exc:  # pragma: no cover - final guard
            logger.exception("Unhandled GET failure: %s", exc)
            self._send_error_response(
                500,
                "proxy_internal_error",
                f"Internal proxy error handling GET request: {exc}",
            )

    def do_POST(self) -> None:
        self._ensure_request_id()
        try:
            clean_path = self.path.split("?", 1)[0]
            if clean_path == "/frontend-error":
                self._handle_frontend_error()
                return
            if clean_path == "/shutdown":
                self._handle_shutdown()
                return

            self._proxy_request("POST")
        except CLIENT_DISCONNECT_ERRORS as exc:
            logger.info("Client disconnected during POST %s: %s", self.path, exc)
        except Exception as exc:  # pragma: no cover - final guard
            logger.exception("Unhandled POST failure: %s", exc)
            self._send_error_response(
                500,
                "proxy_internal_error",
                f"Internal proxy error handling POST request: {exc}",
            )

    def _ensure_request_id(self) -> str:
        if not getattr(self, "current_req_id", None):
            self.current_req_id = uuid.uuid4().hex
        return self.current_req_id

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Request-Id")

    def _build_payload(
        self,
        status: str,
        data: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "request_id": self._ensure_request_id(),
            "data": data or {},
            "error": error,
        }

    def _send_json_response(
        self,
        status_code: int,
        status: str,
        data: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        payload = self._build_payload(status=status, data=data, error=error)
        body = json.dumps(payload).encode("utf-8")

        try:
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.send_header("X-Request-Id", self.current_req_id)
            if extra_headers:
                for key, value in extra_headers.items():
                    self.send_header(key, value)
            self._send_cors_headers()
            self.close_connection = True
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True
            raise

    def _send_error_response(
        self,
        status_code: int,
        error_type: str,
        message: str,
        *,
        status: str = "error",
        extra_headers: dict[str, str] | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        self._send_json_response(
            status_code=status_code,
            status=status,
            data=data,
            error={"type": error_type, "message": message},
            extra_headers=extra_headers,
        )

    def _write_sse_chunk(
        self,
        *,
        status: str,
        data: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        chunk = self._build_payload(status=status, data=data, error=error)
        encoded = f"data: {json.dumps(chunk)}\n\n".encode("utf-8")
        try:
            self.wfile.write(encoded)
            self.wfile.flush()
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True
            raise

    def _get_queue_status(self) -> str:
        semaphore = getattr(self.server, "_queue_semaphore", None)
        if semaphore is None:
            return "available"
        try:
            if semaphore.acquire(blocking=False):
                semaphore.release()
                return "available"
        except Exception:
            logger.debug("Queue status probe failed", exc_info=True)
        return "busy"

    def _check_engine_alive(self) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(0.5)
                return sock.connect_ex((self.server.config.host, self.server.engine_port)) == 0
        except OSError:
            return False

    def _read_request_body(self) -> bytes:
        header_value = self.headers.get("Content-Length", "0")
        try:
            content_length = int(header_value)
        except ValueError as exc:
            raise ValueError("Invalid Content-Length header") from exc

        if content_length < 0:
            raise ValueError("Negative Content-Length header")
        if content_length > MAX_BODY_SIZE:
            raise PayloadTooLargeError("Payload Too Large (1MB limit)")
        if content_length == 0:
            return b""

        body = self.rfile.read(content_length)
        if len(body) != content_length:
            raise ValueError("Incomplete request body received")
        return body

    def _validate_chat_payload(self, body: bytes) -> tuple[dict[str, Any], bool]:
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise ValueError("Invalid Content-Type")

        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError as exc:
            raise ValueError("Malformed JSON payload") from exc

        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("Missing 'messages' array")

        return payload, bool(payload.get("stream"))

    def _safe_resolve_ui_path(self, rel_path: str) -> Path | None:
        ui_root = Path(self.server.base_path, "ui").resolve()
        candidate = (ui_root / rel_path).resolve()
        try:
            candidate.relative_to(ui_root)
        except ValueError:
            logger.warning("Blocked static path traversal attempt: %s", rel_path)
            return None
        return candidate

    def _serve_static(self, rel_path: str) -> bool:
        candidate = self._safe_resolve_ui_path(rel_path)
        if candidate is None or not candidate.is_file():
            return False

        content = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Connection", "close")
        self.send_header("X-Request-Id", self.current_req_id)
        self.close_connection = True
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(content)
        self.wfile.flush()
        return True

    def _handle_health(self) -> None:
        uptime = time.time() - self.server.start_time
        engine_alive = self._check_engine_alive()

        self._send_json_response(
            200,
            "ok",
            data={
                "proxy_port": self.server.server_address[1],
                "engine_port": self.server.engine_port,
                "engine": "running" if engine_alive else "offline",
                "engine_display": self.server.engine_status,
                "proxy": "active",
                "mode": "offline",
                "queue": self._get_queue_status(),
                "uptime": f"{uptime:.1f}s",
                "requests_handled": getattr(self.server, "requests_handled", 0),
                "debug": bool(getattr(self.server.config, "debug", False)),
                "phase": getattr(self.server, "startup_phase", "initializing"),
            },
        )

    def _handle_shutdown(self) -> None:
        client_host = self.client_address[0]
        if client_host not in {"127.0.0.1", "::1"}:
            self._send_error_response(
                403,
                "shutdown_forbidden",
                "Shutdown is only available from the local machine.",
            )
            return

        callback = getattr(self.server, "shutdown_callback", None)
        if callback is None:
            self._send_error_response(
                503,
                "shutdown_unavailable",
                "Runtime shutdown callback is not configured.",
            )
            return

        logger.info("Shutdown requested via local HTTP endpoint.")
        self._send_json_response(
            202,
            "accepted",
            data={"message": "Shutdown requested."},
        )
        threading.Thread(target=callback, daemon=True, name="proxy-shutdown").start()

    def _handle_logs(self) -> None:
        if not getattr(self.server.config, "debug", False):
            self._send_error_response(
                403,
                "forbidden",
                "Access forbidden: debug mode disabled",
            )
            return

        def tail(filepath: Path, lines: int = 150) -> list[str]:
            if not filepath.exists():
                return []
            try:
                with filepath.open("r", encoding="utf-8", errors="replace") as handle:
                    return [line.rstrip("\n") for line in handle.readlines()[-lines:]]
            except OSError:
                return []

        log_dir = Path(self.server.base_path, "logs")
        self._send_json_response(
            200,
            "ok",
            data={
                "codai": tail(log_dir / "codai.log"),
                "engine": tail(log_dir / "engine.log"),
            },
        )

    def _handle_frontend_error(self) -> None:
        try:
            body = self._read_request_body()
        except PayloadTooLargeError as exc:
            self._send_error_response(413, "payload_too_large", str(exc))
            return
        except ValueError as exc:
            self._send_error_response(400, "invalid_request", str(exc))
            return

        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            payload = {"message": body.decode("utf-8", errors="replace")}

        logger.error("[FRONTEND] %s", payload.get("message", "Unknown frontend error"))
        self._send_json_response(200, "ok", data={"accepted": True})

    def _proxy_request(self, method: str) -> None:
        start_time = time.time()
        # Thread-safe increment for requests_handled
        if not hasattr(self.server, "requests_lock"):
            import threading
            self.server.requests_lock = threading.Lock()
        with self.server.requests_lock:
            self.server.requests_handled = getattr(self.server, "requests_handled", 0) + 1

        body = b""
        stream_requested = False
        if method in {"POST", "PUT", "PATCH"}:
            try:
                body = self._read_request_body()
            except PayloadTooLargeError as exc:
                self._send_error_response(413, "payload_too_large", str(exc))
                return
            except ValueError as exc:
                self._send_error_response(400, "invalid_request", str(exc))
                return

        if self.path.split("?", 1)[0] == "/v1/chat/completions":
            try:
                _payload, stream_requested = self._validate_chat_payload(body)
            except ValueError as exc:
                self._send_error_response(400, "invalid_request", str(exc))
                return

        if not self._check_engine_alive():
            self._send_error_response(
                503,
                "engine_unavailable",
                self.server.error_message or "Engine unavailable",
            )
            return

        queue_required = self.path.split("?", 1)[0] in STREAM_ENDPOINTS
        if queue_required and not self.server._queue_semaphore.acquire(blocking=False):
            self._send_error_response(
                429,
                "engine_busy",
                "Engine is processing another request",
                status="busy",
                extra_headers={"Retry-After": "2"},
            )
            return

        lock_acquired = False
        try:
            if queue_required:
                lock_acquired = self.server._engine_lock.acquire(timeout=15)
                if not lock_acquired:
                    self._send_error_response(
                        503,
                        "proxy_lock_timeout",
                        "Proxy lock starved. Request aborted.",
                        status="busy",
                    )
                    return

            self._forward_to_engine(method, body, stream_requested, start_time)
        finally:
            if lock_acquired:
                self.server._engine_lock.release()
            if queue_required:
                self.server._queue_semaphore.release()

    def _forward_to_engine(
        self,
        method: str,
        body: bytes,
        stream_requested: bool,
        start_time: float,
    ) -> None:
        target_url = f"http://{self.server.config.host}:{self.server.engine_port}{self.path}"
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"host", "content-length", "connection"}
        }
        headers["X-Request-Id"] = self.current_req_id

        request = urllib.request.Request(
            target_url,
            data=body or None,
            method=method,
            headers=headers,
        )

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                self._send_upstream_response(response, stream_requested)
                duration = time.time() - start_time
                logger.info(
                    "%s | INFO | [%s] | %.2fs | %s %s %s",
                    datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    self.current_req_id,
                    duration,
                    method,
                    self.path,
                    response.status,
                )
        except urllib.error.HTTPError as exc:
            self._handle_upstream_http_error(exc)
        except urllib.error.URLError as exc:
            message = str(exc.reason)
            if isinstance(exc.reason, socket.timeout):
                message = "Engine took too long to respond (30s timeout)"
            self._send_error_response(502, "proxy_upstream_error", message)

    def _send_upstream_response(
        self,
        response: Any,
        stream_requested: bool,
    ) -> None:
        content_type = response.headers.get("Content-Type", "").lower()
        is_stream = stream_requested or "text/event-stream" in content_type

        if is_stream:
            self._stream_upstream_response(response)
            return

        body = response.read()
        if not body:
            self._send_error_response(
                502,
                "invalid_upstream_response",
                "Engine returned an empty response",
            )
            return

        if "application/json" in content_type:
            try:
                upstream_json = json.loads(body.decode("utf-8"))
            except json.JSONDecodeError:
                self._send_error_response(
                    502,
                    "invalid_upstream_response",
                    "Engine returned invalid JSON",
                )
                return

            self._send_json_response(
                response.status,
                "ok",
                data=upstream_json,
            )
            return

        self.send_response(response.status)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("X-Request-Id", self.current_req_id)
        self.close_connection = True
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def _stream_upstream_response(self, response: Any) -> None:
        try:
            self.send_response(response.status)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("X-Request-Id", self.current_req_id)
            self.close_connection = True
            self._send_cors_headers()
            self.end_headers()
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True
            raise

        chunk_count = 0
        saw_payload = False
        self._write_sse_chunk(
            status="streaming",
            data={"meta": {"request_started": True}},
        )

        while True:
            try:
                raw_line = response.readline()
            except OSError as exc:
                self._write_sse_chunk(
                    status="error",
                    error={
                        "type": "stream_read_error",
                        "message": f"Stream connection dropped: {exc}",
                    },
                )
                return

            if raw_line == b"":
                break

            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line or not line.startswith("data:"):
                continue

            payload_text = line[5:].strip()
            if payload_text == "[DONE]":
                self._write_sse_chunk(status="complete", data={"done": True})
                return

            try:
                upstream_chunk = json.loads(payload_text)
            except json.JSONDecodeError:
                self._write_sse_chunk(
                    status="error",
                    error={
                        "type": "invalid_stream_chunk",
                        "message": "Engine returned malformed stream JSON",
                    },
                )
                return

            saw_payload = True
            chunk_count += 1
            self._write_sse_chunk(status="streaming", data=upstream_chunk)

            if chunk_count % 10 == 0:
                try:
                    import psutil

                    if psutil.virtual_memory().available < 300 * 1024 * 1024:
                        self._write_sse_chunk(
                            status="error",
                            error={
                                "type": "out_of_memory",
                                "message": "Streaming interrupted due to low memory",
                            },
                        )
                        return
                except ImportError:
                    pass

        if not saw_payload:
            self._write_sse_chunk(
                status="error",
                error={
                    "type": "invalid_upstream_response",
                    "message": "Engine returned an empty stream",
                },
            )
            return

        self._write_sse_chunk(status="complete", data={"done": True})

    def _handle_upstream_http_error(self, exc: urllib.error.HTTPError) -> None:
        body = exc.read()
        content_type = exc.headers.get("Content-Type", "").lower()

        if not body:
            self._send_error_response(
                exc.code,
                "upstream_http_error",
                f"Engine returned HTTP {exc.code} with an empty body",
            )
            return

        upstream_data: dict[str, Any] = {}
        message = f"Engine returned HTTP {exc.code}"

        if "application/json" in content_type:
            try:
                upstream_json = json.loads(body.decode("utf-8"))
            except json.JSONDecodeError:
                self._send_error_response(
                    502,
                    "invalid_upstream_response",
                    "Engine returned invalid JSON in an error response",
                )
                return

            upstream_data = {"upstream": upstream_json}
            if isinstance(upstream_json, dict):
                nested_error = upstream_json.get("error")
                if isinstance(nested_error, dict):
                    message = str(nested_error.get("message", message))
        else:
            message = body.decode("utf-8", errors="replace").strip() or message

        self._send_error_response(
            exc.code,
            "upstream_http_error",
            message,
            data=upstream_data,
        )


class CodaiProxyServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = False

    def __init__(
        self,
        server_address: tuple[str, int],
        request_handler_class: type[http.server.BaseHTTPRequestHandler],
        config: Any,
        base_path: str,
        engine_port: int = 8081,
        shutdown_callback: Any = None,
    ) -> None:
        super().__init__(server_address, request_handler_class)
        self.config = config
        self.base_path = base_path
        self.engine_port = engine_port
        self.shutdown_callback = shutdown_callback
        self.engine_status = "initializing"
        self.startup_phase = "initializing"
        self.error_message = ""
        self.start_time = time.time()
        self.requests_handled = 0
        self._queue_semaphore = threading.Semaphore(2)
        self._engine_lock = threading.Lock()


class PayloadTooLargeError(ValueError):
    """Raised when a request exceeds the configured body limit."""
