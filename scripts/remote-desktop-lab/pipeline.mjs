// Isolated video benchmark, never an Agent transport or production configuration.
export const MEDIA_MTX_VERSION = 'v1.17.1';
export const PORTS = Object.freeze({ rtsp: 18554, http: 18889, ice: 18189 });

export function settings(input = {}) {
  const result = { source: 'synthetic', encoder: 'libx264', fps: 30, bitrate: 4000,
    width: 1280, seconds: 120, monitor: 0, ...input };
  if (!['synthetic', 'desktop'].includes(result.source)) throw Error('Invalid source');
  if (!['libx264', 'h264_nvenc'].includes(result.encoder)) throw Error('Invalid encoder');
  for (const [key, min, max] of [['fps', 10, 60], ['bitrate', 500, 12000],
    ['width', 640, 1920], ['seconds', 5, 300], ['monitor', 0, 15]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max)
      throw Error(`Invalid ${key}`);
  }
  if (result.width % 2) throw Error('Width must be even');
  return result;
}

export function ffmpegArgs(input = {}) {
  const s = settings(input);
  const source = s.source === 'desktop'
    ? `ddagrab=output_idx=${s.monitor}:framerate=${s.fps}:draw_mouse=1:dup_frames=1`
    : `testsrc2=size=${s.width}x720:rate=${s.fps}`;
  // CPU conversion is deliberate for this compatibility benchmark. Not zero-copy.
  const filter = (s.source === 'desktop' ? 'hwdownload,format=bgra,' : '')
    + `scale=w='min(${s.width},iw)':h=-2,format=yuv420p`;
  const encoder = s.encoder === 'libx264'
    ? ['-preset', 'ultrafast', '-tune', 'zerolatency', '-x264-params', 'scenecut=0:rc-lookahead=0']
    : ['-preset', 'p1', '-tune', 'ull', '-rc', 'cbr', '-rc-lookahead', '0', '-zerolatency', '1'];
  return ['-hide_banner', '-nostdin', '-loglevel', 'warning',
    ...(s.source === 'synthetic' ? ['-re'] : []), '-f', 'lavfi', '-i', source,
    '-an', '-vf', filter, '-c:v', s.encoder, ...encoder,
    '-profile:v', 'baseline', '-bf', '0', '-g', String(s.fps),
    '-b:v', `${s.bitrate}k`, '-maxrate', `${s.bitrate}k`,
    '-bufsize', `${Math.ceil(s.bitrate / 4)}k`, '-t', String(s.seconds),
    '-flush_packets', '1', '-f', 'rtsp', '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:${PORTS.rtsp}/benchmark`];
}

export function mediaConfig() {
  // JSON is valid YAML. No production env, secrets, paths or runOn* hooks.
  return {
    logLevel: 'warn', readTimeout: '5s', writeTimeout: '5s', writeQueueSize: 64,
    api: false, metrics: false, pprof: false, playback: false,
    rtmp: false, hls: false, srt: false,
    rtsp: true, rtspAddress: `127.0.0.1:${PORTS.rtsp}`, rtspTransports: ['tcp'],
    webrtc: true, webrtcAddress: `127.0.0.1:${PORTS.http}`,
    webrtcAllowOrigins: [`http://127.0.0.1:${PORTS.http}`],
    webrtcLocalUDPAddress: `127.0.0.1:${PORTS.ice}`, webrtcLocalTCPAddress: '',
    webrtcIPsFromInterfaces: false, webrtcAdditionalHosts: ['127.0.0.1'],
    webrtcICEServers2: [], authMethod: 'internal',
    authInternalUsers: [{ user: 'any', ips: ['127.0.0.1'],
      permissions: [{ action: 'publish', path: 'benchmark' }, { action: 'read', path: 'benchmark' }] }],
    paths: { benchmark: { source: 'publisher', overridePublisher: false, record: false } },
  };
}

export function childEnvironment(env) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'home',
    'userprofile', 'localappdata', 'systemdrive']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())));
}

export function assertLocalCapture({ source, allowed = false, platform, hostname }) {
  if (hostname.toUpperCase() === 'DEPLOY') throw Error('Do not run this lab on DEPLOY');
  if (source === 'desktop' && (platform !== 'win32' || !allowed))
    throw Error('Desktop capture requires Windows and --allow-local-capture');
}
