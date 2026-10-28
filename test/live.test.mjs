// Live smoke test against the hosted API. Runs only with COMPUTERWORLD_API_KEY set:
//
//   COMPUTERWORLD_API_KEY=cw_live_... node --test test/live.test.mjs
//
// It boots agent-desktop, clicks the editor's launcher, types, renders a PNG, runs the
// legal-engagement procedure in a fork, and deletes everything it made. Client-side timings
// (ms) are printed at the end.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, Client } from '../computerworld-cloud.mjs';

const timings = {};
async function timed(name, fn) {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round((performance.now() - t) * 10) / 10;
  }
}

test('agent-desktop journey', { skip: !process.env.COMPUTERWORLD_API_KEY && 'COMPUTERWORLD_API_KEY is not set' }, async () => {
  const client = new Client();
  const made = [];
  try {
    assert.equal((await timed('health', () => client.health())).ok, true);
    const world = await timed('boot agent-desktop', () => client.createWorld('agent-desktop', { seed: 1, name: 'sdk-smoke-js' }));
    made.push(world);
    const env = await timed('grant environment', () => world.environment({ label: 'smoke' }));
    assert.match(env.token, /^cwa_/);

    const launcher = await timed('scene (elements)', () => env.find({ interaction: 'shell:launch:editor' }));
    const clicked = await timed('step (click)', () => env.click({ element: launcher }));
    assert.ok(clicked.outcomes[0].effect.changed.includes('window.opened'));
    await env.click({ element: await env.find({ role: 'textbox', label: 'Document text' }) });
    await timed('step (type)', () => env.typeText('Hello from computerworld-cloud-js'));

    const frame = await timed('render 1280x800 png', () => env.render());
    assert.deepEqual([...frame.bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = new DataView(frame.bytes.buffer, frame.bytes.byteOffset + 16, 8);
    assert.deepEqual([ihdr.getUint32(0), ihdr.getUint32(4)], [1280, 800]);
    assert.equal(frame.stateHash, await world.stateHash());
    assert.equal(await timed('render 304', () => env.render({ ifNoneMatch: frame.etag })), null);

    const snap = await timed('snapshot', () => world.snapshot('after-typing'));
    const fork = await timed('fork', () => world.fork(snap));
    made.push(fork);
    assert.equal(await fork.stateHash(), snap.state_hash);
    const carried = await fork.session(env.id);
    assert.ok(carried.token && carried.token !== env.token);

    const run = await timed('procedure run legal-engagement', () => fork.run('agent-desktop/legal-engagement', { seed: 1 }));
    assert.equal(run.verification.passed, true, JSON.stringify(run.verification));
    timings['legal-engagement GUI actions'] = run.demonstration.counts?.actions ?? run.demonstration.steps?.length;
    assert.notEqual(await fork.stateHash(), await world.stateHash());
  } finally {
    await timed('delete', async () => {
      for (const w of made.reverse()) await w.delete().catch((e) => { if (!(e instanceof ApiError && e.status === 404)) throw e; });
    });
  }
  const left = new Set((await client.listWorlds()).map((w) => w.id));
  assert.ok(made.every((w) => !left.has(w.id)));
  const width = Math.max(...Object.keys(timings).map((k) => k.length));
  console.log('live smoke (js), client-side ms:');
  for (const [k, v] of Object.entries(timings)) console.log(`  ${k.padEnd(width)}  ${v}`);
});
