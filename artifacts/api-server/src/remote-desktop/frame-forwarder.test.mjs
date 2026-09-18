import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameForwarder } from './frame-forwarder.ts';

test('slow viewer keeps only in-flight and latest frame', () => {
  const sent = [], callbacks = [];
  const socket = { bufferedAmount: 0, send: (frame, _, done) => { sent.push(frame[0]); callbacks.push(done); } };
  let completed = 0;
  const queue = new FrameForwarder(socket, () => completed++);
  for (let i = 0; i < 100; i++) queue.offer(Buffer.from([i]));
  assert.deepEqual(sent, [0]);
  callbacks.shift()();
  assert.deepEqual(sent, [0, 99]);
  callbacks.shift()();
  assert.equal(completed, 2);
  assert.equal(queue.dropped, 98);
});

test('control backpressure never receives more queued video', () => {
  const sent = [];
  const socket = { bufferedAmount: 512, send: frame => sent.push(frame[0]) };
  const queue = new FrameForwarder(socket, () => {});
  queue.offer(Buffer.from([1])); queue.offer(Buffer.from([2]));
  assert.deepEqual(sent, []);
  socket.bufferedAmount = 0;
  queue.offer(Buffer.from([3]));
  assert.deepEqual(sent, [3]);
});

test('teardown prevents callback from sending a pending frame', () => {
  let callback, sent = 0;
  const queue = new FrameForwarder({ bufferedAmount: 0, send: (_, __, done) => { sent++; callback = done; } }, () => {});
  queue.offer(Buffer.from([1])); queue.offer(Buffer.from([2])); queue.close(); callback();
  assert.equal(sent, 1);
});

test('send failure drops pending work without throwing', () => {
  const queue = new FrameForwarder({ bufferedAmount: 0, send: () => { throw new Error('closed'); } }, () => {});
  assert.doesNotThrow(() => { queue.offer(Buffer.from([1])); queue.offer(Buffer.from([2])); });
  assert.equal(queue.sent, 0);
});
