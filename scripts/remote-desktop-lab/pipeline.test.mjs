import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, ffmpegArgs, mediaConfig, childEnvironment, assertLocalCapture } from './pipeline.mjs';

test('synthetic input is default, never silently captures a desktop', () => {
  assert.equal(settings().source, 'synthetic');
  assert.ok(ffmpegArgs().some(value => value.startsWith('testsrc2=')));
});
test('DXGI capture explicitly downloads hardware surfaces before software conversion', () => {
  const args = ffmpegArgs({ source: 'desktop' });
  assert.match(args[args.indexOf('-i') + 1], /^ddagrab=/);
  assert.match(args[args.indexOf('-vf') + 1], /^hwdownload,format=bgra,/);
  assert.ok(!args.includes('-re'));
});
test('software H264 uses zerolatency, no B frames and bounded VBV', () => {
  const args = ffmpegArgs();
  assert.equal(args[args.indexOf('-tune') + 1], 'zerolatency');
  assert.equal(args[args.indexOf('-bf') + 1], '0');
  assert.equal(args[args.indexOf('-bufsize') + 1], '1000k');
  assert.equal(args[args.indexOf('-g') + 1], '30');
});
test('NVIDIA encoder has explicit low latency settings and no lookahead', () => {
  const args = ffmpegArgs({ encoder: 'h264_nvenc' });
  assert.equal(args[args.indexOf('-tune') + 1], 'ull');
  assert.equal(args[args.indexOf('-rc-lookahead') + 1], '0');
});
test('publisher destination cannot be supplied by caller', () => {
  assert.equal(ffmpegArgs({ destination: 'rtsp://production/stream' }).at(-1), 'rtsp://127.0.0.1:18554/benchmark');
});
test('invalid profiles and unbounded resources fail closed', () => {
  for (const value of [{ source: 'webcam' }, { encoder: 'arbitrary' }, { seconds: 301 },
    { fps: 61 }, { width: 1001 }, { bitrate: Infinity }, { monitor: -1 }])
    assert.throws(() => settings(value));
});
test('all media listeners and candidates are loopback-only', () => {
  const config = mediaConfig();
  for (const key of ['rtspAddress', 'webrtcAddress', 'webrtcLocalUDPAddress'])
    assert.match(config[key], /^127\.0\.0\.1:/);
  assert.equal(config.webrtcLocalTCPAddress, '');
  assert.equal(config.webrtcIPsFromInterfaces, false);
  assert.deepEqual(config.webrtcAdditionalHosts, ['127.0.0.1']);
  assert.deepEqual(config.webrtcICEServers2, []);
});
test('recording, secondary protocols and administrative endpoints are disabled', () => {
  const config = mediaConfig();
  for (const key of ['api', 'metrics', 'pprof', 'playback', 'rtmp', 'hls', 'srt']) assert.equal(config[key], false);
  assert.equal(config.paths.benchmark.record, false);
  assert.equal(config.paths.benchmark.overridePublisher, false);
});
test('anonymous lab access is restricted to loopback and a single path', () => {
  const config = mediaConfig();
  assert.deepEqual(config.authInternalUsers[0].ips, ['127.0.0.1']);
  assert.deepEqual(config.authInternalUsers[0].permissions.map(p => p.path), ['benchmark', 'benchmark']);
  assert.deepEqual(config.webrtcAllowOrigins, ['http://127.0.0.1:18889']);
});
test('children do not inherit production or MediaMTX override variables', () => {
  assert.deepEqual(childEnvironment({ PATH: '/bin', SystemRoot: 'C:\\Windows',
    DATABASE_URL: 'secret', ADMIN_API_TOKEN: 'secret', MTX_WEBRTCADDRESS: ':8889', FFREPORT: 'file=out' }),
  { PATH: '/bin', SystemRoot: 'C:\\Windows' });
});
test('desktop capture requires Windows and explicit consent', () => {
  assert.throws(() => assertLocalCapture({ source: 'desktop', platform: 'linux', allowed: true, hostname: 'lab' }));
  assert.throws(() => assertLocalCapture({ source: 'desktop', platform: 'win32', hostname: 'lab' }));
  assert.doesNotThrow(() => assertLocalCapture({ source: 'desktop', platform: 'win32', allowed: true, hostname: 'lab' }));
});
test('DEPLOY is rejected even for synthetic mode', () => {
  assert.throws(() => assertLocalCapture({ source: 'synthetic', platform: 'win32', hostname: 'deploy' }));
});
