#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    message = "Nexora platform health requires attention"
    spool = Path(os.environ.get("NEXORA_NOTIFY_SPOOL", "/var/lib/nexora-notify/incidents.log"))
    with spool.open("a") as stream:
        stream.write(json.dumps({"time": int(time.time()), "message": message}) + "\n")
    print(message, flush=True)
    credential = Path(os.environ.get("CREDENTIALS_DIRECTORY", "/etc/nexora-notify/credentials")) / "webhook"
    if not credential.exists():
        return
    value = json.loads(credential.read_text())
    url = value["url"]
    if not isinstance(url, str) or not url.startswith("https://") or any(ord(c) < 32 for c in url):
        raise ValueError("invalid notification configuration")
    quote = lambda s: '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    config = 'url = ' + quote(url) + '\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = ' + quote(json.dumps({"text": message})) + '\n'
    result = subprocess.run(["curl", "--silent", "--fail", "--max-time", "10", "--config", "-"],
                            input=config, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
    if result.returncode:
        raise RuntimeError("notification delivery failed")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired):
        print("notification failed; inspect local service state", file=sys.stderr)
        sys.exit(1)
