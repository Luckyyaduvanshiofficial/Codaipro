"""
Codai Pro — Engine Module
Manages the llama-server subprocess lifecycle with startup validation,
health monitoring, crash recovery, and safe shutdown semantics.
"""

from __future__ import annotations

import http.client
import logging
import os
import socket
import stat
import subprocess
import threading
import time
from typing import Callable, Optional

import psutil

from dev.config import (
    ENGINE_READY_TIMEOUT,
    GRACEFUL_SHUTDOWN_TIMEOUT,
    HEALTH_CHECK_INTERVAL,
    LOG_MAX_BYTES,
    MAX_RESTART_ATTEMPTS,
    RESTART_DELAYS,
    RESTART_READY_TIMEOUT,
    STABLE_RUN_SECONDS,
    CodaiConfig,
    ensure_log_directory,
    get_engine_binary_name,
)
from dev.downloader import DownloadError, download_file

logger = logging.getLogger("codai.engine")

LOCK_FILENAME = "codai.lock"
_LOCK_CREATE_TIME_TOLERANCE = 1.0


class EngineManager:
    """Manages the llama-server subprocess lifecycle."""

    def __init__(
        self,
        config: CodaiConfig,
        base_path: str,
        engine_port: int,
        on_crash: Optional[Callable[[str], None]] = None,
        on_status_change: Optional[Callable[[str], None]] = None,
        resource_path: Optional[str] = None,
    ) -> None:
        self.config = config
        self.base_path = base_path
        self.resource_path = resource_path or base_path
        self.engine_port = engine_port
        self.process: Optional[subprocess.Popen] = None
        self._log_file_handle = None
        self._health_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._restart_count = 0
        self._healthy_since: Optional[float] = None
        self._on_crash = on_crash
        self._on_status_change = on_status_change
        self._lock = threading.Lock()
        self._is_shutting_down = False
        self._instance_lock_acquired = False
        self._lock_path = os.path.join(ensure_log_directory(base_path), LOCK_FILENAME)

    # ------------------------------------------------------------------
    # Instance lock
    # ------------------------------------------------------------------
    def _read_lock(self) -> Optional[tuple[int, Optional[float]]]:
        try:
            with open(self._lock_path, "r", encoding="utf-8") as handle:
                fields = handle.read().split()
        except OSError:
            return None
        try:
            pid = int(fields[0])
        except (IndexError, ValueError):
            return None
        create_time: Optional[float] = None
        if len(fields) > 1:
            try:
                create_time = float(fields[1])
            except ValueError:
                create_time = None
        return pid, create_time

    @staticmethod
    def _lock_owner_alive(pid: int, create_time: Optional[float]) -> bool:
        """True only if *pid* is alive and is the same process that wrote the lock."""
        try:
            proc = psutil.Process(pid)
        except psutil.NoSuchProcess:
            return False
        except psutil.AccessDenied:
            return True
        if create_time is None:
            return True
        try:
            return abs(proc.create_time() - create_time) < _LOCK_CREATE_TIME_TOLERANCE
        except psutil.AccessDenied:
            return True
        except psutil.NoSuchProcess:
            return False

    def acquire_instance_lock(self) -> None:
        """Atomically create the PID lock file; fail if a live instance owns it."""
        own_pid = os.getpid()
        own_create_time = psutil.Process(own_pid).create_time()
        payload = f"{own_pid}\n{own_create_time}\n".encode("utf-8")

        for _attempt in range(3):
            try:
                fd = os.open(self._lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                existing = self._read_lock()
                if existing is not None:
                    pid, create_time = existing
                    if pid != own_pid and self._lock_owner_alive(pid, create_time):
                        raise RuntimeError(
                            f"Another Codai instance is already running (PID {pid})."
                        )
                logger.warning("Stale lock file found. Reclaiming it.")
                try:
                    os.unlink(self._lock_path)
                except FileNotFoundError:
                    pass
                continue
            except OSError as exc:
                raise RuntimeError(f"Cannot write lock file: {exc}") from exc

            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
            self._instance_lock_acquired = True
            logger.info("Instance lock acquired (PID %d).", own_pid)
            return

        raise RuntimeError("Could not acquire the instance lock; another instance is starting.")

    def release_instance_lock(self) -> None:
        if not self._instance_lock_acquired:
            return
        try:
            existing = self._read_lock()
            if existing is not None and existing[0] == os.getpid():
                os.unlink(self._lock_path)
                logger.info("Instance lock released.")
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("Could not remove lock file: %s", exc)
        finally:
            self._instance_lock_acquired = False

    # ------------------------------------------------------------------
    # Status and port helpers
    # ------------------------------------------------------------------
    def _notify_status(self, status: str) -> None:
        if self._on_status_change:
            self._on_status_change(status)

    @staticmethod
    def is_server_running(host: str, port: int) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(1)
                return sock.connect_ex((host, port)) == 0
        except (OSError, OverflowError):
            return False

    def check_port_available(self) -> None:
        if self.is_server_running(self.config.host, self.engine_port):
            raise RuntimeError(
                f"Port {self.engine_port} is already in use on {self.config.host}."
            )
        logger.info("Port %d is available on %s.", self.engine_port, self.config.host)

    # ------------------------------------------------------------------
    # Log file handling
    # ------------------------------------------------------------------
    def _open_log_file(self) -> None:
        self._close_log_file()
        log_dir = ensure_log_directory(self.base_path)
        log_path = os.path.join(log_dir, "engine.log")
        try:
            if os.path.getsize(log_path) > LOG_MAX_BYTES:
                os.replace(log_path, log_path + ".1")
        except OSError:
            pass
        self._log_file_handle = open(log_path, "a", encoding="utf-8")
        logger.info("Engine log -> %s", log_path)

    def _close_log_file(self) -> None:
        if self._log_file_handle is not None:
            try:
                if not self._log_file_handle.closed:
                    self._log_file_handle.close()
            finally:
                self._log_file_handle = None

    # ------------------------------------------------------------------
    # Boot
    # ------------------------------------------------------------------
    def _validate_binary(self, engine_path: str) -> None:
        if not os.path.exists(engine_path):
            raise FileNotFoundError(f"Missing engine binary: {engine_path}")

        file_stat = os.stat(engine_path)
        if file_stat.st_size == 0:
            raise RuntimeError(f"Engine binary appears corrupted: {engine_path}")

        if os.name != "nt":
            if not file_stat.st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
                raise PermissionError(f"Engine binary is not executable: {engine_path}")

        if not os.access(engine_path, os.R_OK):
            raise PermissionError(f"Engine binary is not readable: {engine_path}")

    def _ensure_model(self) -> str:
        """Return the model path, downloading it on first run when a URL is configured."""
        name = self.config.model_name
        bundled = os.path.join(self.resource_path, "models", name)
        if os.path.exists(bundled):
            return bundled

        target = os.path.join(self.base_path, "models", name)
        if os.path.exists(target):
            return target

        if not self.config.model_url:
            raise FileNotFoundError(
                f"Missing model file: {target}\n"
                f"Please download {name} into the models/ folder, "
                f"or set model_url in config.json for automatic download."
            )

        logger.info("Model %s not found; downloading from %s", name, self.config.model_url)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        self._notify_status("downloading")

        last_report = [0.0]

        def on_progress(downloaded: int, total: int) -> None:
            now = time.monotonic()
            if now - last_report[0] < 2.0 and (total <= 0 or downloaded < total):
                return
            last_report[0] = now
            if total > 0:
                percent = downloaded * 100 // total
                logger.info(
                    "Downloading model: %d%% (%d of %d MB)",
                    percent, downloaded // (1024 * 1024), total // (1024 * 1024),
                )
            else:
                logger.info("Downloading model: %d MB", downloaded // (1024 * 1024))

        try:
            download_file(
                self.config.model_url,
                target,
                on_progress=on_progress,
                expected_size=self.config.model_size or None,
            )
        except DownloadError as exc:
            logger.error("Model download failed: %s", exc)
            raise FileNotFoundError(
                f"Could not download {name}: {exc}\n"
                f"Download {self.config.model_url} manually into {os.path.dirname(target)}."
            ) from exc

        logger.info("Model downloaded -> %s", target)
        return target

    def boot(self) -> None:
        """Start the inference engine subprocess and validate it stays alive."""
        binary_name = get_engine_binary_name()
        engine_path = os.path.join(self.resource_path, "engine", binary_name)
        model_path = self._ensure_model()

        self._validate_binary(engine_path)

        cmd = [
            engine_path,
            "-m",
            model_path,
            "-c",
            str(self.config.ctx),
            "-t",
            str(self.config.threads),
            "--threads-http",
            "1",
            "-np",
            "1",
            "--port",
            str(self.engine_port),
            "--host",
            self.config.host,
        ]

        self._notify_status("starting")
        logger.info("Booting AI engine...")

        try:
            self._open_log_file()
            with self._lock:
                if self._is_shutting_down:
                    raise RuntimeError("Shutdown requested; engine will not be started.")
                self.process = subprocess.Popen(
                    cmd,
                    stdout=self._log_file_handle,
                    stderr=self._log_file_handle,
                )
                process = self.process

            time.sleep(0.5)
            if process.poll() is not None:
                raise RuntimeError(
                    f"Engine process exited immediately with code {process.returncode}."
                )

            logger.info("Engine PID: %d", process.pid)
        except Exception:
            self._cleanup_process(close_log=True)
            self._notify_status("failed")
            raise

    def _engine_http_ready(self) -> bool:
        """Return True when llama-server reports HTTP 200 on /health.

        The engine binds its port before the model finishes loading and answers
        503 until it can serve requests, so a TCP check alone is not enough.
        """
        connection = http.client.HTTPConnection(
            self.config.host, self.engine_port, timeout=2.0
        )
        try:
            connection.request("GET", "/health")
            response = connection.getresponse()
            response.read()
            return response.status == 200
        except (OSError, http.client.HTTPException):
            return False
        finally:
            connection.close()

    def wait_for_ready(self, timeout: int = ENGINE_READY_TIMEOUT) -> None:
        logger.info("Waiting for engine to become ready (timeout=%ds)...", timeout)
        started = time.time()
        delays = iter((0.2, 0.5, 1.0))
        delay = next(delays)

        while not (
            self.is_server_running(self.config.host, self.engine_port)
            and self._engine_http_ready()
        ):
            if self._stop_event.is_set():
                self._notify_status("failed")
                raise RuntimeError("Engine startup cancelled: shutdown requested.")
            if time.time() - started > timeout:
                self._notify_status("failed")
                raise TimeoutError(
                    f"Engine did not become ready on port {self.engine_port} within "
                    f"{timeout}s (the model may still be loading)."
                )

            with self._lock:
                process = self.process
            if process is not None and process.poll() is not None:
                self._notify_status("failed")
                raise RuntimeError(
                    f"Engine process exited prematurely with code {process.returncode}."
                )

            time.sleep(delay)
            delay = next(delays, 1.0)

        self._healthy_since = time.monotonic()
        self._notify_status("running")
        logger.info("Engine online and operational.")

    # ------------------------------------------------------------------
    # Shutdown
    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        with self._lock:
            self._is_shutting_down = True
        self._stop_event.set()
        self._notify_status("shutting_down")

        if self._health_thread and self._health_thread.is_alive():
            self._health_thread.join(timeout=2)

        with self._lock:
            process = self.process

        if process is not None:
            logger.info("Graceful shutdown initiated (PID %d)...", process.pid)
            try:
                process.terminate()
                try:
                    process.wait(timeout=GRACEFUL_SHUTDOWN_TIMEOUT)
                    logger.info("Engine terminated gracefully.")
                except subprocess.TimeoutExpired:
                    logger.warning(
                        "Engine did not exit in %ds - forcing kill.",
                        GRACEFUL_SHUTDOWN_TIMEOUT,
                    )
                    process.kill()
                    process.wait(timeout=5)
                    logger.info("Engine killed forcefully.")
            except Exception as exc:
                logger.warning("Shutdown warning: %s", exc)
            finally:
                self._cleanup_process(close_log=True)
        else:
            self._close_log_file()

        self.release_instance_lock()
        self._notify_status("stopped")
        logger.info("Engine shutdown complete.")

    # ------------------------------------------------------------------
    # Health monitoring and recovery
    # ------------------------------------------------------------------
    def start_health_monitor(self) -> None:
        with self._lock:
            self._is_shutting_down = False
        self._stop_event.clear()
        self._restart_count = 0
        self._health_thread = threading.Thread(
            target=self._health_monitor_loop,
            daemon=True,
            name="engine-health",
        )
        self._health_thread.start()
        logger.info("Health monitor started (interval=%ds).", HEALTH_CHECK_INTERVAL)

    def _is_shutting_down_now(self) -> bool:
        with self._lock:
            return self._is_shutting_down

    def _health_monitor_loop(self) -> None:
        while not self._stop_event.wait(timeout=HEALTH_CHECK_INTERVAL):
            if self._is_shutting_down_now():
                return

            with self._lock:
                process = self.process

            process_alive = process is not None and process.poll() is None
            port_ok = process_alive and self.is_server_running(
                self.config.host, self.engine_port
            )

            if port_ok:
                self._reset_budget_if_stable()
                continue

            if process_alive:
                logger.warning(
                    "Engine process is alive but port %d is not responsive.",
                    self.engine_port,
                )
                if self._stop_event.wait(timeout=HEALTH_CHECK_INTERVAL):
                    return
                if self.is_server_running(self.config.host, self.engine_port):
                    continue

            if self._is_shutting_down_now():
                return

            reason = (
                f"Engine unhealthy (alive={process_alive}, "
                f"exit_code={process.poll() if process is not None else None})."
            )
            logger.error(reason)
            if not self._recover_engine(reason):
                return

    def _reset_budget_if_stable(self) -> None:
        if (
            self._restart_count
            and self._healthy_since is not None
            and time.monotonic() - self._healthy_since >= STABLE_RUN_SECONDS
        ):
            logger.info("Engine stable for %ds; restart budget reset.", STABLE_RUN_SECONDS)
            self._restart_count = 0

    def _recover_engine(self, reason: str) -> bool:
        """Restart the engine until it is healthy or the budget is spent.

        Returns True if the engine came back, False if monitoring should stop.
        """
        self._healthy_since = None
        self._notify_status("crashed")
        self._cleanup_process(close_log=True)

        while True:
            if self._restart_count >= MAX_RESTART_ATTEMPTS:
                message = (
                    f"Engine failed to recover after {MAX_RESTART_ATTEMPTS} restart attempts. "
                    f"Last error: {reason}"
                )
                logger.critical(message)
                if self._on_crash:
                    self._on_crash(message)
                return False

            delay = RESTART_DELAYS[min(self._restart_count, len(RESTART_DELAYS) - 1)]
            self._restart_count += 1
            self._notify_status("restarting")
            logger.warning(
                "Auto-restart attempt %d/%d in %.1fs...",
                self._restart_count,
                MAX_RESTART_ATTEMPTS,
                delay,
            )

            if self._stop_event.wait(timeout=delay):
                return False

            try:
                self.boot()
                self.wait_for_ready(timeout=RESTART_READY_TIMEOUT)
                logger.info("Engine restarted successfully.")
                return True
            except Exception as exc:
                reason = str(exc)
                logger.error("Auto-restart attempt failed: %s", exc)
                self._cleanup_process(close_log=True)
                if self._is_shutting_down_now():
                    return False

    def _cleanup_process(self, *, close_log: bool) -> None:
        with self._lock:
            process = self.process
            self.process = None

        if process is not None and process.poll() is None:
            try:
                process.kill()
                process.wait(timeout=5)
            except Exception:
                logger.debug("Process cleanup warning", exc_info=True)

        if close_log:
            self._close_log_file()
