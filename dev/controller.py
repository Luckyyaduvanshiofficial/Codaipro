"""
Codai Pro — Controller Module
Wires configuration, runtime analysis, proxy startup, engine lifecycle,
and graceful shutdown into one orchestrated flow.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import platform
import secrets
import signal
import sys
import threading
import traceback
import webbrowser
from datetime import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from dev.config import (  # noqa: E402
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
    VALID_LOG_LEVELS,
    CodaiConfig,
    ENGINE_READY_TIMEOUT,
    get_base_path,
)
from dev.engine import EngineManager  # noqa: E402
from dev.proxy import CodaiProxyHandler, CodaiProxyServer  # noqa: E402
from dev.system import analyze_system_resources  # noqa: E402

logger = logging.getLogger("codai")

TOKEN_FILENAME = "session.token"


class CodaiController:
    """Orchestrator for the Codai local AI runtime."""

    def __init__(self) -> None:
        self.config = CodaiConfig()
        self.base_path = os.environ.get("CODAI_BASE_PATH") or get_base_path()
        self.resource_path = os.environ.get("CODAI_RESOURCE_PATH") or self.base_path
        self.engine: EngineManager | None = None
        self._proxy: CodaiProxyServer | None = None
        self._proxy_thread: threading.Thread | None = None
        self._shutdown_event = threading.Event()
        self._current_phase = PHASE_INITIALIZING
        self._fatal_error: str = ""
        self._exit_code: int = 0
        self._api_token = os.environ.get("CODAI_API_TOKEN") or secrets.token_urlsafe(32)

    def _console_rule(self, char: str = "=") -> str:
        return char * 58

    def _print_terminal_banner(self) -> None:
        print()
        print(f"  {self._console_rule()}")
        print("   CODAI PRO LOCAL RUNTIME")
        print(f"  {self._console_rule()}")
        print(f"   Platform   : {platform.platform()}")
        print(f"   Base Path  : {self.base_path}")
        print("   Mode       : Offline local inference")
        print()

    def _print_runtime_summary(self, engine_port: int) -> None:
        print("   Runtime Summary")
        print(f"   Proxy URL  : http://127.0.0.1:{self.config.port}/")
        print(f"   Engine URL : http://127.0.0.1:{engine_port}/")
        print(f"   Model      : {self.config.model_name}")
        print(f"   Threads    : {self.config.threads}")
        print(f"   Context    : {self.config.ctx}")
        print(f"   Debug      : {self.config.debug}")
        print()

    def _print_failure_panel(self, title: str, detail: str, hint: str = "") -> None:
        print()
        print(f"  {self._console_rule('!')}")
        print(f"   {title}")
        print(f"  {self._console_rule('!')}")
        print(f"   Detail     : {detail}")
        if hint:
            print(f"   Hint       : {hint}")
        print(f"   Logs       : {os.path.join(self.base_path, 'logs', 'codai.log')}")
        print()

    def _describe_failure_hint(self, exc: BaseException) -> str:
        message = str(exc)
        if isinstance(exc, FileNotFoundError):
            return "A required file is missing. Check the model, engine binary, or config path."
        if isinstance(exc, TimeoutError):
            return "Startup timed out. The engine may be busy, blocked, or still warming up."
        if "already running" in message.lower():
            return "Another instance may still be open. Close it or remove a stale logs/codai.lock file."
        if "port" in message.lower():
            return "A local port is unavailable. Check for another app using the same port in config.json."
        if "permission" in message.lower() or "access" in message.lower():
            return "The OS may be blocking access. Try running from a normal writable folder."
        return "Check the latest log lines for the exact failing step."

    def _write_crash_report(self, exc: BaseException) -> str:
        log_dir = os.path.join(self.base_path, "logs")
        os.makedirs(log_dir, exist_ok=True)
        crash_log = os.path.join(log_dir, "crash.log")
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        trace = traceback.format_exc()
        if trace.strip() == "NoneType: None":
            trace = f"{type(exc).__name__}: {exc}\n"
        with open(crash_log, "a", encoding="utf-8") as handle:
            handle.write(f"[{timestamp}] {type(exc).__name__}: {exc}\n")
            handle.write(trace.rstrip() + "\n")
            handle.write("-" * 72 + "\n")
        return crash_log

    def _setup_logging(self) -> None:
        """Configure console and rotating file logging."""
        level_name = str(self.config.log_level).upper()
        if level_name not in VALID_LOG_LEVELS:
            level_name = "INFO"
        level = getattr(logging, level_name)
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
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
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
        # The desktop shell renders its own window; opening a browser tab would duplicate it.
        if os.environ.get("CODAI_NO_BROWSER", "").strip().lower() in {"1", "true", "yes", "on"}:
            logger.info("Browser launch disabled (CODAI_NO_BROWSER).")
            return
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

    def run(self) -> int:
        try:
            self._print_terminal_banner()
            self._setup_logging()
            logger.info("=" * 48)
            logger.info("        CODAI PRO - AI INITIATED")
            logger.info("=" * 48)

            self._set_phase(PHASE_INITIALIZING, engine_status="initializing")
            config_path = os.path.join(self.resource_path, CONFIG_FILENAME)
            self.config.load_from_file(config_path)
            self.config.load_from_env()
            self._setup_logging()

            self._set_phase(PHASE_ANALYZING_HW, engine_status="initializing")
            analyze_system_resources(self.config)

            engine_port = self.config.port + 1
            self._print_runtime_summary(engine_port)
            self.engine = EngineManager(
                self.config,
                self.base_path,
                engine_port=engine_port,
                on_crash=self._on_engine_crash,
                on_status_change=self._on_engine_status_change,
                resource_path=self.resource_path,
            )

            try:
                self.engine.acquire_instance_lock()
            except RuntimeError as exc:
                logger.critical("Singleton lock failed: %s", exc)
                self._set_phase(PHASE_CRASHED, engine_status="failed", error_message=str(exc))
                self._fatal_error = str(exc)
                self._exit_code = 1
                self._print_failure_panel(
                    "ALREADY RUNNING",
                    str(exc),
                    self._describe_failure_hint(exc),
                )
                return self._exit_code

            # Signals are handled from here on, so Ctrl+C or a stop request during
            # the slow model load still runs the shutdown path below.
            self._register_signals()

            self.engine.check_port_available()

            self._proxy = CodaiProxyServer(
                (self.config.host, self.config.port),
                CodaiProxyHandler,
                self.config,
                self.base_path,
                engine_port=engine_port,
                api_token=self._api_token,
                shutdown_callback=self._shutdown_event.set,
            )
            self._write_token_file()
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
            self.engine.wait_for_ready(timeout=ENGINE_READY_TIMEOUT)
            self.engine.start_health_monitor()
            self._set_phase(PHASE_READY, engine_status="running")

            self._launch_ui()
            self._print_banner()
            self._shutdown_event.wait()
        except KeyboardInterrupt:
            logger.info("Keyboard interrupt received.")
            self._exit_code = 0
        except FileNotFoundError as exc:
            logger.critical("Dependency missing: %s", exc)
            self._fail("STARTUP FAILED", exc)
        except TimeoutError as exc:
            logger.critical("Startup timeout: %s", exc)
            self._fail("STARTUP TIMED OUT", exc)
        except RuntimeError as exc:
            logger.critical("Runtime error: %s", exc)
            self._fail("RUNTIME FAILED", exc)
        except Exception as exc:  # fatal guard
            logger.critical("Fatal exception: %s", exc, exc_info=True)
            crash_log = self._write_crash_report(exc)
            self._fail("UNEXPECTED FATAL ERROR", exc, f"Full traceback saved to {crash_log}")
        finally:
            self._shutdown()
        return self._exit_code

    def _token_path(self) -> str:
        return os.path.join(self.base_path, "logs", TOKEN_FILENAME)

    def _write_token_file(self) -> None:
        """Expose the session token to the local launcher only (owner-readable file)."""
        path = self._token_path()
        fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(self._api_token)

    def _remove_token_file(self) -> None:
        try:
            os.unlink(self._token_path())
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("Could not remove token file: %s", exc)

    def _fail(self, title: str, exc: BaseException, hint: str | None = None) -> None:
        self._set_phase(PHASE_CRASHED, engine_status="failed", error_message=str(exc))
        self._fatal_error = str(exc)
        self._exit_code = 1
        self._print_failure_panel(title, str(exc), hint or self._describe_failure_hint(exc))

    def _shutdown(self) -> None:
        self._set_phase(PHASE_SHUTTING_DOWN, engine_status="shutting_down")
        logger.info("Performing full system shutdown...")

        self._remove_token_file()

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
        sys.exit(CodaiController().run())
    except SystemExit:
        raise
    except Exception as exc:  # startup guard
        crash_log_dir = os.path.join(get_base_path(), "logs")
        os.makedirs(crash_log_dir, exist_ok=True)
        crash_log = os.path.join(crash_log_dir, "crash.log")
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(crash_log, "a", encoding="utf-8") as handle:
            handle.write(f"[{timestamp}] FATAL EXCEPTION: {exc}\n")
            handle.write(traceback.format_exc().rstrip() + "\n")
            handle.write("-" * 72 + "\n")
        print()
        print("  " + "!" * 58)
        print("   CODAI PRO COULD NOT START")
        print("  " + "!" * 58)
        print(f"   Detail     : {exc}")
        print(f"   Crash Log  : {crash_log}")
        print()
        sys.exit(1)
