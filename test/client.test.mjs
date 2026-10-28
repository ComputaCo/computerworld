// Offline tests against a local mock of the API: node --test test/client.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  ActionFailed,
  ApiError,
  Client,
  ConnectionFailed,
  DEFAULT_BASE_URL,
  ElementNotFound,
  Environment,
  VERSION,
  normalizeBaseUrl,
  parseRetryAfter,
} from '../computerworld-cloud.mjs';
import { error, reply, startMock } from './mock-server.mjs';

const WORLD = { id: 'w_abc', source: 'builtin:agent-desktop', state_hash: 'h0', tick: 0, machines: ['workstation'] };
const GRANT = { id: 'env_1', session: 'session-0', config: { actor: 'ada' }, token: 'cwa_w_abc_secret' };
const SCENE = {
  width: 1280,
  height: 800,
  nodes: [],
  elements: [
    { role: 'button', label: 'Show applications', interaction: 'shell:launcher', center: [34, 765] },
    { role: 'button', label: 'Text Editor', interaction: 'shell:launch:editor', rect: { x: 6, y: 162, width: 56, height: 50 }, center: [34, 187] },
    { role: 'button', label: 'Text Editor', interaction: 'shell:launch:editor', rect: { x: 600, y: 400, width: 10, height: 10 } },
    { role: 'button', label: 'Save', interaction: 'editor:save', disabled: true, center: [1, 1] },
  ],
};
const STEP_OK = { outcomes: [{ success: true, value: null, error: null }], state_hash: 'h1', tick: 0 };
const ENV = '/v1/worlds/w_abc/environments/env_1';

let api;
let sleeps;
let client;
before(async () => {
  api = await startMock();
});
after(() => api.close());
beforeEach(() => {
  api.routes.clear();
  api.requests.length = 0;
  sleeps = [];
  client = new Client('cw_live_test', { baseUrl: api.url, sleep: async (ms) => void sleeps.push(ms) });
});

async function boot() {
  api.routes.set('POST /v1/worlds', reply(201, WORLD));
  api.routes.set('POST /v1/worlds/w_abc/environments', reply(201, GRANT));
  const world = await client.createWorld('agent-desktop', { seed: 1 });
  return { world, env: await world.environment() };
}

describe('transport', () => {
  test('the version matches package.json', () => {
    assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  });

  test('User-Agent and bearer are always sent', async () => {
    api.routes.set('GET /v1/me', reply(200, { user: {} }));
    await client.me();
    assert.equal(api.last().headers['user-agent'], `computerworld-cloud-js/${VERSION}`);
    assert.equal(api.last().headers.authorization, 'Bearer cw_live_test');
  });

  test('a custom User-Agent is prefixed; health is sent without a credential', async () => {
    const c = new Client('k', { baseUrl: api.url, userAgent: 'my-agent/2' });
    api.routes.set('GET /v1/health', reply(200, { ok: true }));
    await c.health();
    assert.equal(api.last().headers['user-agent'], `my-agent/2 computerworld-cloud-js/${VERSION}`);
    assert.equal(api.last().headers.authorization, undefined);
  });

  test('base URLs are normalized', () => {
    assert.equal(normalizeBaseUrl('https://x.dev'), 'https://x.dev/v1');
    assert.equal(normalizeBaseUrl('https://x.dev/v1/'), 'https://x.dev/v1');
  });

  test('the default is computaco.ai, and the older pages.dev name still works', () => {
    assert.equal(DEFAULT_BASE_URL, 'https://computaco.ai/v1');
    assert.equal(new Client('cw_live_x').baseUrl, 'https://computaco.ai/v1');
    assert.equal(new Client('cw_live_x', { baseUrl: 'https://computerworld.pages.dev' }).baseUrl, 'https://computerworld.pages.dev/v1');
  });

  test('errors carry status, code and message', async () => {
    api.routes.set('GET /v1/worlds/w_x', error(404, 'not_found', 'no such world'));
    const err = await client.getWorld('w_x').catch((e) => e);
    assert.ok(err instanceof ApiError);
    assert.deepEqual([err.status, err.code, err.detail], [404, 'not_found', 'no such world']);
    assert.match(err.message, /GET \/worlds\/w_x/);
    assert.equal(api.requests.length, 1);
  });

  test("a non-JSON 403 names Cloudflare's 1010", async () => {
    api.routes.set('GET /v1/me', reply(403, 'error code: 1010', { 'content-type': 'text/plain' }));
    const err = await client.me().catch((e) => e);
    assert.equal(err.code, 'http_403');
    assert.match(err.detail, /User-Agent/);
  });

  test('429 retries honouring Retry-After', async () => {
    api.routes.set(`POST ${ENV}/step`, [
      error(429, 'rate_limited', '', { 'retry-after': '2' }),
      error(429, 'rate_limited', '', { 'retry-after': '1' }),
      reply(200, STEP_OK),
    ]);
    const { env } = await boot();
    assert.equal((await env.step({ family: 'keyboard.v1', op: 'type', payload: { text: 'x' } })).state_hash, 'h1');
    assert.deepEqual(sleeps, [2000, 1000]);
  });

  test('429 gives up after maxRetries, and a long Retry-After is not waited', async () => {
    api.routes.set('GET /v1/worlds', error(429, 'quota_exceeded', '', { 'retry-after': '0' }));
    const err = await client.listWorlds().catch((e) => e);
    assert.equal(err.retryAfter, 0);
    assert.equal(api.requests.length, 5);
    api.routes.set('GET /v1/worlds', error(429, 'quota_exceeded', '', { 'retry-after': '86400' }));
    sleeps.length = 0;
    await assert.rejects(client.listWorlds(), (e) => e.status === 429);
    assert.deepEqual(sleeps, []);
  });

  test('5xx backs off on GET but a 500 is not retried for POST', async () => {
    api.routes.set('GET /v1/worlds', [error(502, 'bad_gateway'), error(500, 'engine_error'), reply(200, { worlds: [] })]);
    assert.deepEqual(await client.listWorlds(), []);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0] >= 250 && sleeps[0] <= 500 && sleeps[1] >= 500 && sleeps[1] <= 1000, String(sleeps));
    api.routes.set('POST /v1/worlds', error(500, 'engine_error', 'boom'));
    await assert.rejects(client.createWorld('agent-desktop'), (e) => e.code === 'engine_error');
    assert.equal(api.requests.filter((r) => r.method === 'POST').length, 1);
  });

  test('503 retries a POST', async () => {
    api.routes.set('POST /v1/worlds', [error(503, 'unavailable'), reply(201, WORLD)]);
    assert.equal((await client.createWorld('agent-desktop')).id, 'w_abc');
  });

  test('a connection failure is ConnectionFailed', async () => {
    const c = new Client('k', { baseUrl: 'http://127.0.0.1:9', maxRetries: 1, sleep: async () => {} });
    await assert.rejects(c.me(), ConnectionFailed);
  });

  test('Retry-After as an HTTP date', () => {
    assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.UTC(2015, 9, 21, 7, 28, 0)), 10);
    assert.equal(parseRetryAfter('soon'), null);
  });
});

