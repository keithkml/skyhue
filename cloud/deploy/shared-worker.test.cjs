const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { supervise, specifications } = require('./shared-worker.cjs');

test('deployment keeps Nest checkout and both runtimes separate under the Skyhue root', () => {
  const [nest, globe] = specifications('/app/cloud');
  assert.equal(nest.cwd, '/app/cloud/.nest');
  assert.equal(nest.command, '/app/cloud/.nest-runtime/bin/node');
  assert.deepEqual(nest.args, ['nest-logger.js']);
  assert.equal(globe.cwd, '/app/cloud');
  assert.equal(globe.command, '/app/cloud/.runtime/bin/node');
  assert.deepEqual(globe.args, ['/app/cloud/deploy/skyhue-launch.mjs']);
});

test('a failed globe restarts independently and shutdown stops both processes', async () => {
  const children = [];
  const specs = ['nest', 'skyhue'].map(name => ({ name, command: name, args: [], env: {} }));
  const worker = supervise(specs, {
    restartDelay: 1, shutdownMs: 100,
    log() {},
    spawnImpl(command) {
      const child = new EventEmitter(); child.command = command;
      child.kill = signal => { child.signal = signal; queueMicrotask(() => child.emit('close', 0, signal)); };
      children.push(child); return child;
    },
  });
  assert.deepEqual(children.map(c => c.command), ['nest', 'skyhue']);
  children[1].emit('close', 1, null);
  await sleep(15);
  assert.deepEqual(children.map(c => c.command), ['nest', 'skyhue', 'skyhue']);
  assert.equal(children[0].signal, undefined);
  await worker.stop();
  assert.equal(children[0].signal, 'SIGTERM');
  assert.equal(children[2].signal, 'SIGTERM');
  await sleep(15);
  assert.equal(children.length, 3);
});

test('shutdown cancels pending restarts', async () => {
  let launches = 0;
  const child = new EventEmitter();
  const worker = supervise([{ name: 'skyhue', command: 'node', args: [] }], {
    log() {}, restartDelay: 20,
    spawnImpl() { launches++; return child; },
  });
  child.emit('close', 1, null);
  await worker.stop(); await sleep(50);
  assert.equal(launches, 1);
});
