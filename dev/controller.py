"""
Codai Pro — Controller Module
Wires configuration, runtime analysis, proxy startup, engine lifecycle,
and graceful shutdown into one orchestrated flow.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import signal
import sys
import threading
import webbrowser

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from dev.config import (  # noqa: E402
    CONFIG_FILENAME,
    LOG_DATE_FORMAT,
    LOG_FORMAT,
    PHASE_ANALYZING_HW,
    PHASE_BINDING_PORT,
    PHASE_CRASHED,
    PHASE_INITIALIZING,
    PHASE_LOADING_MODEL,
    PHASE_READY,
    PHASE_SHUTTING_DOWN,
    CodaiConfig,
    get_base_path,
)
from dev.engine import EngineManager  # noqa: E402
from dev.proxy import CodaiProxyHandler, CodaiProxyServer  # noqa: E402
from dev.system import analyze_system_resources  # noqa: E402

logger = logging.getLogger("codai")


class CodaiController:
    """Production-grade orchestrator for the Codai local AI runtime."""

    def __init__(self) -> None:
        self.config = CodaiConfig()
        self.base_path = get_base_path()
        self.engine: EngineManager | None = None
        self._proxy: CodaiProxyServer | None = None
        self._proxy_thread: threading.Thread | None = None
        self._shutdown_event = threading.Event()
        self._current_phase = PHASE_INITIALIZING

    def _setup_logging(self) -> None:
        """Configure console and rotating file logging safely."""
        level_name = getattr(self.config, "log_level", "INFO").upper()
        level = getattr(logging, level_name, logging.INFO)
        root = logging.getLogger()
        root.setLevel(level)

        for handler in list(root.handlers):
            root.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass

        log_dir = os.path.join(self.base_path, "logs")
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, "codai.log")

        formatter = logging.Formatter(LOG_FORMAT, LOG_DATE_FORMAT)

        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(level)
        console_handler.setFormatter(formatter)
        root.addHandler(console_handler)

        file_handler = logging.handlers.RotatingFileHandler(
            log_path,
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)

        logger.info("Logging initialized -> %s", log_path)
        logger.info("Log level -> %s", level_name)

    def _set_phase(
        self,
        phase: str,
        *,
        engine_status: str = "unknown",
        error_message: str = "",
    ) -> None:
        self._current_phase = phase
        if self._proxy:
            self._proxy.startup_phase = phase
            self._proxy.engine_status = engine_status
            self._proxy.error_message = error_message
        logger.info("Lifecycle phase -> %s (engine=%s)", phase, engine_status)

    def _on_engine_status_change(self, status: str) -> None:
        phase = self._current_phase
        error_message = ""

        if status == "running":
            phase = PHASE_READY
        elif status in {"failed", "crashed"}:
            phase = PHASE_CRASHED
            error_message = "Engine process terminated unexpectedly."
        elif status == "shutting_down":
            phase = PHASE_SHUTTING_DOWN

        self._set_phase(phase, engine_status=status, error_message=error_message)

    def _on_engine_crash(self, reason: str) -> None:
        logger.critical("Engine unrecoverable: %s", reason)
        self._set_phase(PHASE_CRASHED, engine_status="crashed", error_message=reason)
        self._shutdown_event.set()

    def _register_signals(self) -> None:
        def _handler(signum: int, _frame: object) -> None:
            logger.info("Received %s - shutting down...", signal.Signals(signum).name)
            self._shutdown_event.set()

        signal.signal(signal.SIGINT, _handler)
        signal.signal(signal.SIGTERM, _handler)

    def _launch_ui(self) -> None:
        url = f"http://127.0.0.1:{self.config.port}/"
        try:
            webbrowser.open(url)
            logger.info("Opening interface -> %s", url)
        except Exception as exc:
            logger.warning("Could not open browser automatically: %s", exc)
            logger.info("Open manually -> %s", url)

    def _print_banner(self) -> None:
        logger.info("")
        logger.info("  " + "=" * 46)
        logger.info("   CODAI PRO IS ACTIVE AND LISTENING")
        logger.info("  " + "=" * 46)
        logger.info("   Interface  -> http://127.0.0.1:%s", self.config.port)
        logger.info("   Telemetry  -> http://127.0.0.1:%s/telemetry", self.config.port)
        logger.info("   Engine UI  -> http://127.0.0.1:%s", self.config.port + 1)
        logger.info("  " + "=" * 46)
        logger.info("   Press Ctrl+C to shut down safely.")
        logger.info("")

    def run(self) -> None:
        try:
            self._setup_logging()
            logger.info("=" * 48)
            logger.info("        CODAI PRO - AI INITIATED")
            logger.info("=" * 48)

            self._set_phase(PHASE_INITIALIZING, engine_status="initializing")
            config_path = os.path.join(self.base_path, CONFIG_FILENAME)
            self.config.load_from_file(config_path)
            self.config.load_from_env()

            self._set_phase(PHASE_ANALYZING_HW, engine_status="initializing")
            analyze_system_resources(self.config)

            engine_port = self.config.port + 1
            self.engine = EngineManager(
                self.config,
                self.base_path,
                engine_port=engine_port,
                on_crash=self._on_engine_crash,
                on_status_change=self._on_engine_status_change,
            )

            try:
                self.engine.acquire_instance_lock()
            except RuntimeError as exc:
                logger.critical("Singleton lock failed: %s", exc)
                self._set_phase(PHASE_CRASHED, engine_status="failed", error_message=str(exc))
                raise SystemExit(1) from exc

            self.engine.check_port_available()

            self._proxy = CodaiProxyServer(
                (self.config.host, self.config.port),
                CodaiProxyHandler,
                self.config,
                self.base_path,
                engine_port=engine_port,
            )
            self._set_phase(PHASE_LOADING_MODEL, engine_status="starting")
            self._proxy_thread = threading.Thread(
                target=self._proxy.serve_forever,
                daemon=True,
                name="codai-proxy",
            )
            self._proxy_thread.start()
            logger.info(
                "Unified reverse proxy started on %s:%d",
                self.config.host,
                self.config.port,
            )

            self.engine.boot()
            self._set_phase(PHASE_BINDING_PORT, engine_status="starting")
            self.engine.wait_for_ready(timeout=90)
            self.engine.start_health_monitor()
            self._set_phase(PHASE_READY, engine_status="running")

            self._register_signals()
            self._launch_ui()
            self._print_banner()
            self._shutdown_event.wait()
        except KeyboardInterrupt:
            logger.info("Keyboard interrupt received.")
        except SystemExit:
            raise
        except FileNotFoundError as exc:
            logger.critical("Dependency missing: %s", exc)
            self._set_phase(PHASE_CRASHED, engine_status="failed", error_message=str(exc))
        except TimeoutError as exc:
            logger.critical("Startup timeout: %s", exc)
            self._set_phase(PHASE_CRASHED, engine_status="failed", error_message=str(exc))
        except RuntimeError as exc:
            logger.critical("Runtime error: %s", exc)
            self._set_phase(PHASE_CRASHED, engine_status="failed", error_message=str(exc))
        except Exception as exc:  # pragma: no cover - fatal guard
            logger.critical("Fatal exception: %s", exc, exc_info=True)
            self._set_phase(PHASE_CRASHED, engine_status="failed", error_message=str(exc))
        finally:
            self._shutdown()

    def _shutdown(self) -> None:
        self._set_phase(PHASE_SHUTTING_DOWN, engine_status="shutting_down")
        logger.info("Performing full system shutdown...")

        if self._proxy:
            try:
                self._proxy.shutdown()
                self._proxy.server_close()
            except Exception as exc:
                logger.warning("Proxy shutdown warning: %s", exc)
            finally:
                self._proxy = None

        if self.engine:
            try:
                self.engine.shutdown()
            except Exception as exc:
                logger.warning("Engine shutdown warning: %s", exc)
            finally:
                self.engine = None

        logger.info("System safely offline.")


if __name__ == "__main__":
    try:
        if sys.platform == "win32":
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        CodaiController().run()
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover - startup guard
        crash_log_dir = os.path.join(PROJECT_ROOT, "logs")
        os.makedirs(crash_log_dir, exist_ok=True)
        crash_log = os.path.join(crash_log_dir, "crash.log")
        with open(crash_log, "a", encoding="utf-8") as handle:
            handle.write(f"FATAL EXCEPTION: {exc}\n")
        print(f"FATAL EXCEPTION: Check {crash_log}")
        sys.exit(1)
