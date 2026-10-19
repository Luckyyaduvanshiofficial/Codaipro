"""
Codai Pro — Configuration Module
Centralized configuration, constants, path resolution, and external config loading.
"""

import json
import logging
import os
import platform
import sys
from typing import Any, Dict

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GRACEFUL_SHUTDOWN_TIMEOUT: int = 3       # seconds to wait after terminate()
HEALTH_CHECK_INTERVAL: int = 5           # seconds between health polls
MAX_RESTART_ATTEMPTS: int = 3            # auto-restart ceiling per unstable period
STABLE_RUN_SECONDS: int = 300            # a run this long resets the restart budget
ENGINE_READY_TIMEOUT: int = 90           # seconds allowed for the first model load
RESTART_READY_TIMEOUT: int = 90          # seconds allowed for a restarted model load
DEFAULT_PORT: int = 8080
DEFAULT_HOST: str = "127.0.0.1"
DEFAULT_MODEL: str = "gemma-3-1b-it-Q4_K_M.gguf"
DEFAULT_CTX: int = 1024
DEFAULT_THREADS: int = 2

# First-run model download. Empty URL disables downloading.
DEFAULT_MODEL_URL: str = ""
DEFAULT_MODEL_SIZE: int = 0              # expected bytes; 0 disables the size check

LOOPBACK_HOSTS: frozenset = frozenset({"127.0.0.1", "localhost"})
MIN_PORT: int = 1024
MAX_PORT: int = 65534                    # engine uses port + 1, so 65535 is excluded
MIN_CTX: int = 256
MAX_CTX: int = 131072
MIN_THREADS: int = 1
MAX_THREADS: int = 256
VALID_LOG_LEVELS: tuple = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")

# Restart backoff delays (seconds) — indexed by attempt number (0-based)
RESTART_DELAYS: list[float] = [0.0, 2.0, 5.0]

# Log rotation settings
LOG_MAX_BYTES: int = 5 * 1024 * 1024     # 5 MB per log file
LOG_BACKUP_COUNT: int = 3                # keep 3 rotated backups

# Structured log format (timestamp • level • module • message)
LOG_FORMAT: str = (
    "%(asctime)s.%(msecs)03d [%(levelname)-8s] %(name)-18s | %(message)s"
)
LOG_DATE_FORMAT: str = "%Y-%m-%d %H:%M:%S"

# External config filename
CONFIG_FILENAME: str = "config.json"

# Startup phases for visibility
PHASE_INITIALIZING: str = "initializing"
PHASE_ANALYZING_HW: str = "analyzing_hardware"
PHASE_LOADING_MODEL: str = "loading_model"
PHASE_BINDING_PORT: str = "binding_port"
PHASE_READY: str = "ready"
PHASE_SHUTTING_DOWN: str = "shutting_down"
PHASE_CRASHED: str = "crashed"


# ---------------------------------------------------------------------------
# Cross-platform binary name
# ---------------------------------------------------------------------------

def get_engine_binary_name() -> str:
    """Return the correct engine binary name for the current OS."""
    system = platform.system().lower()
    if system == "windows":
        return "llama-server.exe"
    # Linux / macOS — no extension
    return "llama-server"


# ---------------------------------------------------------------------------
# Configuration class
# ---------------------------------------------------------------------------

_TRUE_VALUES = frozenset({"true", "1", "yes", "on"})
_FALSE_VALUES = frozenset({"false", "0", "no", "off"})


