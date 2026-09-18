# Remote Desktop performance: local phase 1

Local implementation only. No production deployment or endpoint session was performed.
DXGI, WebRTC, protocol changes, authorization and gates are outside this patch.
Existing unrelated worktree changes, including the separate helper-startup fix worktree,
must be reviewed separately when preparing a future release.

## Bounded frame delivery

- Gateway: one frame sent through ws at a time; one replaceable pending latest frame.
  Teardown clears pending state. Existing frame validation and size limits run first.
  Frames are not queued behind buffered control traffic; future frames retry delivery.
- Browser: one JPEG decode in flight, one latest pending frame. Decoder errors do not
  block later frames. Disconnect/reconnect invalidates old frames, and bitmaps are closed.
- Already handed-off TCP data cannot be recalled. These bounds prevent application
  FIFO growth; they do not eliminate all OS/network buffering.
- Agent capture/send loops remain sequential, with no additional producer queue.

## Measurements

- Windows EventSource `Nexora-RemoteDesktop-Performance`, event `FrameWindow`:
  average CaptureMs (including scale), EncodeMs, SendMs, FrameBytes, Width, Quality
  over 24 frames. Helper mode measures pipe-send time; in-process mode measures
  WebSocket-send time. Capture failure still terminates after existing limits.
- Service logger event `RemoteDesktopTransport`: frames, bytes and mean WebSocket
  send completion time per approximately ten seconds of frames.
- Gateway logger event `RemoteDesktopPerformance`: cumulative sent/dropped frames,
  last send-completion milliseconds, buffered bytes, existing session ID. No image,
  input payload, tokens or credentials are logged.
- Viewer: rendered FPS over the last sampling interval, latest decode/draw duration,
  cumulative overwritten pending frames. Counters are per connection.

Send-completion time is NOT viewer RTT or end-to-end display latency. This phase
does not transmit viewer feedback to the Agent. Browser/network-only slowness may
increase drops without reducing capture quality when upstream sends remain fast.

## Adaptive local quality

Every 24 valid samples, pressure is average capture+encode+send over 100 ms OR
average image size over 200 KiB. Reduce quality by 5 and width by 160, down to
35/800 (or the original requested value when smaller).

Recovery requires five consecutive healthy windows: cost under 50 ms and size
under 100 KiB. Raise quality/width gradually, never above the original profile.
Middle-band windows reset recovery; invalid samples have no effect. FPS is unchanged.
These initial thresholds need controlled Windows/network measurements before release.

## Local validation

- Queue tests: 7/7 passed, including 100-frame bursts, teardown and decode/send failure.
- Agent RD/core tests: 109/109 passed, including four adaptive-policy tests.
- RD/security/RBAC unit selection: 82/82 passed.
- Full API unit command: 83/83 passed (overlaps the security selection).
- API/frontend TypeScript checks: passed.
- Frontend production build: passed with existing sourcemap/chunk-size warnings.
- API canonical build: passed from disposable writable storage.
- No live Windows performance, real screen capture, real viewer latency or production
  acceptance result is claimed. Windows helper startup validation remains separate.

## Next validation

With separate authorization on a controlled Windows endpoint, compare the same
resolution/content before and after under LAN and constrained bandwidth. Record
CPU, encoded bytes, capture/encode/send cost, gateway drops and browser decode/FPS.
Include static desktop, scrolling, reconnect, resize and slow decoder scenarios.
Check text readability at the lower profile and recovery when pressure subsides.
Do not treat lower queue length alone as proof of an RDP-equivalent experience.
