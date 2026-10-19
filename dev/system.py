"""
Codai Pro — System Module
Hardware detection, resource-aware optimization, system info exposure,
and startup phase tracking.
"""

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict

import psutil

from dev.config import CodaiConfig, PHASE_INITIALIZING

logger = logging.getLogger("codai.system")


# ---------------------------------------------------------------------------
# Hardware analysis  (CPU-aware threads)
# ---------------------------------------------------------------------------

def analyze_system_resources(config: CodaiConfig) -> None:
    """Detect RAM and CPU, then set context size and thread count.

    RAM tiers control the *ceiling* for context and threads.
    Actual thread count is ``min(physical_cores, tier_limit)`` so
    machines with fewer cores are not over-subscribed.
    """
    try:
        memory = psutil.virtual_memory()
        config.ram_gb = round(memory.total / (1024 ** 3), 2)
        available_gb = round(memory.available / (1024 ** 3), 2)
        logger.info(
            "Hardware Analysis: %.2f GB RAM detected (%.2f GB available).",
            config.ram_gb,
            available_gb,
        )

        physical_cores = psutil.cpu_count(logical=False) or 1
        config.cpu_cores = physical_cores
        logger.info("CPU cores (physical): %d", physical_cores)

        # Tier on total RAM, but step down when other programs have already
        # consumed the memory the engine needs. Otherwise an 8 GB machine with
        # a browser open tries the 2048 context and llama-server dies with a
        # "bad allocation" error during the first reply.
        if config.ram_gb < 2.5 or available_gb < 1.5:
            tier_ctx = 512
            tier_threads = 1
            config.ram_tier = "Tier 3 (Low RAM)"
            logger.warning(
                "%s: Limiting context to %d, max %d thread(s)",
                config.ram_tier, tier_ctx, tier_threads,
            )
        elif config.ram_gb < 6.0 or available_gb < 2.5:
            tier_ctx = 1024
            tier_threads = 2
            config.ram_tier = "Tier 2 (Standard)"
            logger.info(
                "%s: Context %d, max %d thread(s)",
                config.ram_tier, tier_ctx, tier_threads,
            )
        else:
            tier_ctx = 2048
            tier_threads = 4
            config.ram_tier = "Tier 1 (High-End)"
            logger.info(
                "%s: Context %d, max %d thread(s)",
                config.ram_tier, tier_ctx, tier_threads,
            )

        if "ctx" not in config.overrides:
            config.ctx = tier_ctx
        if "threads" not in config.overrides:
            config.threads = min(physical_cores, tier_threads)
        logger.info(
            "Final settings -> ctx=%d, threads=%d", config.ctx, config.threads
        )

    except Exception as exc:
        logger.warning(
            "Could not probe hardware (%s). Defaulting to fail-safe mode.", exc
        )
        if "ctx" not in config.overrides:
            config.ctx = 512
        if "threads" not in config.overrides:
            config.threads = 1
        config.ram_tier = "Tier 3 (Fail-safe)"



