"""
Codai Pro — Configuration Module
Centralized configuration, constants, path resolution, and external config loading.
"""

import json
import os
import platform
import sys
import logging
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GRACEFUL_SHUTDOWN_TIMEOUT: int = 3       # seconds to wait after terminate()
HEALTH_CHECK_INTERVAL: int = 5           # seconds between health polls
MAX_RESTART_ATTEMPTS: int = 3            # auto-restart ceiling
DEFAULT_PORT: int = 8080
DEFAULT_HOST: str = "127.0.0.1"
DEFAULT_MODEL: str = "gemma-3-1b-it-Q4_K_M.gguf"
DEFAULT_CTX: int = 1024
DEFAULT_THREADS: int = 2

# Restart backoff delays (seconds) — indexed by attempt number (0-based)
RESTART_DELAYS: list[float] = [0.0, 2.0, 5.0]

# Log rotation settings
LOG_MAX_BYTES: int = 5 * 1024 * 1024     # 5 MB per log file
LOG_BACKUP_COUNT: int = 3                # keep 3 rotated backups

# Structured log format (Task 12: timestamp • level • module • message)
LOG_FORMAT: str = (
    "%(asctime)s.%(msecs)03d [%(levelname)-8s] %(name)-18s | %(message)s"
)
LOG_DATE_FORMAT: str = "%Y-%m-%d %H:%M:%S"

# External config filename
CONFIG_FILENAME: str = "config.json"

# Startup phases for visibility (Task 9 from hardening)
PHASE_INITIALIZING: str = "initializing"
PHASE_ANALYZING_HW: str = "analyzing_hardware"
PHASE_LOADING_MODEL: str = "loading_model"
PHASE_BINDING_PORT: str = "binding_port"
PHASE_READY: str = "ready"
PHASE_SHUTTING_DOWN: str = "shutting_down"
PHASE_CRASHED: str = "crashed"


# ---------------------------------------------------------------------------
# Cross-platform binary name (Task 10)
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

    # ------------------------------------------------------------------
    # Task 8 (hardening): External config support
    # ------------------------------------------------------------------
    def load_from_file(self, config_path: str) -> bool:
        """Load overrides from a JSON config file.

        Supported keys: ``model_name``, ``threads``, ``ctx``, ``port``,
        ``host``.  Unknown keys are silently ignored.

        Returns True if file was loaded, False otherwise.
        """
        logger = logging.getLogger("codai.config")
        if not os.path.isfile(config_path):
            logger.info("No external config at %s — using defaults.", config_path)
            return False

        try:
            with open(config_path, "r", encoding="utf-8") as fh:
                data: Dict[str, Any] = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Could not parse %s: %s — using defaults.", config_path, exc)
            return False

        _ALLOWED = {"model_name", "threads", "ctx", "port", "host", "debug", "log_level"}
        applied: list[str] = []
        for key in _ALLOWED:
            if key in data:
                setattr(self, key, data[key])
                applied.append(f"{key}={data[key]}")

        if applied:
            logger.info("Config overrides applied: %s", ", ".join(applied))
        return True

    def load_from_env(self) -> None:
        """Apply environment-variable overrides (``CODAI_*`` prefix)."""
        logger = logging.getLogger("codai.config")
        mapping = {
            "CODAI_PORT": ("port", int),
            "CODAI_HOST": ("host", str),
            "CODAI_MODEL": ("model_name", str),
            "CODAI_CTX": ("ctx", int),
            "CODAI_THREADS": ("threads", int),
            "CODAI_DEBUG": ("debug", lambda x: str(x).lower() in ("true", "1", "yes")),
            "CODAI_LOG_LEVEL": ("log_level", str),
        }
        for env_key, (attr, cast) in mapping.items():
            val = os.environ.get(env_key)
            if val is not None:
                try:
                    setattr(self, attr, cast(val))
                    logger.info("Env override: %s=%s", env_key, val)
                except (ValueError, TypeError) as exc:
                    logger.warning("Bad env value %s=%s: %s", env_key, val, exc)


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


def ensure_log_directory(base_path: str) -> str:
    """Create and return the logs/ directory under *base_path*."""
    log_dir = os.path.join(base_path, "logs")
    os.makedirs(log_dir, exist_ok=True)
    return log_dir