describe('worlds', () => {
  test('createWorld sends the body and returns handles', async () => {
    const { world, env } = await boot();
    assert.deepEqual(api.requests[0].body, { world: 'agent-desktop', seed: 1 });
    assert.equal(world.id, 'w_abc');
    assert.equal(env.token, 'cwa_w_abc_secret');
    await assert.rejects(client.createWorld('a', { blueprint: 'bp_1' }), /exactly one/);
  });

  test('actor calls use the actor token', async () => {
    const { env } = await boot();
    api.routes.set(`GET ${ENV}/observe`, reply(200, { channels: {} }));
    await env.observe();
    assert.equal(api.last().headers.authorization, 'Bearer cwa_w_abc_secret');
  });

  test('connect parses the world from the token', () => {
    assert.equal(Environment.connect('cwa_w_abc_secret', 'env_1', { baseUrl: api.url }).worldId, 'w_abc');
  });

  test('owner routes', async () => {
    const { world } = await boot();
    const p = '/v1/worlds/w_abc';
    api.routes.set(`POST ${p}/advance`, reply(200, { state_hash: 'h', tick: 1 }));
    api.routes.set(`POST ${p}/snapshots`, reply(201, { id: 's_1' }));
    api.routes.set(`POST ${p}/snapshots/s_1/restore`, reply(200, { state_hash: 'h', tick: 0 }));
    api.routes.set(`GET ${p}/inspect`, reply(200, {}));
    api.routes.set(`POST ${p}/fork`, reply(201, { ...WORLD, id: 'w_fork', environments: [{ ...GRANT, token: 'cwa_w_fork_new' }] }));
    api.routes.set(`DELETE ${p}`, reply(204));
    await world.advance('30s');
    assert.deepEqual(api.last().body, { duration: '30s' });
    await world.advance({ ticks: 5 });
    assert.deepEqual(api.last().body, { ticks: 5 });
    const snap = await world.snapshot('before');
    await world.restore(snap);
    await world.inspect('/state/services');
    assert.deepEqual(api.last().query, { pointer: '/state/services' });
    const fork = await world.fork(snap);
    assert.deepEqual(api.last().body, { snapshot: 's_1' });
    assert.equal((await fork.session('env_1')).token, 'cwa_w_fork_new');
    await world.delete();
    assert.equal(api.last().method, 'DELETE');
  });

  test('procedure references', async () => {
    const { world, env } = await boot();
    api.routes.set('POST /v1/procedures/instantiate', reply(200, {}));
    api.routes.set('POST /v1/worlds/w_abc/procedures/run', reply(200, {}));
    api.routes.set('POST /v1/worlds/w_abc/procedures/project', reply(200, {}));
    await client.instantiate('agent-desktop/legal-engagement', 2);
    assert.deepEqual(api.last().body, { ref: { world: 'agent-desktop', id: 'legal-engagement' }, seed: 2 });
    await world.run({ world: 'agent-desktop', id: 'legal-engagement' }, { seed: 3, fork: true });
    assert.deepEqual(api.last().body, { ref: { world: 'agent-desktop', id: 'legal-engagement' }, seed: 3, fork: true, include_steps: false });
    await world.project({ lawyer: env }, { seed: 2 });
    assert.deepEqual(api.last().body.environment, { lawyer: 'env_1' });
    assert.throws(() => client.instantiate('legal-engagement'), /world\/id/);
  });

  test('updateMe sends null to clear', async () => {
    api.routes.set('PATCH /v1/me', reply(200, { user: {} }));
    await client.updateMe({ email: null, name: 'Ada' });
    assert.deepEqual(api.last().body, { email: null, name: 'Ada' });
  });
});

