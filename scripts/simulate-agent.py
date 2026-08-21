#!/usr/bin/env python3
import argparse, json, platform, time, urllib.request, uuid

def post(url, body, token=None):
    headers = {"Content-Type": "application/json"}
    if token: headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, json.dumps(body).encode(), headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read()
        return json.loads(payload) if payload else None

parser = argparse.ArgumentParser(description="Exercise Agent V1 APIs; this does not replace Windows validation.")
parser.add_argument("--api-base-url", required=True)
parser.add_argument("--enrollment-token", required=True)
args = parser.parse_args()
base, device_uuid = args.api_base_url.rstrip("/"), str(uuid.uuid4())
enrollment = post(f"{base}/v1/agents/enroll", {"enrollment_token": args.enrollment_token, "device_uuid": device_uuid, "hostname": platform.node() or "nexora-simulator", "machine_guid_hash": "0" * 64, "agent_version": "simulator-0.1.0"})
token = enrollment["agent_token"]
post(f"{base}/v1/agents/inventory", {"device_uuid": device_uuid, "hostname": platform.node() or "nexora-simulator", "agent_version": "simulator-0.1.0", "current_user": None, "domain": None, "os": {"name": platform.system(), "version": platform.version(), "build": platform.release(), "architecture": platform.machine()}, "hardware": {}, "disks": [], "network": []}, token)
post(f"{base}/v1/agents/heartbeat", {"agent_version": "simulator-0.1.0", "uptime_seconds": int(time.monotonic()), "logged_in_user": None, "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, token)
post(f"{base}/v1/agents/metrics", {"captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cpu_percent": 0, "ram_percent": 0, "ram_used_bytes": 0, "ram_available_bytes": 0, "disk_percent": 0, "uptime_seconds": int(time.monotonic())}, token)
print(json.dumps({"device_id": enrollment["device_id"], "agent_id": enrollment["agent_id"]}, indent=2))
