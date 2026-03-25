"""
Codai Pro — Controller Module
Thin orchestrator: wires config → system → engine → UI lifecycle.
Structured logging with rotation, signal-based shutdown, startup phase tracking.
"""

import logging
import logging.handlers
import os
import signal
import sys
import threading
import webbrowser

from dev.config import (
    CodaiConfig,
    CONFIG_FILENAME,
    LOG_BACKUP_COUNT,
    LOG_DATE_FORMAT,
    LOG_FORMAT,
    LOG_MAX_BYTES,
    PHASE_ANALYZING_HW,
    PHASE_BINDING_PORT,
    PHASE_CRASHED,
    PHASE_INITIALIZING,
    PHASE_LOADING_MODEL,
    PHASE_READY,
    PHASE_SHUTTING_DOWN,
    ensure_log_directory,
    get_base_path,
)
from dev.engine import EngineManager
from dev.system import analyze_system_resources, write_system_info

logger = logging.getLogger("codai")


class CodaiController:
    """Production-grade orchestrator for the Codai local AI runtime."""

    def __init__(self) -> None:
        self.config = CodaiConfig()
        self.base_path = get_base_path()
        self.engine: EngineManager | None = None
        self._shutdown_event = threading.Event()
        self._current_phase: str = PHASE_INITIALIZING

    # ------------------------------------------------------------------
    # Startup phase tracking  (Task 9 hardening)
    # ------------------------------------------------------------------
    def _set_phase(self, phase: str, engine_status: str = "unknown") -> None:
        """Update current phase and sync system_info.json for frontend."""
        self._current_phase = phase
        logger.info("Phase → %s", phase)
        write_system_info(
            self.config, self.base_path,
            engine_status=engine_status,
            startup_phase=phase,
        )

    # ------------------------------------------------------------------
    # Engine status change callback  (Task 7 hardening: crash visibility)
    # ------------------------------------------------------------------
    def _on_engine_status_change(self, status: str) -> None:
        """Called by EngineManager whenever engine status changes.

        Updates system_info.json so the frontend can display:
            ``"Engine crashed, restarting…"``
        """
        phase = self._current_phase
        if status == "crashed":
            phase = PHASE_CRASHED
        elif status == "running":
            phase = PHASE_READY
        write_system_info(
            self.config, self.base_path,
            engine_status=status,
            startup_phase=phase,
        )

    # ------------------------------------------------------------------
    # Structured logging with rotation  (Tasks 3 & 12 hardening)
    # ------------------------------------------------------------------
    def _setup_logging(self) -> None:
        """Configure logging to console + rotating ``logs/codai.log``."""
        log_dir = ensure_log_directory(self.base_path)
        log_file = os.path.join(log_dir, "codai.log")

        root = logging.getLogger()
        root.setLevel(logging.DEBUG)

        # Prevent duplicate handlers on re-entry
        if root.handlers:
            return

        # Console handler
        console = logging.StreamHandler(sys.stdout)
        console.setLevel(logging.INFO)
        console.setFormatter(logging.Formatter(LOG_FORMAT, LOG_DATE_FORMAT))
        root.addHandler(console)

        # Rotating file handler (Task 3 hardening: 5 MB, 3 backups)
        file_handler = logging.handlers.RotatingFileHandler(
            log_file,
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(logging.Formatter(LOG_FORMAT, LOG_DATE_FORMAT))
        root.addHandler(file_handler)

        logger.info("Logging initialised → %s (rotation: %dMB × %d backups)",
                     log_file, LOG_MAX_BYTES // (1024 * 1024), LOG_BACKUP_COUNT)

    # ------------------------------------------------------------------
    # UI launcher
    # ------------------------------------------------------------------
    def _launch_ui(self) -> None:
        """Open the web interface in the default browser."""
        ui_path = os.path.join(self.base_path, "ui", "index.html")
        if not os.path.exists(ui_path):
            raise FileNotFoundError(f"UI interface missing: {ui_path}")

        logger.info("Opening interface in default browser...")
        try:
            webbrowser.open(f"file://{ui_path}")
        except Exception as exc:
            logger.warning("Could not open browser: %s", exc)
            logger.info("Please open manually: file://%s", ui_path)

    # ------------------------------------------------------------------
    # Signal-based shutdown (replaces input())
    # ------------------------------------------------------------------
    def _register_signals(self) -> None:
        """Handle SIGINT / SIGTERM for clean shutdown."""
        def _handler(signum: int, _frame) -> None:  # type: ignore[override]
            sig_name = signal.Signals(signum).name
            logger.info("Received %s — initiating shutdown...", sig_name)
            self._shutdown_event.set()

        signal.signal(signal.SIGINT, _handler)
        signal.signal(signal.SIGTERM, _handler)

    # ------------------------------------------------------------------
    # Main lifecycle
    # ------------------------------------------------------------------
    def run(self) -> None:
        """Execute the full Codai lifecycle pipeline."""
        try:
            self._setup_logging()

            logger.info("=" * 48)
            logger.info("        CODAI PRO — AI INITIATED")
            logger.info("=" * 48)

            # Phase: initializing — load external config
            self._set_phase(PHASE_INITIALIZING)
            config_path = os.path.join(self.base_path, CONFIG_FILENAME)
            self.config.load_from_file(config_path)
            self.config.load_from_env()

            # Phase: analyzing hardware
            self._set_phase(PHASE_ANALYZING_HW)
            analyze_system_resources(self.config)

            # Phase: loading model — boot engine
            self._set_phase(PHASE_LOADING_MODEL, engine_status="starting")
            self.engine = EngineManager(
                config=self.config,
                base_path=self.base_path,
                on_crash=self._on_engine_crash,
                on_status_change=self._on_engine_status_change,
            )

            # Port conflict pre-check (Task 5 hardening)
            self.engine.check_port_available()

            self.engine.boot()

            # Phase: binding port — wait for ready
            self._set_phase(PHASE_BINDING_PORT, engine_status="starting")
            self.engine.wait_for_ready(timeout=90)

            # Phase: ready
            self._set_phase(PHASE_READY, engine_status="running")

            # Start health monitoring
            self.engine.start_health_monitor()

            # Launch UI
            self._launch_ui()

            # Wait for shutdown signal
            self._register_signals()
            logger.info("")
            logger.info("=" * 48)
            logger.info("  Codai Pro is ACTIVE in your browser!")
            logger.info("  Press Ctrl+C to shut down safely.")
            logger.info("=" * 48)
            logger.info("")

            self._shutdown_event.wait()

        except KeyboardInterrupt:
            logger.info("Keyboard interrupt received.")
        except FileNotFoundError as exc:
            logger.critical("Dependency missing: %s", exc)
        except TimeoutError as exc:
            logger.critical("Startup timeout: %s", exc)
        except RuntimeError as exc:
            logger.critical("Runtime error: %s", exc)
        except Exception as exc:
            logger.critical("Fatal exception: %s", exc, exc_info=True)
        finally:
            self._shutdown()

    def _shutdown(self) -> None:
        """Coordinate full system shutdown."""
        self._set_phase(PHASE_SHUTTING_DOWN, engine_status="shutting_down")
        logger.info("Performing full system shutdown...")
        if self.engine:
            self.engine.shutdown()
        self._set_phase(PHASE_SHUTTING_DOWN, engine_status="stopped")
        logger.info("System safely offline. Have a great day!")

    def _on_engine_crash(self, reason: str) -> None:
        """Callback invoked by EngineManager when auto-restart is exhausted."""
        logger.critical("Engine unrecoverable: %s", reason)
        self._shutdown_event.set()


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------
if __name__ == "__main__":
    app = CodaiController()
    app.run()