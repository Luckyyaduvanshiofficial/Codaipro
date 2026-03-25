"""
Codai Pro — Engine Module
Manages the llama-server subprocess lifecycle with startup validation,
health monitoring, and safe shutdown semantics.
"""

from __future__ import annotations

import logging
import os
import socket
import stat
import subprocess
import threading
import time
from typing import Callable, Optional

from dev.config import (
    GRACEFUL_SHUTDOWN_TIMEOUT,
    HEALTH_CHECK_INTERVAL,
    MAX_RESTART_ATTEMPTS,
    RESTART_DELAYS,
    CodaiConfig,
    ensure_log_directory,
    get_engine_binary_name,
)

logger = logging.getLogger("codai.engine")


class EngineManager:
    """Manages the llama-server subprocess lifecycle."""

    def __init__(
        self,
        config: CodaiConfig,
        base_path: str,
        engine_port: int,
        on_crash: Optional[Callable[[str], None]] = None,
        on_status_change: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.config = config
        self.base_path = base_path
        self.engine_port = engine_port
        self.process: Optional[subprocess.Popen] = None
        self._log_file_handle = None
        self._health_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._restart_count = 0
        self._on_crash = on_crash
        self._on_status_change = on_status_change
        self._lock = threading.Lock()
        self._is_shutting_down = False
        self._instance_lock_acquired = False
        self._lock_path = os.path.join(ensure_log_directory(base_path), "codai.lock")

    def acquire_instance_lock(self) -> None:
        """Create a PID lock file; fail if another instance is running."""
        if os.path.isfile(self._lock_path):
            try:
                with open(self._lock_path, "r", encoding="utf-8") as handle:
                    existing_pid = int(handle.read().strip())
            except (OSError, ValueError):
                logger.warning("Invalid existing lock file found. Reclaiming it.")
            else:
                try:
                    import psutil

                    if psutil.pid_exists(existing_pid) and existing_pid != os.getpid():
                        raise RuntimeError(
                            f"Another Codai instance is already running (PID {existing_pid})."
                        )
                except ImportError:
                    if existing_pid != os.getpid():
                        raise RuntimeError(
                            f"Another Codai instance may already be running (PID {existing_pid})."
                        )

                logger.warning("Stale lock file found for PID %s. Reclaiming.", existing_pid)

        try:
            with open(self._lock_path, "w", encoding="utf-8") as handle:
                handle.write(str(os.getpid()))
            self._instance_lock_acquired = True
            logger.info("Instance lock acquired (PID %d).", os.getpid())
        except OSError as exc:
            raise RuntimeError(f"Cannot write lock file: {exc}") from exc

    def release_instance_lock(self) -> None:
        if not self._instance_lock_acquired:
            return
        try:
            if os.path.isfile(self._lock_path):
                os.unlink(self._lock_path)
                logger.info("Instance lock released.")
        except OSError as exc:
            logger.warning("Could not remove lock file: %s", exc)
        finally:
            self._instance_lock_acquired = False

    def _notify_status(self, status: str) -> None:
        if self._on_status_change:
            self._on_status_change(status)

    @staticmethod
    def is_server_running(host: str, port: int) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(1)
                return sock.connect_ex((host, port)) == 0
        except OSError:
            return False

    def check_port_available(self) -> None:
        if self.is_server_running(self.config.host, self.engine_port):
            raise RuntimeError(
                f"Port {self.engine_port} is already in use on {self.config.host}."
            )
        logger.info("Port %d is available on %s.", self.engine_port, self.config.host)

    def _open_log_file(self) -> None:
        self._close_log_file()
        log_dir = ensure_log_directory(self.base_path)
        log_path = os.path.join(log_dir, "engine.log")
        self._log_file_handle = open(log_path, "a", encoding="utf-8")
        logger.info("Engine log -> %s", log_path)

    def _close_log_file(self) -> None:
        if self._log_file_handle is not None:
            try:
                if not self._log_file_handle.closed:
                    self._log_file_handle.close()
            finally:
                self._log_file_handle = None

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

    def boot(self) -> None:
        """Start the inference engine subprocess and validate it stays alive."""
        binary_name = get_engine_binary_name()
        engine_path = os.path.join(self.base_path, "engine", binary_name)
        model_path = os.path.join(self.base_path, "models", self.config.model_name)

        self._validate_binary(engine_path)
        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"Missing model file: {model_path}\n"
                f"Please download {self.config.model_name} into the models/ folder."
            )

        cmd = [
            engine_path,
            "-m",
            model_path,
            "-c",
            str(self.config.ctx),
            "-t",
            str(self.config.threads),
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

    def wait_for_ready(self, timeout: int = 90) -> None:
        logger.info("Waiting for engine to become ready (timeout=%ds)...", timeout)
        started = time.time()
        delays = iter((0.2, 0.5, 1.0))
        delay = next(delays)

        while not self.is_server_running(self.config.host, self.engine_port):
            if time.time() - started > timeout:
                self._notify_status("failed")
                raise TimeoutError(
                    f"Engine failed to bind port {self.engine_port} within {timeout}s."
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

        self._notify_status("running")
        logger.info("Engine online and operational.")

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

    def _health_monitor_loop(self) -> None:
        while not self._stop_event.wait(timeout=HEALTH_CHECK_INTERVAL):
            with self._lock:
                if self._is_shutting_down:
                    return
                process = self.process

            if process is None:
                continue

            exit_code = process.poll()
            port_ok = self.is_server_running(self.config.host, self.engine_port)
            process_alive = exit_code is None

            if process_alive and port_ok:
                continue

            if process_alive and not port_ok:
                logger.warning(
                    "Engine process is alive but port %d is not responsive.",
                    self.engine_port,
                )
                if self._stop_event.wait(timeout=HEALTH_CHECK_INTERVAL):
                    return
                port_ok = self.is_server_running(self.config.host, self.engine_port)
                if port_ok:
                    continue

            logger.error(
                "Engine unhealthy (alive=%s, exit_code=%s, port_ok=%s).",
                process_alive,
                exit_code,
                port_ok,
            )
            self._notify_status("crashed")

            with self._lock:
                if self._is_shutting_down:
                    return

            self._cleanup_process(close_log=True)

            if self._restart_count >= MAX_RESTART_ATTEMPTS:
                reason = (
                    f"Engine crashed {MAX_RESTART_ATTEMPTS} times. "
                    "Auto-restart limit reached."
                )
                logger.critical(reason)
                if self._on_crash:
                    self._on_crash(reason)
                return

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
                return

            try:
                self.boot()
                self.wait_for_ready(timeout=60)
                logger.info("Engine restarted successfully.")
            except Exception as exc:
                logger.critical("Auto-restart failed: %s", exc)
                if self._restart_count >= MAX_RESTART_ATTEMPTS and self._on_crash:
                    self._on_crash(str(exc))

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
