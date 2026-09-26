// Keep Nest on its original runtime; run Skyhue in its own Node 22 process.
const { spawn } = require('child_process');
const { join } = require('path');

function supervise(specifications, { spawnImpl = spawn, log = console.log, restartDelay = 5000, shutdownMs = 110000 } = {}) {
  let stopping = false;
  let shutdownTimer;
  const slots = specifications.map(spec => ({ spec, child: null, timer: null, failures: 0 }));
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const emit = (event, details) => log(JSON.stringify({ service: 'shared-worker', event, ...details }));
  function checkStopped() {
    if (stopping && slots.every(slot => !slot.child)) {
      clearTimeout(shutdownTimer);
      finish();
    }
  }
  function start(slot) {
    if (stopping) return;
    const began = Date.now();
    const child = spawnImpl(slot.spec.command, slot.spec.args, {
      cwd: slot.spec.cwd, env: slot.spec.env, stdio: 'inherit',
    });
    slot.child = child;
    emit('process_started', { name: slot.spec.name });
    child.on('error', () => emit('process_error', { name: slot.spec.name }));
    child.once('close', (code, signal) => {
      slot.child = null;
      emit('process_stopped', { name: slot.spec.name, code, signal });
      if (stopping) return checkStopped();
      slot.failures = Date.now() - began > 60000 ? 0 : Math.min(slot.failures + 1, 4);
      slot.timer = setTimeout(() => start(slot), Math.min(60000, restartDelay * 2 ** slot.failures));
    });
  }
  for (const slot of slots) start(slot);
  return {
    done,
    stop() {
      if (stopping) return done;
      stopping = true;
      for (const slot of slots) {
        clearTimeout(slot.timer);
        slot.child?.kill('SIGTERM');
      }
      shutdownTimer = setTimeout(() => {
        for (const slot of slots) slot.child?.kill('SIGKILL');
      }, shutdownMs);
      checkStopped();
      return done;
    },
  };
}

function specifications(root = join(__dirname, '..')) {
  return [
    { name: 'nest', command: join(root, '.nest-runtime/bin/node'), args: ['nest-logger.js'],
      cwd: join(root, '.nest'), env: process.env },
    { name: 'skyhue', command: join(root, '.runtime/bin/node'), args: [join(root, 'deploy/skyhue-launch.mjs')],
      cwd: root, env: process.env },
  ];
}

if (require.main === module) {
  const worker = supervise(specifications());
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => worker.stop());
}

module.exports = { supervise, specifications };
