import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { settings, ffmpegArgs, mediaConfig, childEnvironment, assertLocalCapture,
  MEDIA_MTX_VERSION, PORTS } from './pipeline.mjs';

const { values } = parseArgs({ options: {
  ffmpeg: { type: 'string' }, mediamtx: { type: 'string' },
  source: { type: 'string' }, encoder: { type: 'string' },
  fps: { type: 'string' }, bitrate: { type: 'string' }, width: { type: 'string' },
  seconds: { type: 'string' }, monitor: { type: 'string' },
  'allow-local-capture': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
} });
const options = {};
for (const key of ['source', 'encoder', 'fps', 'bitrate', 'width', 'seconds', 'monitor'])
  if (values[key] !== undefined) options[key] = ['source', 'encoder'].includes(key) ? values[key] : Number(values[key]);
const s = settings(options);
assertLocalCapture({ ...s, allowed: values['allow-local-capture'], platform: process.platform, hostname: hostname() });
if (values['dry-run']) {
  console.log(JSON.stringify({ settings: s, ffmpegArguments: ffmpegArgs(s), mediaConfig: mediaConfig() }, null, 2));
} else {
  if (!values.ffmpeg || !values.mediamtx) throw Error('Explicit --ffmpeg and --mediamtx executable paths required');
  const ffmpeg = await realpath(values.ffmpeg);
  const mediamtx = await realpath(values.mediamtx);
  const env = childEnvironment(process.env);
  const version = execFileSync(mediamtx, ['--version'], { env, timeout: 10000, encoding: 'utf8' }).trim();
  if (version !== MEDIA_MTX_VERSION) throw Error(`Expected MediaMTX ${MEDIA_MTX_VERSION}, got ${version}`);
  const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { env, timeout: 10000, encoding: 'utf8' });
  if (s.source === 'desktop' && !/\bddagrab\b/.test(filters)) throw Error('FFmpeg lacks ddagrab');
  const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { env, timeout: 10000, encoding: 'utf8' });
  if (!encoders.includes(s.encoder)) throw Error('Requested H.264 encoder unavailable; select libx264 explicitly for software');

  for (const port of [PORTS.rtsp, PORTS.http]) {
    const server = createServer();
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    await new Promise(resolve => server.close(resolve));
  }
  const udp = createSocket('udp4');
  udp.bind(PORTS.ice, '127.0.0.1');
  await once(udp, 'listening');
  udp.close();

  const directory = await mkdtemp(join(tmpdir(), 'nexora-video-lab-'));
  const children = [];
  let stopping = false;
  let force;
  const stop = () => {
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill();
    force ??= setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Bound capture even if the encoder stalls before it advances its media clock.
  const deadline = setTimeout(stop, (s.seconds + 15) * 1000);
  const start = (file, args) => {
    const child = spawn(file, args, { env, cwd: directory, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
    child.completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    // Attach immediately, including while waiting for the server to become ready.
    child.completion.catch(stop);
    children.push(child);
    return child;
  };
  try {
    const config = join(directory, 'mediamtx.yml');
    await writeFile(config, JSON.stringify(mediaConfig(), null, 2), { mode: 0o600 });
    const server = start(mediamtx, [config]);
    let ready = false;
    for (let attempt = 0; attempt < 30 && !stopping; attempt++) {
      if (server.exitCode !== null) throw Error('Media server exited before readiness');
      try {
        const response = await fetch(`http://127.0.0.1:${PORTS.http}/benchmark/`, { signal: AbortSignal.timeout(500) });
        await response.body?.cancel();
        if (response.ok) { ready = true; break; }
      } catch { /* Listener is still starting. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready || stopping) throw Error('Local media server did not become ready');
    const publisher = start(ffmpeg, ffmpegArgs(s));
    console.log(`LOCAL VIDEO ONLY: http://127.0.0.1:${PORTS.http}/benchmark/`);
    console.log(`Source=${s.source}; encoder=${s.encoder}; target=${s.fps}fps; limit=${s.seconds}s. No Nexora session or input control.`);
    const result = await Promise.race([
      publisher.completion,
      server.completion.then(() => { throw Error('Media server stopped during capture'); }),
    ]);
    if (result.code !== 0) throw Error('Capture ended without success; no automatic retry');
  } finally {
    clearTimeout(deadline);
    stop();
    await Promise.allSettled(children.map(child => child.completion));
    clearTimeout(force);
    await rm(directory, { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
