import urllib.request
import json

def fetch(url):
    import socket
    TIMEOUT = 10
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = resp.read()
            print(f"[{url}] HTTP {resp.status} Response length: {len(data)}")
            print(f"[{url}] HTTP {resp.status} Response raw: {repr(data)}")
    except (urllib.error.URLError, socket.timeout) as e:
        print(f"[{url}] Timeout or URL error: {e}")
    except Exception as e:
        print(f"[{url}] Error: {e}")

fetch("http://127.0.0.1:8081/health")
fetch("http://127.0.0.1:8081/logs")
fetch("http://127.0.0.1:8081/v1/models")