class CodaiConfig:
    """Runtime configuration for the Codai engine and UI."""

    def __init__(self) -> None:
        self.port: int = DEFAULT_PORT
        self.host: str = DEFAULT_HOST
        self.model_name: str = DEFAULT_MODEL
        self.ctx: int = DEFAULT_CTX
        self.threads: int = DEFAULT_THREADS
        self.ram_tier: str = "unknown"
        self.ram_gb: float = 0.0
        self.cpu_cores: int = 1
        self.debug: bool = False
        self.log_level: str = "INFO"
        self.model_url: str = DEFAULT_MODEL_URL
        self.model_size: int = DEFAULT_MODEL_SIZE
        # Keys set explicitly by config.json or environment; hardware tuning must not override them.
        self.overrides: set[str] = set()

    # ------------------------------------------------------------------
    # Validation helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _validate(key: str, value: Any) -> Any:
        """Return the normalized value, or raise ValueError with a reason."""
        if key in {"port", "ctx", "threads"}:
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError("must be an integer")
            bounds = {
                "port": (MIN_PORT, MAX_PORT),
                "ctx": (MIN_CTX, MAX_CTX),
                "threads": (MIN_THREADS, MAX_THREADS),
            }[key]
            if not bounds[0] <= value <= bounds[1]:
                raise ValueError(f"must be between {bounds[0]} and {bounds[1]}")
            return value

        if key == "debug":
            if not isinstance(value, bool):
                raise ValueError("must be true or false")
            return value

        if key == "host":
            if not isinstance(value, str) or value.lower() not in LOOPBACK_HOSTS:
                raise ValueError("only loopback hosts (127.0.0.1, localhost) are allowed")
            return value.lower()

        if key == "model_name":
            if (
                not isinstance(value, str)
                or not value
                or os.path.basename(value) != value
                or value in {".", ".."}
                or not value.lower().endswith(".gguf")
            ):
                raise ValueError("must be a .gguf file name inside the models folder")
            return value

        if key == "log_level":
            if not isinstance(value, str) or value.upper() not in VALID_LOG_LEVELS:
                raise ValueError(f"must be one of {', '.join(VALID_LOG_LEVELS)}")
            return value.upper()

        if key == "model_url":
            if not isinstance(value, str) or not value:
                return ""
            if not value.lower().startswith(("https://", "http://")):
                raise ValueError("must be an http(s) URL")
            return value

        if key == "model_size":
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError("must be a non-negative integer")
            return value

        raise ValueError("unknown setting")

    def _apply(self, key: str, value: Any, source: str) -> None:
        logger = logging.getLogger("codai.config")
        try:
            normalized = self._validate(key, value)
        except ValueError as exc:
            logger.warning("Ignoring %s %s=%r: %s", source, key, value, exc)
            return
        setattr(self, key, normalized)
        self.overrides.add(key)
        logger.info("Config override (%s): %s=%s", source, key, normalized)

    # ------------------------------------------------------------------
    # External config support
    # ------------------------------------------------------------------
    def load_from_file(self, config_path: str) -> bool:
        """Load overrides from a JSON config file.

        Supported keys: ``model_name``, ``threads``, ``ctx``, ``port``,
        ``host``, ``debug``, ``log_level``. Unknown keys are ignored and
        invalid values are reported and skipped.

        Returns True if file was loaded, False otherwise.
        """
        logger = logging.getLogger("codai.config")
        if not os.path.isfile(config_path):
            logger.info("No external config at %s — using defaults.", config_path)
            return False

        try:
            with open(config_path, "r", encoding="utf-8") as fh:
                data: Any = json.load(fh)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
            logger.warning("Could not parse %s: %s — using defaults.", config_path, exc)
            return False

        if not isinstance(data, dict):
            logger.warning("%s must contain a JSON object — using defaults.", config_path)
            return False

        allowed = (
            "model_name", "threads", "ctx", "port", "host", "debug", "log_level",
            "model_url", "model_size",
        )
        for key in allowed:
            if key in data:
                self._apply(key, data[key], "config.json")
        return True

    def load_from_env(self) -> None:
        """Apply environment-variable overrides (``CODAI_*`` prefix)."""
        logger = logging.getLogger("codai.config")
        int_keys = {"CODAI_PORT": "port", "CODAI_CTX": "ctx", "CODAI_THREADS": "threads"}
        str_keys = {
            "CODAI_HOST": "host",
            "CODAI_MODEL": "model_name",
            "CODAI_LOG_LEVEL": "log_level",
            "CODAI_MODEL_URL": "model_url",
        }

        raw_size = os.environ.get("CODAI_MODEL_SIZE")
        if raw_size is not None:
            try:
                self._apply("model_size", int(raw_size), "env CODAI_MODEL_SIZE")
            except ValueError:
                logging.getLogger("codai.config").warning(
                    "Ignoring env CODAI_MODEL_SIZE=%r: must be an integer", raw_size
                )

        for env_key, attr in int_keys.items():
            raw = os.environ.get(env_key)
            if raw is None:
                continue
            try:
                value = int(raw)
            except ValueError:
                logger.warning("Ignoring env %s=%r: must be an integer", env_key, raw)
                continue
            self._apply(attr, value, f"env {env_key}")

        for env_key, attr in str_keys.items():
            raw = os.environ.get(env_key)
            if raw is not None:
                self._apply(attr, raw, f"env {env_key}")

        raw_debug = os.environ.get("CODAI_DEBUG")
        if raw_debug is not None:
            lowered = raw_debug.strip().lower()
            if lowered in _TRUE_VALUES:
                self._apply("debug", True, "env CODAI_DEBUG")
            elif lowered in _FALSE_VALUES:
                self._apply("debug", False, "env CODAI_DEBUG")
            else:
                logger.warning("Ignoring env CODAI_DEBUG=%r: must be true or false", raw_debug)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def get_base_path() -> str:
    """Resolve root directory for both PyInstaller-frozen and script modes."""
    try:
        if getattr(sys, "frozen", False):
            return os.path.dirname(sys.executable)
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    except Exception as exc:
        logging.getLogger("codai.config").critical(
            "Path resolution failed: %s", exc
        )
        sys.exit(1)


def resolve_model_dir(name: str, base_path: str, resource_path: str) -> str:
    """
    Return the directory that should hold *name*.

    A model bundled with the install (``resource_path/models``) is used as-is when it
    exists there. Otherwise models live in the writable ``base_path/models`` directory,
    which is where a first-run download is written.
    """
    bundled = os.path.join(resource_path, "models", name)
    if os.path.exists(bundled):
        return os.path.join(resource_path, "models")
    return os.path.join(base_path, "models")


def ensure_log_directory(base_path: str) -> str:
    """Create and return the logs/ directory under *base_path*."""
    log_dir = os.path.join(base_path, "logs")
    os.makedirs(log_dir, exist_ok=True)
    return log_dir
