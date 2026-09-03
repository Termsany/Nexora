#!/usr/bin/env python3
import argparse, hashlib, json, time, urllib.error, urllib.request, uuid

def request(method, url, body=None, token=None, expected=(200, 201, 204)):
    headers = {"Content-Type": "application/json"}
    if token: headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data, headers, method=method), timeout=30) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    assert status in expected, f"{method} {url}: expected {expected}, got {status}: {raw.decode()}"
    return json.loads(raw) if raw else None

parser = argparse.ArgumentParser(description="Run Agent V1 integration tests against a disposable Nexora environment.")
parser.add_argument("--api-base-url", required=True)
parser.add_argument("--admin-token", required=True)
parser.add_argument("--offline-wait-seconds", type=int, default=0)
args = parser.parse_args()
base = args.api_base_url.rstrip("/")

def create_token(name, seconds=300, uses=1):
    return request("POST", f"{base}/v1/admin/enrollment-tokens", {"name": name, "organization": "Integration Tests", "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + seconds)), "max_uses": uses}, args.admin_token)

def enroll(raw_token, device_uuid):
    return request("POST", f"{base}/v1/agents/enroll", {"enrollment_token": raw_token, "device_uuid": device_uuid, "hostname": "NEXORA-TEST", "machine_guid_hash": hashlib.sha256(b"nexora-test").hexdigest(), "agent_version": "test-0.1.0"}, expected=(201,))

request("POST", f"{base}/v1/agents/enroll", {}, expected=(400,))
invalid_id = str(uuid.uuid4())
request("POST", f"{base}/v1/agents/enroll", {"enrollment_token": "invalid", "device_uuid": invalid_id, "hostname": "TEST", "machine_guid_hash": "0" * 64, "agent_version": "test"}, expected=(401,))

device_uuid = str(uuid.uuid4())
first = enroll(create_token("valid")["token"], device_uuid)
second = enroll(create_token("duplicate-device")["token"], device_uuid)
assert first["device_id"] == second["device_id"], "duplicate device UUID created a new device"

request("POST", f"{base}/v1/agents/heartbeat", {"agent_version": "test", "uptime_seconds": 1}, "invalid-agent-token", expected=(401,))
agent_token = second["agent_token"]
request("POST", f"{base}/v1/agents/heartbeat", {"agent_version": "test-0.1.0", "uptime_seconds": 10, "logged_in_user": "tester"}, agent_token, (204,))
request("POST", f"{base}/v1/agents/inventory", {"device_uuid": device_uuid, "hostname": "NEXORA-TEST", "agent_version": "test-0.1.0", "current_user": "tester", "domain": "TEST", "os": {"name": "Windows Test", "version": "1", "build": "1", "architecture": "x64"}, "hardware": {"manufacturer": "Test", "model": "Test", "cpu_model": "Test", "logical_processors": 1, "total_ram_bytes": 1024, "bios_version": "1"}, "disks": [], "network": []}, agent_token, (204,))
request("POST", f"{base}/v1/agents/metrics", {"captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cpu_percent": 10, "ram_percent": 20, "ram_used_bytes": 200, "ram_available_bytes": 800, "disk_percent": 30, "uptime_seconds": 10}, agent_token, (204,))

revoked = create_token("revoked")
request("POST", f"{base}/v1/admin/enrollment-tokens/{revoked['id']}/revoke", token=args.admin_token, expected=(204,))
request("POST", f"{base}/v1/agents/enroll", {"enrollment_token": revoked["token"], "device_uuid": str(uuid.uuid4()), "hostname": "TEST", "machine_guid_hash": "0" * 64, "agent_version": "test"}, expected=(401,))

limited = create_token("maximum-uses")
enroll(limited["token"], str(uuid.uuid4()))
request("POST", f"{base}/v1/agents/enroll", {"enrollment_token": limited["token"], "device_uuid": str(uuid.uuid4()), "hostname": "TEST", "machine_guid_hash": "0" * 64, "agent_version": "test"}, expected=(401,))

expiring = create_token("expired", seconds=1)
time.sleep(2)
request("POST", f"{base}/v1/agents/enroll", {"enrollment_token": expiring["token"], "device_uuid": str(uuid.uuid4()), "hostname": "TEST", "machine_guid_hash": "0" * 64, "agent_version": "test"}, expected=(401,))

summary = request("GET", f"{base}/v1/dashboard/summary")
assert summary["online_devices"] >= 1
if args.offline_wait_seconds:
    time.sleep(args.offline_wait_seconds)
    summary = request("GET", f"{base}/v1/dashboard/summary")
    assert summary["offline_devices"] >= 1
print("Agent API integration tests passed")
