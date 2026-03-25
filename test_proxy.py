import json
import socket
import urllib.request
from pathlib import Path


TIMEOUT = 10
PROJECT_ROOT = Path(__file__).resolve().parent
CONFIG_PATH = PROJECT_ROOT / "config.json"


def get_port() -> int:
    if not CONFIG_PATH.is_file():
        return 8080
    try:
        payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return int(payload.get("port", 8080))
    except (OSError, json.JSONDecodeError, AttributeError, ValueError, TypeError):
        return 8080


def fetch(url: str) -> None:
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = resp.read()
            print(f"[{url}] HTTP {resp.status} Response length: {len(data)}")
            print(f"[{url}] HTTP {resp.status} Response raw: {repr(data)}")
    except (urllib.error.URLError, socket.timeout) as exc:
        print(f"[{url}] Timeout or URL error: {exc}")
    except Exception as exc:
        print(f"[{url}] Error: {exc}")


PORT = get_port()
BASE_URL = f"http://127.0.0.1:{PORT}"

fetch(f"{BASE_URL}/health")
fetch(f"{BASE_URL}/logs")
fetch(f"{BASE_URL}/v1/models")
