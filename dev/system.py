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
        total_ram_bytes = psutil.virtual_memory().total
        config.ram_gb = round(total_ram_bytes / (1024 ** 3), 2)
        logger.info("Hardware Analysis: %.2f GB RAM detected.", config.ram_gb)

        physical_cores = psutil.cpu_count(logical=False) or 1
        config.cpu_cores = physical_cores
        logger.info("CPU cores (physical): %d", physical_cores)

        if config.ram_gb < 2.5:
            tier_ctx = 512
            tier_threads = 1
            config.ram_tier = "Tier 3 (Low RAM)"
            logger.warning(
                "%s: Limiting context to %d, max %d thread(s)",
                config.ram_tier, tier_ctx, tier_threads,
            )
        elif config.ram_gb < 6.0:
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

        config.ctx = tier_ctx
        config.threads = min(physical_cores, tier_threads)
        logger.info(
            "Final settings -> ctx=%d, threads=%d", config.ctx, config.threads
        )

    except Exception as exc:
        logger.warning(
            "Could not probe hardware (%s). Defaulting to fail-safe mode.", exc
        )
        config.ctx = 512
        config.threads = 1
        config.ram_tier = "Tier 3 (Fail-safe)"



