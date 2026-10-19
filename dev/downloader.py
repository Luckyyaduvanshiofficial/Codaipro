"""
Codai Pro — Model downloader.

Fetches the configured GGUF model on first run so the installer does not have to
ship a large model. Downloads resume from a partial ``.part`` file and only replace
the final model after the full byte count is written.
"""

from __future__ import annotations

import logging
import os
import shutil
import time
import urllib.error
import urllib.request
from typing import Callable, Optional

logger = logging.getLogger("codai.download")

CHUNK_SIZE = 1024 * 256
USER_AGENT = "CodaiPro/3.2"
MAX_RETRIES = 3

ProgressCallback = Callable[[int, int], None]


class DownloadError(RuntimeError):
    """Raised when a model download cannot be completed."""


def _content_length(response) -> Optional[int]:
    raw = response.headers.get("Content-Length")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def download_file(
    url: str,
    destination: str,
    on_progress: Optional[ProgressCallback] = None,
    expected_size: Optional[int] = None,
    timeout: int = 30,
) -> str:
    """
    Download *url* to *destination*, resuming a partial ``<destination>.part`` file.

    ``on_progress(downloaded, total)`` is called as data arrives (``total`` may be -1
    when the server does not report a length). Returns the destination path.
    """
    part_path = destination + ".part"
    os.makedirs(os.path.dirname(destination), exist_ok=True)

    already = os.path.getsize(part_path) if os.path.exists(part_path) else 0
    if expected_size is not None and already == expected_size:
        os.replace(part_path, destination)
        return destination

    if expected_size is not None and already > expected_size:
        os.remove(part_path)
        already = 0

    for attempt in range(1, MAX_RETRIES + 1):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        if already:
            request.add_header("Range", f"bytes={already}-")

        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                resumed = response.status == 206
                if already and not resumed:
                    already = 0

                total = _content_length(response)
                if total is not None:
                    total += already

                mode = "ab" if resumed and already else "wb"
                downloaded = already
                with open(part_path, mode) as handle:
                    while True:
                        chunk = response.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        handle.write(chunk)
                        downloaded += len(chunk)
                        if on_progress:
                            on_progress(downloaded, total if total is not None else -1)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt == MAX_RETRIES:
                raise DownloadError(f"Download failed: {exc}") from exc
            logger.warning("Download attempt %d failed (%s); retrying...", attempt, exc)
            time.sleep(2 * attempt)
            already = os.path.getsize(part_path) if os.path.exists(part_path) else 0
            continue

        final_size = os.path.getsize(part_path)
        if expected_size is not None and final_size != expected_size:
            raise DownloadError(
                f"Incomplete download: {final_size} of {expected_size} bytes"
            )
        os.replace(part_path, destination)
        return destination

    raise DownloadError("Download failed after retries.")


def discard_partial(destination: str) -> None:
    """Remove a partial download, if one exists."""
    part_path = destination + ".part"
    try:
        os.remove(part_path)
    except FileNotFoundError:
        pass


def move_into_place(source: str, destination: str) -> None:
    """Move a finished download into its final location, replacing any existing file."""
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    if os.path.exists(destination):
        os.remove(destination)
    shutil.move(source, destination)