describe('environment helpers', () => {
  let env;
  beforeEach(async () => {
    ({ env } = await boot());
    api.routes.set(`GET ${ENV}/scene`, reply(200, SCENE));
    api.routes.set(`POST ${ENV}/step`, reply(200, STEP_OK));
  });

  test('find by label, role, interaction and RegExp', async () => {
    assert.deepEqual((await env.find({ label: 'Text Editor' })).center, [34, 187]);
    assert.deepEqual(api.last().query, { width: '1280', height: '800', elements: '1' });
    assert.equal((await env.findAll({ interaction: /^shell:launch/ })).length, 3);
    assert.equal((await env.find({ role: 'button', label: 'Text Editor', index: 1 })).rect.x, 600);
  });

  test('find skips disabled elements and explains a miss', async () => {
    await assert.rejects(env.find({ label: 'Save' }), (e) => e instanceof ElementNotFound && /button:Text Editor/.test(e.message));
  });

  test('click by interaction sends the centre', async () => {
    await env.click({ interaction: 'shell:launch:editor' });
    assert.deepEqual(api.last().body.actions[0], {
      family: 'pointer.v1',
      op: 'click',
      payload: { x: 34, y: 187, width: 1280, height: 800 },
    });
  });

  test('click uses the rect centre when there is no center; double click', async () => {
    await env.click({ label: 'Text Editor', index: 1, double: true });
    const a = api.last().body.actions[0];
    assert.deepEqual([a.op, a.payload.x, a.payload.y], ['double_click', 605, 405]);
  });

  test('an unsuccessful helper action throws unless check is false', async () => {
    api.routes.set(`POST ${ENV}/step`, reply(200, { outcomes: [{ success: false, error: { code: 'denied' } }] }));
    await assert.rejects(env.press('Ctrl+S'), ActionFailed);
    assert.equal((await env.typeText('x', { check: false })).outcomes[0].success, false);
  });

  test('render returns the PNG and its headers; 304 is null', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2]);
    api.routes.set(`GET ${ENV}/render`, (req) =>
      req.headers['if-none-match'] === '"e1"'
        ? reply(304)
        : reply(200, png, { 'content-type': 'image/png', etag: '"e1"', 'x-state-hash': 'h1', 'x-tick': '7' }),
    );
    const frame = await env.render();
    assert.deepEqual(frame.bytes, png);
    assert.deepEqual([frame.etag, frame.stateHash, frame.tick], ['"e1"', 'h1', 7]);
    assert.equal(await env.render({ ifNoneMatch: frame.etag }), null);
  });

  test('perform goes through the owner', async () => {
    api.routes.set('POST /v1/worlds/w_abc/perform', reply(200, { steps: [] }));
    await env.perform({ do: 'click', target: { label: 'Post' } });
    assert.equal(api.last().headers.authorization, 'Bearer cw_live_test');
    assert.equal(api.last().body.environment, 'env_1');
  });
});

describe('swarms', () => {
  test('swarm routes', async () => {
    api.routes.set('POST /v1/swarms', reply(201, { id: 'sw_1', round: 0 }));
    api.routes.set('POST /v1/swarms/sw_1/rounds', reply(200, { round: 2 }));
    api.routes.set('GET /v1/swarms/sw_1/journal', reply(200, '{"key":"a","reply":"x"}\n{"key":"b","reply":"y"}\n'));
    api.routes.set('GET /v1/swarms/sw_1/trace', reply(200, '{"type":"boot"}\n'));
    const swarm = await client.createSwarm('company-2026/rumor-cascade', { journal: 'builtin' });
    assert.deepEqual(api.last().body, { ref: { world: 'company-2026', id: 'rumor-cascade' }, journal: 'builtin' });
    await swarm.runRounds(2);
    assert.deepEqual(api.last().body, { count: 2 });
    assert.deepEqual((await swarm.journal()).map((e) => e.key), ['a', 'b']);
    await swarm.trace({ arm: 'prefix', since: 3 });
    assert.deepEqual(api.last().query, { arm: 'prefix', since: '3' });
  });
});
