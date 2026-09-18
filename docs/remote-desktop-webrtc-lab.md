# Local DXGI / H.264 / WebRTC video benchmark

This is a **video-only engineering prototype**, not the Nexora Remote Desktop
production transport. It does not speed up existing deployed sessions. It does
not read Agent credentials, connect to the API, change gates, inject input, or
create sessions. Existing dirty Agent/API/UI work is preserved.

## Pipeline

Windows DXGI Desktop Duplication (`ddagrab`) -> CPU pixel conversion -> H.264
(`libx264` or explicit `h264_nvenc`) -> local RTSP/TCP -> MediaMTX -> WebRTC/UDP
-> MediaMTX's existing browser player. No JPEG frame queue in this path.

This deliberately uses established media engines rather than implementing ICE,
DTLS/SRTP, RTP packetization or H.264. NVIDIA encoding is optional; selection
failure stops, without silent fallback or repeat capture. Select software
explicitly when GPU encoding is unavailable. GPU-to-CPU conversion remains a
known cost; this is not a zero-copy implementation.

FFmpeg settings disable B frames/lookahead, use a one-second GOP, a bounded VBV,
and low-latency encoder presets. These are settings, **not measured latency or
RDP-equivalence claims**. Fixed bitrate is not adaptive bitrate: WebRTC transport
feedback does not automatically reconfigure this external RTSP publisher.

## Local prerequisites

- Node 22, consistent with repository tooling.
- An independently verified FFmpeg executable containing `ddagrab` (Windows),
  `libx264`, and optionally `h264_nvenc` with a compatible NVIDIA GPU/driver.
- MediaMTX **v1.17.1** executable. Other versions are rejected until reviewed.
- A disposable Windows workstation, **not DEPLOY**, with an unlocked interactive
  desktop. Do not run in Session 0 or against sensitive screen contents.

The launcher neither installs nor downloads dependencies. Review binary hashes
and licenses before use/distribution: MediaMTX is MIT; FFmpeg licensing depends
on its build, and libx264-enabled distributions generally involve GPL terms.
No binaries are packaged with Nexora in this change.

## Run

Tests, no capture or network:

```sh
node --test scripts/remote-desktop-lab/pipeline.test.mjs
node scripts/remote-desktop-lab/run.mjs --dry-run
```

Synthetic stream first, in a local Windows terminal:

```powershell
node scripts/remote-desktop-lab/run.mjs --ffmpeg C:\Tools\ffmpeg.exe --mediamtx C:\Tools\mediamtx.exe --source synthetic --seconds 120
```

Then, only on an approved disposable Windows test workstation:

```powershell
node scripts/remote-desktop-lab/run.mjs --ffmpeg C:\Tools\ffmpeg.exe --mediamtx C:\Tools\mediamtx.exe --source desktop --allow-local-capture --encoder h264_nvenc --fps 30 --width 1280 --bitrate 4000 --seconds 120
```

Use `--encoder libx264` for an explicit software comparison. Open
`http://127.0.0.1:18889/benchmark/` on the **same workstation** while running.
There is no production URL. No remote access/firewall/tunnel setup is supported.
Capture stops at the selected duration (maximum 300 seconds), with an additional
wall-clock watchdog. Ctrl+C stops both child processes. Temporary configuration
is removed after child exit. No desktop recording is written.

All listeners/candidates are loopback-only; other protocols, recording and admin
endpoints are disabled. Origin and path restrictions reduce accidental exposure,
but this is **not a multi-user authentication boundary**: local programs/users
can access the stream. Do not expose these ports or use this anonymous media
configuration in production. No production environment is inherited by children.

## Acceptance evidence still required

Record exact FFmpeg/MediaMTX versions and hashes, Windows/GPU/driver, CPU/GPU load,
and browser WebRTC statistics: decoded FPS, dropped frames, jitter-buffer delay,
decode time and RTT. Use a non-sensitive moving test pattern and measure visual
latency separately; RTT alone is not glass-to-glass latency. Compare software and
NVENC under the same resolution/load. Test encoder failure, occupied ports,
Ctrl+C, time limit, desktop lock and display loss. Verify no child survives.

Real DXGI capture, GPU encoding and browser playback have not been certified by
Linux argument/configuration tests. Do not package/deploy based on those tests.

### Local evidence

- Node 22 unit suite: 12 passed, 0 failed, 0 skipped.
- Launcher syntax check and synthetic dry-run: passed.
- Disposable Linux container, FFmpeg 5.1.9 and MediaMTX v1.17.1: synthetic
  H.264/libx264 publication at configured 30fps for five seconds completed with
  exit 0. MediaMTX HTTP player readiness returned success. Child shutdown and
  temporary configuration cleanup completed; the disposable container was removed.
- This smoke test did **not** attach a WebRTC browser receiver. Decoded FPS,
  end-to-end latency, DXGI and NVENC remain unmeasured. No production access.

## Integration follow-up, not implemented here

Production needs session-bound authenticated signaling with existing Nexora
tenant/RBAC/audit checks, immediate revocation on session termination, separately
reviewed bounded input transport, cursor handling, feedback-driven encoder
adaptation, TURN policy and Windows lifecycle tests. The existing JPEG transport
must remain the fallback until these gates pass. Merely adding an unauthenticated
media server to the Agent or proxying this lab URL is not an integration.

References: [FFmpeg ddagrab](https://ffmpeg.org/ffmpeg-filters.html#ddagrab),
[MediaMTX configuration](https://github.com/bluenviron/mediamtx/blob/v1.17.1/mediamtx.yml),
[MediaMTX WebRTC](https://mediamtx.org/docs/usage/webrtc-specific-features).
