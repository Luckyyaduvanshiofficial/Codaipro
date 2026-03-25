"""
Codai Pro — Engine Module
Process lifecycle: boot, health monitoring, graceful shutdown, auto-restart.
Thread-safe process access with restart backoff strategy.
"""

import logging
import os
import socket
import stat
import subprocess
import threading
import time
from typing import Optional, Callable

from dev.config import (
    CodaiConfig,
    GRACEFUL_SHUTDOWN_TIMEOUT,
    HEALTH_CHECK_INTERVAL,
    MAX_RESTART_ATTEMPTS,
    RESTART_DELAYS,
    ensure_log_directory,
    get_engine_binary_name,
)

logger = logging.getLogger("codai.engine")


class EngineManager:
    """Manages the llama-server subprocess lifecycle.

    All process state access is guarded by ``_lock`` so the health-monitor
    daemon thread and the main thread never race on ``self.process``.
    """

    def __init__(
        self,
        config: CodaiConfig,
        base_path: str,
        on_crash: Optional[Callable[[str], None]] = None,
        on_status_change: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.config = config
        self.base_path = base_path
        self.process: Optional[subprocess.Popen] = None  # type: ignore[type-arg]
        self._log_file_handle = None
        self._health_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._restart_count = 0
        self._on_crash = on_crash
        self._on_status_change = on_status_change

        # Thread-safety lock for process access
        self._lock = threading.Lock()
        self._is_shutting_down = False
        self._lock_path = os.path.join(
            ensure_log_directory(base_path), "codai.lock"
        )

    # ------------------------------------------------------------------
    # Instance lock — prevent duplicate instances
    # ------------------------------------------------------------------
    def acquire_instance_lock(self) -> None:
        """Create a PID lock file; fail if another instance is running."""
        if os.path.isfile(self._lock_path):
            try:
                with open(self._lock_path, "r", encoding="utf-8") as fh:
                    old_pid = int(fh.read().strip())
                # Check if that PID is still alive
                import psutil
                if psutil.pid_exists(old_pid):
                    raise RuntimeError(
                        f"Another Codai instance is already running (PID {old_pid}). "
                        f"Stop it first or delete {self._lock_path}."
                    )
                logger.warning(
                    "Stale lock file found (PID %d dead). Reclaiming.", old_pid
                )
            except (ValueError, OSError):
                logger.warning("Corrupt lock file found. Reclaiming.")

        try:
            with open(self._lock_path, "w", encoding="utf-8") as fh:
                fh.write(str(os.getpid()))
            logger.info("Instance lock acquired (PID %d).", os.getpid())
        except OSError as exc:
            raise RuntimeError(f"Cannot write lock file: {exc}") from exc

    def release_instance_lock(self) -> None:
        """Remove the PID lock file."""
        try:
            if os.path.isfile(self._lock_path):
                os.unlink(self._lock_path)
                logger.info("Instance lock released.")
        except OSError as exc:
            logger.warning("Could not remove lock file: %s", exc)

    # ------------------------------------------------------------------
    # Status notification helper
    # ------------------------------------------------------------------
    def _notify_status(self, status: str) -> None:
        """Push engine status change to controller (crash visibility)."""
        if self._on_status_change:
            self._on_status_change(status)

    # ------------------------------------------------------------------
    # Renamed: is_server_running  (replaces is_port_available)
    # ------------------------------------------------------------------
    @staticmethod
    def is_server_running(host: str, port: int) -> bool:
        """Return True if the inference server is accepting connections."""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(1)
                return sock.connect_ex((host, port)) == 0
        except socket.error as exc:
            logger.error("Socket probe failed: %s", exc)
            return False

    # ------------------------------------------------------------------
    # Port conflict detection  (Task 5 hardening)
    # ------------------------------------------------------------------
    def check_port_available(self) -> None:
        """Fail fast if the configured port is already occupied."""
        if self.is_server_running(self.config.host, self.config.port):
            raise RuntimeError(
                f"Port {self.config.port} is already in use on "
                f"{self.config.host}. Close the conflicting service or "
                f"set a different port in config.json / CODAI_PORT env var."
            )
        logger.info(
            "Port %d is available on %s.", self.config.port, self.config.host
        )

    # ------------------------------------------------------------------
    # Engine logging to file
    # ------------------------------------------------------------------
    def _open_log_file(self) -> None:
        """Open (or create) ``logs/engine.log`` for subprocess stdout/stderr."""
        log_dir = ensure_log_directory(self.base_path)
        log_path = os.path.join(log_dir, "engine.log")
        self._log_file_handle = open(log_path, "a", encoding="utf-8")  # noqa: SIM115
        logger.info("Engine log → %s", log_path)

    def _close_log_file(self) -> None:
        if self._log_file_handle and not self._log_file_handle.closed:
            self._log_file_handle.close()
            self._log_file_handle = None

    # ------------------------------------------------------------------
    # Engine binary validation  (Task 4 hardening)
    # ------------------------------------------------------------------
    def _validate_binary(self, engine_path: str) -> None:
        """Validate engine binary exists and is executable."""
        if not os.path.exists(engine_path):
            raise FileNotFoundError(f"Missing engine binary: {engine_path}")

        # Check file is readable and has non-zero size (catch corruption)
        file_stat = os.stat(engine_path)
        if file_stat.st_size == 0:
            raise RuntimeError(
                f"Engine binary appears corrupted (0 bytes): {engine_path}"
            )

        # On non-Windows, verify executable permission
        if os.name != "nt":
            if not file_stat.st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
                raise PermissionError(
                    f"Engine binary is not executable: {engine_path}\n"
                    f"Run: chmod +x {engine_path}"
                )

        # On Windows, verify file is accessible for reading
        if not os.access(engine_path, os.R_OK):
            raise PermissionError(
                f"Engine binary is not readable: {engine_path}"
            )

        logger.info("Engine binary validated: %s (%d bytes)",
                     engine_path, file_stat.st_size)

    # ------------------------------------------------------------------
    # Boot
    # ------------------------------------------------------------------
    def boot(self) -> None:
        """Start the C++ inference engine subprocess (thread-safe)."""
        binary_name = get_engine_binary_name()
        engine_path = os.path.join(self.base_path, "engine", binary_name)
        model_path = os.path.join(
            self.base_path, "models", self.config.model_name
        )

        # Validate binary (Task 4 hardening: permission + corruption)
        self._validate_binary(engine_path)

        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"Missing model file: {model_path}\n"
                f"Please download {self.config.model_name} into the models/ folder."
            )

        cmd = [
            engine_path,
            "-m", model_path,
            "-c", str(self.config.ctx),
            "-t", str(self.config.threads),
            "--port", str(self.config.port),
            "--host", self.config.host,
            "--nobrowser",
        ]

        logger.info("Booting AI engine...")
        self.acquire_instance_lock()
        self._notify_status("starting")

        try:
            self._open_log_file()
            with self._lock:
                self.process = subprocess.Popen(
                    cmd,
                    stdout=self._log_file_handle,
                    stderr=self._log_file_handle,
                )
                logger.info("Engine PID: %d", self.process.pid)
        except Exception as exc:
            self._close_log_file()
            self._notify_status("crashed")
            raise RuntimeError(f"Failed to spawn engine subprocess: {exc}") from exc

    # ------------------------------------------------------------------
    # Exponential-backoff readiness check
    # ------------------------------------------------------------------
    def wait_for_ready(self, timeout: int = 90) -> None:
        """Block until server is accepting connections, with exp. backoff."""
        logger.info("Waiting for engine to become ready (timeout=%ds)...", timeout)
        start = time.time()

        delays = iter([0.2, 0.5, 1.0])
        current_delay = next(delays)

        while not self.is_server_running(self.config.host, self.config.port):
            elapsed = time.time() - start
            if elapsed > timeout:
                self._notify_status("crashed")
                raise TimeoutError(
                    f"Engine failed to bind port {self.config.port} "
                    f"within {timeout}s."
                )
            with self._lock:
                if self.process and self.process.poll() is not None:
                    self._notify_status("crashed")
                    raise RuntimeError(
                        f"Engine process exited prematurely with code "
                        f"{self.process.returncode}. Check logs/engine.log."
                    )
            time.sleep(current_delay)
            current_delay = next(delays, 1.0)

        self._notify_status("running")
        logger.info("Engine online and operational!")

    # ------------------------------------------------------------------
    # Graceful shutdown with timeout safety (thread-safe)
    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        """Graceful shutdown: terminate → wait → kill fallback."""
        with self._lock:
            self._is_shutting_down = True
        self._stop_event.set()
        self._notify_status("shutting_down")

        if self._health_thread and self._health_thread.is_alive():
            self._health_thread.join(timeout=2)

        with self._lock:
            if self.process:
                logger.info("Graceful shutdown initiated (PID %d)...", self.process.pid)
                try:
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=GRACEFUL_SHUTDOWN_TIMEOUT)
                        logger.info("Engine terminated gracefully.")
                    except subprocess.TimeoutExpired:
                        logger.warning(
                            "Engine did not exit in %ds — sending kill signal.",
                            GRACEFUL_SHUTDOWN_TIMEOUT,
                        )
                        self.process.kill()
                        self.process.wait(timeout=5)
                        logger.info("Engine killed forcefully.")
                except Exception as exc:
                    logger.error("Shutdown error (zombie possible): %s", exc)
                finally:
                    self.process = None
                    self._close_log_file()
                    self.release_instance_lock()

        self._notify_status("stopped")
        logger.info("Engine shutdown complete.")

    # ------------------------------------------------------------------
    # Health monitoring + auto-restart with backoff strategy
    # ------------------------------------------------------------------
    def start_health_monitor(self) -> None:
        """Launch a daemon thread that periodically checks engine health."""
        with self._lock:
            self._is_shutting_down = False
        self._stop_event.clear()
        self._restart_count = 0
        self._health_thread = threading.Thread(
            target=self._health_monitor_loop, daemon=True, name="engine-health"
        )
        self._health_thread.start()
        logger.info("Health monitor started (interval=%ds).", HEALTH_CHECK_INTERVAL)

    def _health_monitor_loop(self) -> None:
        """Periodically poll subprocess AND port; auto-restart on crash with backoff."""
        while not self._stop_event.is_set():
            self._stop_event.wait(timeout=HEALTH_CHECK_INTERVAL)
            if self._stop_event.is_set():
                break

            # Check shutdown flag (Task 2 hardening: prevent restart during shutdown)
            with self._lock:
                if self._is_shutting_down:
                    break

            # --- Deep health check (Task 11 hardening) ---
            # 1. Check process existence
            with self._lock:
                if self.process is None:
                    continue
                exit_code = self.process.poll()

            process_alive = exit_code is None

            # 2. Check port responsiveness (even if process is alive)
            port_ok = self.is_server_running(self.config.host, self.config.port)

            if process_alive and port_ok:
                continue  # healthy

            if process_alive and not port_ok:
                logger.warning(
                    "Engine process alive but port %d not responding — "
                    "possible partial failure.",
                    self.config.port,
                )
                # Give it one more cycle before treating as crash
                self._stop_event.wait(timeout=HEALTH_CHECK_INTERVAL)
                if self._stop_event.is_set():
                    break
                port_ok = self.is_server_running(self.config.host, self.config.port)
                if port_ok:
                    continue
                logger.error("Port still unresponsive — treating as crash.")

            if not process_alive:
                logger.error("Engine crashed! Exit code: %s", exit_code)

            # --- Restart with backoff strategy (Task 1 hardening) ---
            self._notify_status("crashed")

            with self._lock:
                if self._is_shutting_down:
                    break

            if self._restart_count < MAX_RESTART_ATTEMPTS:
                delay = RESTART_DELAYS[min(self._restart_count, len(RESTART_DELAYS) - 1)]
                self._restart_count += 1
                logger.warning(
                    "Auto-restart attempt %d/%d (delay=%.1fs)...",
                    self._restart_count,
                    MAX_RESTART_ATTEMPTS,
                    delay,
                )
                self._notify_status("restarting")

                if delay > 0:
                    self._stop_event.wait(timeout=delay)
                    if self._stop_event.is_set():
                        break

                try:
                    self._close_log_file()
                    self.boot()
                    self.wait_for_ready(timeout=60)
                    logger.info("Engine restarted successfully.")
                except Exception as exc:
                    logger.critical("Auto-restart failed: %s", exc)
                    self._notify_status("crashed")
                    if self._on_crash:
                        self._on_crash(str(exc))
                    break
            else:
                logger.critical(
                    "Max restart attempts (%d) exhausted. Engine is DOWN.",
                    MAX_RESTART_ATTEMPTS,
                )
                self._notify_status("crashed")
                if self._on_crash:
                    self._on_crash(
                        f"Engine crashed {MAX_RESTART_ATTEMPTS} times. Giving up."
                    )
                break
