import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatestFrameQueue } from './latest-frame.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one decoder and one latest pending frame under overload', async () => {
  const decoded = [], releases = [];
  const queue = new LatestFrameQueue(frame => { decoded.push(frame); return new Promise(resolve => releases.push(resolve)); });
  for (let i = 0; i < 100; i++) queue.offer(i);
  assert.deepEqual(decoded, [0]);
  releases.shift()(); await tick();
  assert.deepEqual(decoded, [0, 99]);
  releases.shift()(); await tick();
  assert.equal(queue.rendered, 2); assert.equal(queue.dropped, 98);
});

test('decode error does not block the next frame', async () => {
  const queue = new LatestFrameQueue(async value => { if (value === 1) throw new Error('invalid jpeg'); });
  queue.offer(1); queue.offer(2); await tick();
  assert.equal(queue.failed, 1); assert.equal(queue.rendered, 1);
});

test('dispose discards pending work and ignores future frames', async () => {
  let release;
  const decoded = [];
  const queue = new LatestFrameQueue(frame => { decoded.push(frame); return new Promise(resolve => { release = resolve; }); });
  queue.offer(1); queue.offer(2); queue.dispose(); queue.offer(3); release(); await tick();
  assert.deepEqual(decoded, [1]); assert.equal(queue.rendered, 0);
});
