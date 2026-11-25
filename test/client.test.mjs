// Offline tests against a local mock of the API: node --test test/client.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  ActionFailed,
  Agent,
  ApiError,
  Client,
  ConnectionFailed,
  DEFAULT_BASE_URL,
  ElementNotFound,
  VERSION,
  normalizeBaseUrl,
  parseRetryAfter,
} from '../computerworld-cloud.mjs';
import { error, reply, startMock } from './mock-server.mjs';

const SIMULATION = { id: 'w_abc', source: 'builtin:agent-desktop', state_hash: 'h0', tick: 0, machines: ['workstation'] };
const GRANT = { id: 'agent_1', kind: 'external', session: 'session-0', config: { actor: 'ada' }, token: 'cwa_w_abc_secret' };
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
const AGENT = '/v1/simulations/w_abc/agents/agent_1';

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
  api.routes.set('POST /v1/simulations', reply(201, SIMULATION));
  api.routes.set('POST /v1/simulations/w_abc/agents', reply(201, GRANT));
  const simulation = await client.createSimulation('agent-desktop', { seed: 1 });
  return { simulation, agent: await simulation.agent() };
}

describe('one computer', () => {
  test('a step asks for the screen it leaves, files go both ways, and a simulation can be told to expire', async () => {
    api.routes.set('POST /v1/simulations', reply(201, { ...SIMULATION, idle_ttl: 900 }));
    api.routes.set('POST /v1/simulations/w_abc/agents', reply(201, GRANT));
    const simulation = await client.createSimulation('agent-desktop', { platform: 'ubuntu', idleTtl: 900 });
    assert.deepEqual(api.last().body, { template: 'agent-desktop', seed: 1, platform: 'ubuntu', idle_ttl: 900 });
    const agent = await simulation.agent();
    api.routes.set(`POST ${AGENT}/step`, reply(200, { ...STEP_OK, frame: { png: 'iVBORw0K', width: 1280, height: 800, state_hash: 'h1' } }));
    const r = await agent.step([{ family: 'keyboard.v1', op: 'type', payload: { text: 'x' } }], { render: { ifChanged: true } });
    assert.equal(r.frame.png, 'iVBORw0K');
    assert.deepEqual(api.last().body.render, { width: 1280, height: 800, if_changed: true });
    api.routes.set('PUT /v1/simulations/w_abc/files', (req) => reply(200, { machine: 'workstation', path: req.query.path, bytes: 3, state_hash: 'h2', tick: 0, got: req.body }));
    const put = await simulation.writeFile('/home/ada/a.txt', 'hey', { machine: 'workstation' });
    assert.deepEqual(put.got, { content: 'hey' });
    assert.deepEqual(api.last().query, { machine: 'workstation', path: '/home/ada/a.txt' });
    await simulation.writeFile('/home/ada/b.bin', new Uint8Array([0, 255]));
    assert.deepEqual(api.last().body, { base64: 'AP8=' });
    api.routes.set('GET /v1/simulations/w_abc/files', reply(200, { machine: 'workstation', path: '/home/ada/a.txt', content: 'hey', base64: 'aGV5', bytes: 3 }));
    assert.equal((await simulation.readFile('/home/ada/a.txt')).content, 'hey');
    assert.deepEqual(api.last().query, { path: '/home/ada/a.txt' });
  });

  test('the agent models answer on OpenAI\'s paths', async () => {
    api.routes.set('GET /v1/models', reply(200, { object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'glm-5.3-flash' }] }));
    assert.deepEqual((await client.models()).map((m) => m.id), ['deepseek-flash', 'glm-5.3-flash']);
    api.routes.set('POST /v1/chat/completions', reply(200, { object: 'chat.completion', choices: [{ message: { content: 'hi' } }] }));
    const c = await client.chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(c.choices[0].message.content, 'hi');
    assert.equal(api.last().body.model, 'deepseek-flash');
  });
});

describe('threads', () => {
  test('a hosted agent takes a prompt, streams its thread by long-polling, and stops; an actor writes its own thread', async () => {
    api.routes.set('POST /v1/simulations', reply(201, SIMULATION));
    const simulation = await client.createSimulation('agent-desktop');
    api.routes.set('POST /v1/simulations/w_abc/agents', reply(201, { id: 'agent_2', kind: 'hosted', name: 'Typist', machine: 'workstation', state: 'idle', config: { screen: [1280, 800] } }));
    const hosted = await simulation.hostedAgent('workstation', { name: 'Typist' });
    assert.deepEqual(api.last().body, { kind: 'hosted', machine: 'workstation', name: 'Typist' });
    assert.equal(hosted.token, null);
    const H = '/v1/simulations/w_abc/agents/agent_2';
    api.routes.set(`POST ${H}/messages`, reply(201, { message: { seq: 1, role: 'person', text: 'Type hello', at: 1 }, state: 'working' }));
    assert.equal((await hosted.prompt('Type hello')).state, 'working');
    assert.deepEqual(api.last().body, { text: 'Type hello' });
    assert.equal(api.last().headers.authorization, 'Bearer cw_live_test');
    api.routes.set(`GET ${H}/messages`, [
      reply(200, { messages: [{ seq: 2, role: 'status', status: 'started', text: 'Working', at: 2 }], state: 'working' }),
      reply(200, { messages: [], state: 'working' }),
      reply(200, { messages: [{ seq: 3, role: 'action', text: 'Typed hello', at: 3 }, { seq: 4, role: 'status', status: 'finished', text: 'Done', at: 4 }], state: 'idle' }),
    ]);
    const seen = [];
    for await (const m of hosted.stream({ after: 1, until: (x) => x.role === 'status' && x.status !== 'started' })) seen.push(m.seq);
    assert.deepEqual(seen, [2, 3, 4]);
    assert.deepEqual(api.requests.filter((r) => r.method === 'GET').map((r) => r.query), [{ after: '1', wait: '25' }, { after: '2', wait: '25' }, { after: '2', wait: '25' }]);
    api.routes.set(`POST ${H}/stop`, reply(200, { state: 'stopped' }));
    assert.deepEqual(await hosted.stop(), { state: 'stopped' });

    api.routes.set('POST /v1/simulations/w_abc/agents', reply(201, GRANT));
    const external = await simulation.agent();
    api.routes.set(`POST ${AGENT}/messages`, reply(201, { message: { seq: 2, role: 'status', status: 'started', text: 'On it', at: 5 }, state: 'working' }));
    await external.post({ role: 'status', status: 'started', text: 'On it' });
    assert.equal(api.last().headers.authorization, 'Bearer cwa_w_abc_secret');
    await external.prompt('Next');
    assert.equal(api.last().headers.authorization, 'Bearer cw_live_test', 'a prompt is the owner\'s');
    await assert.rejects(Agent.connect('cwa_w_abc_secret', 'w_abc', 'agent_1', { baseUrl: api.url }).prompt('x'), /owner call/);
    api.routes.set('GET /v1/simulations/w_abc/agents/p1/messages', reply(200, { messages: [{ seq: 1, role: 'status', status: 'started', text: 'Round 0', at: null }], state: 'idle' }));
    assert.equal((await simulation.person('p1').messages()).messages[0].at, null);
  });
});

describe('the browser', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const SESSION = { id: 'w_b1', url: 'https://example.com/', title: 'Example', status: 200, viewport: { width: 800, height: 600 }, idle_ttl_s: 300 };

  test('one-shot calls send the page and its options, and a screenshot is its bytes and size', async () => {
    api.routes.set('POST /v1/browser/screenshot', reply(200, PNG, { 'content-type': 'image/png', 'x-width': '640', 'x-height': '400', 'x-browser-ms-used': '91' }));
    const shot = await client.browser.screenshot('https://example.com/', { viewport: { width: 640, height: 400 }, waitMs: 500, fullPage: true });
    assert.deepEqual(api.last().body, { url: 'https://example.com/', viewport: { width: 640, height: 400 }, wait_ms: 500, full_page: true });
    assert.deepEqual([...shot.bytes], [...PNG]);
    assert.deepEqual([shot.width, shot.height, shot.clipped, shot.browserMsUsed], [640, 400, false, 91]);
    for (const what of ['content', 'markdown', 'links', 'snapshot']) {
      api.routes.set(`POST /v1/browser/${what}`, reply(200, { url: 'https://example.com/', what }));
      assert.equal((await client.browser[what]('https://example.com/')).what, what);
      assert.deepEqual(api.last().body, { url: 'https://example.com/' });
    }
  });

  test('a session is made, driven, read, drawn and deleted', async () => {
    api.routes.set('POST /v1/browser/sessions', reply(201, SESSION));
    const s = await client.browser.createSession({ url: 'https://example.com/', viewport: { width: 800, height: 600 }, idleTtlS: 120 });
    assert.deepEqual(api.last().body, { url: 'https://example.com/', viewport: { width: 800, height: 600 }, idle_ttl_s: 120 });
    assert.equal(s.id, 'w_b1');
    assert.deepEqual(s.viewport, { width: 800, height: 600 });
    api.routes.set('POST /v1/browser/sessions/w_b1/actions', reply(200, { id: 'w_b1', outcomes: [{ success: false, error: { reason: 'unreachable' } }], state_hash: 'h', tick: 0 }));
    await assert.rejects(s.navigate('https://nowhere.example/'), ActionFailed);
    assert.deepEqual(api.last().body, { actions: [{ family: 'browser.v1', op: 'navigate', payload: { url: 'https://nowhere.example/' } }] });
    api.routes.set('GET /v1/browser/sessions/w_b1/screenshot', reply(200, PNG, { 'content-type': 'image/png', 'x-width': '800', 'x-height': '3200', 'x-full-page-clipped': 'true' }));
    const shot = await s.screenshot({ fullPage: true });
    assert.deepEqual(api.last().query, { full_page: '1' });
    assert.equal(shot.clipped, true);
    api.routes.set('GET /v1/browser/sessions/w_b1/content', reply(200, { url: 'https://example.com/', status: 200, title: 'Example', html: '<html></html>' }));
    assert.equal((await s.content()).html, '<html></html>');
    api.routes.set('GET /v1/browser/sessions', reply(200, { sessions: [SESSION] }));
    assert.deepEqual((await client.browser.listSessions()).map((x) => x.id), ['w_b1']);
    api.routes.set('DELETE /v1/browser/sessions/w_b1', reply(204));
    await s.delete();
    assert.equal(api.last().method, 'DELETE');
  });
});

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

  test('the default is computaco.ai, and another base (the dev tier) can be given', () => {
    assert.equal(DEFAULT_BASE_URL, 'https://computaco.ai/v1');
    assert.equal(new Client('cw_live_x').baseUrl, 'https://computaco.ai/v1');
    assert.equal(new Client('cw_live_x', { baseUrl: 'https://dev.computaco.ai' }).baseUrl, 'https://dev.computaco.ai/v1');
  });

  test('errors carry status, code and message', async () => {
    api.routes.set('GET /v1/simulations/w_x', error(404, 'not_found', 'no such simulation'));
    const err = await client.getSimulation('w_x').catch((e) => e);
    assert.ok(err instanceof ApiError);
    assert.deepEqual([err.status, err.code, err.detail], [404, 'not_found', 'no such simulation']);
    assert.match(err.message, /GET \/simulations\/w_x/);
    assert.equal(api.requests.length, 1);
  });

  test('a refused key names the API it went to and how to point the client elsewhere', async () => {
    // A key made on dev.computaco.ai is unknown to computaco.ai, and the other way round.
    api.routes.set('GET /v1/me', error(401, 'unauthenticated', 'Unknown API key.'));
    const err = await client.me().catch((e) => e);
    assert.deepEqual([err.status, err.code], [401, 'unauthenticated']);
    assert.ok(err.detail.startsWith('Unknown API key. '));
    assert.ok(err.detail.includes(`went to ${api.url}/v1`));
    assert.match(err.detail, /COMPUTERWORLD_API_BASE/);
  });

  test("a non-JSON 403 names Cloudflare's 1010", async () => {
    api.routes.set('GET /v1/me', reply(403, 'error code: 1010', { 'content-type': 'text/plain' }));
    const err = await client.me().catch((e) => e);
    assert.equal(err.code, 'http_403');
    assert.match(err.detail, /User-Agent/);
  });

  test('429 retries honouring Retry-After', async () => {
    api.routes.set(`POST ${AGENT}/step`, [
      error(429, 'rate_limited', '', { 'retry-after': '2' }),
      error(429, 'rate_limited', '', { 'retry-after': '1' }),
      reply(200, STEP_OK),
    ]);
    const { agent } = await boot();
    assert.equal((await agent.step({ family: 'keyboard.v1', op: 'type', payload: { text: 'x' } })).state_hash, 'h1');
    assert.deepEqual(sleeps, [2000, 1000]);
  });

  test('429 gives up after maxRetries, and a long Retry-After is not waited', async () => {
    api.routes.set('GET /v1/simulations', error(429, 'quota_exceeded', '', { 'retry-after': '0' }));
    const err = await client.listSimulations().catch((e) => e);
    assert.equal(err.retryAfter, 0);
    assert.equal(api.requests.length, 5);
    api.routes.set('GET /v1/simulations', error(429, 'quota_exceeded', '', { 'retry-after': '86400' }));
    sleeps.length = 0;
    await assert.rejects(client.listSimulations(), (e) => e.status === 429);
    assert.deepEqual(sleeps, []);
  });

  test('5xx backs off on GET but a 500 is not retried for POST', async () => {
    api.routes.set('GET /v1/simulations', [error(502, 'bad_gateway'), error(500, 'engine_error'), reply(200, { simulations: [] })]);
    assert.deepEqual(await client.listSimulations(), []);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0] >= 250 && sleeps[0] <= 500 && sleeps[1] >= 500 && sleeps[1] <= 1000, String(sleeps));
    api.routes.set('POST /v1/simulations', error(500, 'engine_error', 'boom'));
    await assert.rejects(client.createSimulation('agent-desktop'), (e) => e.code === 'engine_error');
    assert.equal(api.requests.filter((r) => r.method === 'POST').length, 1);
  });

  test('503 with Retry-After retries a POST', async () => {
    api.routes.set('POST /v1/simulations', [error(503, 'model_unavailable', '', { 'retry-after': '0' }), reply(201, SIMULATION)]);
    assert.equal((await client.createSimulation('agent-desktop')).id, 'w_abc');
  });

  test('503 without Retry-After is a failure of ours: a POST is not sent twice, a GET is', async () => {
    api.routes.set('POST /v1/simulations', [error(503, 'harness_failed'), reply(201, SIMULATION)]);
    await assert.rejects(client.createSimulation('agent-desktop'), (e) => e.code === 'harness_failed');
    assert.equal(api.requests.filter((r) => r.method === 'POST').length, 1);
    api.routes.set('GET /v1/simulations', [error(503, 'harness_failed'), reply(200, { simulations: [] })]);
    assert.deepEqual(await client.listSimulations(), []);
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

describe('simulations', () => {
  test('createSimulation sends the body and returns handles', async () => {
    const { simulation, agent } = await boot();
    assert.deepEqual(api.requests[0].body, { template: 'agent-desktop', seed: 1 });
    assert.equal(simulation.id, 'w_abc');
    assert.equal(agent.token, 'cwa_w_abc_secret');
    await assert.rejects(client.createSimulation('a', { definition: {} }), /exactly one/);
    await assert.rejects(client.createSimulation(null), /exactly one/);
  });

  test('a society is booted with the simulation', async () => {
    api.routes.set('POST /v1/simulations', reply(201, SIMULATION));
    await client.createSimulation('company-2026', { society: 'rumor-cascade' });
    assert.deepEqual(api.last().body, { template: 'company-2026', seed: 1, society: { id: 'rumor-cascade' } });
    await client.createSimulation(null, { definition: { computers: [] }, society: { spec: { people: [] }, journal: 'builtin', rounds: 4 } });
    assert.deepEqual(api.last().body.society, { spec: { people: [] }, journal: 'builtin', rounds: 4 });
  });

  test('owner routes', async () => {
    const { simulation } = await boot();
    const p = '/v1/simulations/w_abc';
    api.routes.set(`POST ${p}/advance`, reply(200, { state_hash: 'h', tick: 1 }));
    api.routes.set(`POST ${p}/snapshots`, reply(201, { id: 's_1' }));
    api.routes.set(`POST ${p}/snapshots/s_1/restore`, reply(200, { state_hash: 'h', tick: 0, head: 's_1', elapsed_ms: 3 }));
    api.routes.set(`GET ${p}/inspect`, reply(200, {}));
    api.routes.set(`PATCH ${p}`, (req) => reply(200, { ...SIMULATION, name: req.body.name }));
    api.routes.set(`DELETE ${p}`, reply(204));
    await simulation.advance('30s');
    assert.deepEqual(api.last().body, { duration: '30s' });
    await simulation.advance({ ticks: 5 });
    assert.deepEqual(api.last().body, { ticks: 5 });
    const snap = await simulation.snapshot('before');
    await simulation.restore(snap);
    api.routes.set(`GET ${p}/snapshots/s_1/agents`, reply(200, { agents: [{ id: 'agent_1', kind: 'external', state: 'idle' }], conversations_kept: true }));
    api.routes.set(`GET ${p}/snapshots/s_1/agents/agent_1/messages`, reply(200, { messages: [{ seq: 1, role: 'person', text: 'then', at: 1 }], state: 'idle' }));
    assert.equal((await simulation.snapshotAgents(snap)).conversations_kept, true);
    assert.equal((await simulation.snapshotMessages(snap, 'agent_1')).messages[0].text, 'then');
    assert.deepEqual(api.last().query, { after: '0' });
    await simulation.inspect('/state/services');
    assert.deepEqual(api.last().query, { pointer: '/state/services' });
    assert.equal((await simulation.rename('office')).name, 'office');
    await simulation.delete();
    assert.equal(api.last().method, 'DELETE');
  });

  test('procedure references', async () => {
    const { simulation, agent } = await boot();
    api.routes.set('POST /v1/templates/agent-desktop/procedures/legal-engagement/instantiate', reply(200, {}));
    api.routes.set('POST /v1/simulations/w_abc/procedures/run', reply(200, {}));
    api.routes.set('POST /v1/simulations/w_abc/procedures/project', reply(200, {}));
    await client.instantiate('agent-desktop', 'legal-engagement', { seed: 2 });
    assert.deepEqual(api.last().body, { seed: 2 });
    await simulation.run({ template: 'agent-desktop', id: 'legal-engagement' }, { seed: 3, fork: true, agent });
    assert.deepEqual(api.last().body, { ref: { template: 'agent-desktop', id: 'legal-engagement' }, seed: 3, fork: true, include_steps: false, agent: 'agent_1' });
    await simulation.run('agent-desktop/legal-engagement');
    assert.deepEqual(api.last().body.ref, { template: 'agent-desktop', id: 'legal-engagement' });
    await simulation.project({ lawyer: agent }, { seed: 2 });
    assert.deepEqual(api.last().body.agent, { lawyer: 'agent_1' });
    assert.throws(() => simulation.run('legal-engagement'), /template\/id/);
  });

  test('updateMe sends null to clear', async () => {
    api.routes.set('PATCH /v1/me', reply(200, { user: {} }));
    await client.updateMe({ date_of_birth: null, name: 'Ada' });
    assert.deepEqual(api.last().body, { date_of_birth: null, name: 'Ada' });
  });

  test('setEmail sends a code, and verifyEmail confirms it', async () => {
    api.routes.set('POST /v1/me/email', reply(202, { email: { address: 'ada@cs.example.edu', verified: false } }));
    api.routes.set('POST /v1/me/email/verify', reply(200, { user: {}, tag: 'academic' }));
    assert.deepEqual(await client.setEmail('ada@cs.example.edu'), { address: 'ada@cs.example.edu', verified: false });
    assert.deepEqual(api.last().body, { email: 'ada@cs.example.edu' });
    assert.equal((await client.verifyEmail('123456')).tag, 'academic');
    assert.deepEqual(api.last().body, { code: '123456' });
  });

  test('signup makes the account, then a key with its session and the scopes asked for', async () => {
    const KEY = { id: 'key_1', name: 'ci', prefix: 'cw_live_abcd', scopes: ['simulations', 'templates'], key: 'cw_live_secret' };
    api.routes.set('POST /v1/auth/signup', reply(201, { user: { id: 'u_1', username: 'ada' } }, { 'set-cookie': 'cw_session=cws_abc; Path=/; HttpOnly' }));
    api.routes.set('POST /v1/keys', (r) => (r.headers.cookie === 'cw_session=cws_abc' ? reply(201, { ...KEY, scopes: r.body.scopes }) : reply(401, { error: { code: 'unauthenticated' } })));
    api.routes.set('GET /v1/me', reply(200, { user: {} }));
    const { client: made, user, key } = await Client.signup('ada', 'a long enough password', { baseUrl: api.url, keyName: 'ci', scopes: ['simulations', 'templates'] });
    assert.equal(user.username, 'ada');
    assert.deepEqual(key.scopes, ['simulations', 'templates']);
    assert.deepEqual(api.requests[1].body, { name: 'ci', scopes: ['simulations', 'templates'] });
    assert.equal(api.requests[1].headers.authorization, undefined);
    await made.me();
    assert.equal(api.last().headers.authorization, 'Bearer cw_live_secret');
    // Without scopes the key asks for none, and the API gives it every one.
    await Client.signup('bob', 'a long enough password', { baseUrl: api.url });
    assert.deepEqual(api.requests.at(-1).body, {});
  });

  test('createKey sends its scopes', async () => {
    api.routes.set('POST /v1/keys', reply(201, { id: 'key_2', key: 'cw_live_x', scopes: ['models'] }));
    await client.createKey('agent', { scopes: ['models'] });
    assert.deepEqual(api.last().body, { name: 'agent', scopes: ['models'] });
    await client.createKey();
    assert.deepEqual(api.last().body, {});
  });
});

describe('agents', () => {
  test('actor calls use the actor token', async () => {
    const { agent } = await boot();
    api.routes.set(`GET ${AGENT}/observe`, reply(200, { channels: {} }));
    await agent.observe();
    assert.equal(api.last().headers.authorization, 'Bearer cwa_w_abc_secret');
  });

  test('connect makes a handle from the actor token alone', async () => {
    const remote = Agent.connect('cwa_w_abc_secret', 'w_abc', 'agent_1', { baseUrl: api.url });
    api.routes.set(`GET ${AGENT}/observe`, reply(200, { channels: {} }));
    await remote.observe();
    assert.equal(api.last().headers.authorization, 'Bearer cwa_w_abc_secret');
  });

  test('the list holds external and simulated agents; one is fetched and revoked', async () => {
    const { simulation } = await boot();
    const p = '/v1/simulations/w_abc/agents';
    api.routes.set(`GET ${p}`, reply(200, { agents: [{ ...GRANT, token: undefined }, { id: 'p_nina', kind: 'simulated', name: 'Nina', population: 'staff' }] }));
    api.routes.set(`GET ${p}/agent_2`, reply(200, { id: 'agent_2', kind: 'external', token: 'cwa_w_abc_two' }));
    api.routes.set(`DELETE ${p}/agent_2`, reply(204));
    assert.deepEqual((await simulation.agents()).map((a) => a.kind), ['external', 'simulated']);
    assert.equal(await simulation.getAgent('agent_1'), await simulation.getAgent('agent_1'));
    const two = await simulation.getAgent('agent_2');
    assert.equal(two.token, 'cwa_w_abc_two');
    await simulation.revoke(two);
    assert.equal(api.last().path, `${p}/agent_2`);
  });
});

describe('agent helpers', () => {
  let agent;
  beforeEach(async () => {
    ({ agent } = await boot());
    api.routes.set(`GET ${AGENT}/scene`, reply(200, SCENE));
    api.routes.set(`POST ${AGENT}/step`, reply(200, STEP_OK));
  });

  test('find by label, role, interaction and RegExp', async () => {
    assert.deepEqual((await agent.find({ label: 'Text Editor' })).center, [34, 187]);
    assert.deepEqual(api.last().query, { width: '1280', height: '800', elements: '1' });
    assert.equal((await agent.findAll({ interaction: /^shell:launch/ })).length, 3);
    assert.equal((await agent.find({ role: 'button', label: 'Text Editor', index: 1 })).rect.x, 600);
  });

  test('find skips disabled elements and explains a miss', async () => {
    await assert.rejects(agent.find({ label: 'Save' }), (e) => e instanceof ElementNotFound && /button:Text Editor/.test(e.message));
  });

  test('click by interaction sends the centre', async () => {
    await agent.click({ interaction: 'shell:launch:editor' });
    assert.deepEqual(api.last().body.actions[0], {
      family: 'pointer.v1',
      op: 'click',
      payload: { x: 34, y: 187, width: 1280, height: 800 },
    });
  });

  test('click uses the rect centre when there is no center; double click', async () => {
    await agent.click({ label: 'Text Editor', index: 1, double: true });
    const a = api.last().body.actions[0];
    assert.deepEqual([a.op, a.payload.x, a.payload.y], ['double_click', 605, 405]);
  });

  test('an unsuccessful helper action throws unless check is false', async () => {
    api.routes.set(`POST ${AGENT}/step`, reply(200, { outcomes: [{ success: false, error: { code: 'denied' } }] }));
    await assert.rejects(agent.press('Ctrl+S'), ActionFailed);
    assert.equal((await agent.typeText('x', { check: false })).outcomes[0].success, false);
  });

  test('render returns the PNG and its headers; 304 is null', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2]);
    api.routes.set(`GET ${AGENT}/render`, (req) =>
      req.headers['if-none-match'] === '"e1"'
        ? reply(304)
        : reply(200, png, { 'content-type': 'image/png', etag: '"e1"', 'x-state-hash': 'h1', 'x-tick': '7' }),
    );
    const frame = await agent.render();
    assert.deepEqual(frame.bytes, png);
    assert.deepEqual([frame.etag, frame.stateHash, frame.tick], ['"e1"', 'h1', 7]);
    assert.equal(await agent.render({ ifNoneMatch: frame.etag }), null);
  });

  test('perform goes through the owner', async () => {
    api.routes.set('POST /v1/simulations/w_abc/perform', reply(200, { steps: [] }));
    await agent.perform({ do: 'click', target: { label: 'Post' } });
    assert.equal(api.last().headers.authorization, 'Bearer cw_live_test');
    assert.equal(api.last().body.agent, 'agent_1');
  });
});

describe('templates', () => {
  test('built-in and own in one list; own ones are saved, edited and deleted', async () => {
    api.routes.set('GET /v1/templates', reply(200, { templates: [{ id: 'company-2026', source: 'builtin' }, { id: 'bp_1', source: 'own' }] }));
    api.routes.set('POST /v1/templates', reply(201, { id: 'bp_2', source: 'own' }));
    api.routes.set('PUT /v1/templates/bp_2', reply(200, { id: 'bp_2', name: 'b' }));
    api.routes.set('POST /v1/templates/bp_2/topology', reply(200, { nodes: [] }));
    api.routes.set('DELETE /v1/templates/bp_2', reply(204));
    api.routes.set('GET /v1/simulations/w_abc/definition', reply(200, { computers: [] }));
    assert.deepEqual((await client.listTemplates()).map((t) => t.source), ['builtin', 'own']);
    const { simulation } = await boot();
    await client.createTemplate({ name: 'a', definition: await simulation.definition() });
    assert.deepEqual(api.last().body, { name: 'a', definition: { computers: [] } });
    await client.updateTemplate('bp_2', { name: 'b' });
    assert.deepEqual(api.last().body, { name: 'b' });
    await client.editTemplateTopology('bp_2', [{ op: 'remove_machine', id: 'm' }]);
    assert.deepEqual([api.last().method, api.last().body], ['POST', { edits: [{ op: 'remove_machine', id: 'm' }] }]);
    await client.deleteTemplate('bp_2');
    assert.equal(api.last().method, 'DELETE');
  });

  test('procedures, societies, vocabulary and validate', async () => {
    api.routes.set('GET /v1/templates/company-2026/procedures', reply(200, { procedures: [{ id: 'p' }] }));
    api.routes.set('GET /v1/templates/company-2026/societies', reply(200, { societies: [{ id: 'rumor-cascade' }] }));
    api.routes.set('GET /v1/templates/company-2026/societies/rumor-cascade', reply(200, { id: 'rumor-cascade' }));
    api.routes.set('GET /v1/vocabulary', reply(200, { applications: [] }));
    api.routes.set('POST /v1/validate', reply(200, { ok: true, people: 16 }));
    assert.equal((await client.templateProcedures('company-2026'))[0].id, 'p');
    assert.equal((await client.templateSocieties('company-2026'))[0].id, 'rumor-cascade');
    assert.equal((await client.templateSociety('company-2026', 'rumor-cascade')).id, 'rumor-cascade');
    await client.vocabulary();
    assert.equal((await client.validate({ computers: [] }, { society: { id: 'rumor-cascade' } })).people, 16);
    assert.deepEqual(api.last().body, { definition: { computers: [] }, society: { id: 'rumor-cascade' } });
  });
});

describe('society and forks', () => {
  test('society routes live under the simulation', async () => {
    const { simulation } = await boot();
    const p = '/v1/simulations/w_abc/society';
    api.routes.set(`GET ${p}`, reply(200, { spec_id: 'rumor-cascade', people: 16, round: 0, rounds: 8 }));
    api.routes.set(`POST ${p}/rounds`, reply(200, { round: 2 }));
    api.routes.set(`GET ${p}/journal`, reply(200, '{"key":"a","reply":"x"}\n{"key":"b","reply":"y"}\n'));
    api.routes.set(`POST ${p}/journal`, reply(200, { entries: 1 }));
    api.routes.set(`GET ${p}/trace`, reply(200, '{"type":"boot"}\n'));
    api.routes.set(`GET ${p}/summary`, reply(200, { arms: [] }));
    assert.equal((await simulation.society.info()).people, 16);
    await simulation.society.runRounds(2, { askModel: true });
    assert.deepEqual(api.last().body, { count: 2, ask_model: true });
    assert.deepEqual((await simulation.society.journal()).map((e) => e.key), ['a', 'b']);
    await simulation.society.addJournal([{ key: 'c', reply: 'z' }]);
    assert.deepEqual(api.last().body, { entries: [{ key: 'c', reply: 'z' }] });
    assert.deepEqual(await simulation.society.trace({ since: 3 }), [{ type: 'boot' }]);
    assert.deepEqual(api.last().query, { since: '3' });
    await simulation.society.summary();
  });

  test('a fork is a simulation that carries the agents under new tokens', async () => {
    const { simulation } = await boot();
    const p = '/v1/simulations/w_abc';
    api.routes.set(`POST ${p}/fork`, reply(201, { ...SIMULATION, id: 'w_fork', forked_from: 'w_abc', agents: [{ ...GRANT, token: 'cwa_w_fork_new' }] }));
    api.routes.set(`GET ${p}`, reply(200, { ...SIMULATION, forks: ['w_fork'] }));
    const ops = [{ op: 'add_rule', rule: 'r' }];
    const fork = await simulation.fork({ name: 'arm b', societyOps: ops });
    assert.deepEqual(api.requests.at(-1).body, { name: 'arm b', society_ops: ops });
    assert.equal(fork.info.forked_from, 'w_abc');
    const carried = await fork.getAgent('agent_1');
    assert.equal(carried.token, 'cwa_w_fork_new');
    assert.equal(carried.simulationId, 'w_fork');
    assert.deepEqual(await simulation.forks(), ['w_fork']);
  });

  test('a place is named on boot, import and fork; history, snapshot frames and agent connections', async () => {
    const { simulation } = await boot();
    const p = '/v1/simulations/w_abc';
    const place = { id: 'core', kind: 'lightning', metered: false, modules: [], reason: 'asked for' };
    const refused = [{ place: 'heavy', code: 'plan_required', message: 'no Heavy-minutes' }];
    api.routes.set('POST /v1/simulations', reply(201, { ...SIMULATION, place, refused }));
    const placed = await client.createSimulation('agent-desktop', { place: ['heavy', 'lightning'] });
    assert.deepEqual(api.last().body, { template: 'agent-desktop', seed: 1, place: ['heavy', 'lightning'] });
    assert.deepEqual([placed.info.place.id, placed.info.refused[0].code], ['core', 'plan_required']);
    api.routes.set('POST /v1/simulations/import', reply(201, { ...SIMULATION, id: 'w_imp', place }));
    await client.importSimulation({ v: 1, snapshot: new Uint8Array([7, 0]) }, 'copy', { place: 'lightning' });
    assert.deepEqual(api.last().body, { bundle: { v: 1 }, snapshot: new Uint8Array([7, 0]), options: { name: 'copy', place: 'lightning' } });
    // An export is the same form, read back to the bundle with its snapshot's bytes.
    const exported = new FormData();
    exported.append('bundle', new Blob([JSON.stringify({ v: 1, state_hash: 'h' })], { type: 'application/json' }));
    exported.append('snapshot', new Blob([new Uint8Array([7, 0])], { type: 'application/octet-stream' }));
    const form = new Response(exported);
    api.routes.set(`GET ${p}/export`, reply(200, new Uint8Array(await form.arrayBuffer()), { 'content-type': form.headers.get('content-type') }));
    assert.deepEqual(await simulation.exportSnapshot(), { v: 1, state_hash: 'h', snapshot: new Uint8Array([7, 0]) });
    api.routes.set(`POST ${p}/fork`, reply(201, { ...SIMULATION, id: 'w_fork', forked_from: 'w_abc', place }));
    await simulation.fork({ snapshot: { id: 's_1' }, place: 'lightning' });
    assert.deepEqual(api.last().body, { snapshot: 's_1', place: 'lightning' });

    const s1 = { id: 's_1', label: 'one', state_hash: 'h', tick: 0, parent: null, author: 'ada', frames: ['workstation'] };
    api.routes.set(`GET ${p}/snapshots`, reply(200, { snapshots: [s1], head: 's_1' }));
    assert.deepEqual(await simulation.snapshots(), [s1]);
    api.routes.set(`DELETE ${p}/snapshots/s_1`, reply(200, { snapshots: [], head: null }));
    assert.deepEqual(await simulation.dropSnapshot(s1), { snapshots: [], head: null });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2]);
    api.routes.set(`GET ${p}/snapshots/s_1/frames/workstation`, reply(200, png, { 'content-type': 'image/png' }));
    const frame = await simulation.snapshotFrame('s_1', 'workstation');
    assert.deepEqual(frame.bytes, png);
    assert.equal(frame.format, 'png');
    api.routes.set(`GET ${p}/history`, reply(200, { simulation: 'w_abc', simulations: [{ id: 'w_abc', parent: null, origin: null, head: 's_1', place, snapshots: [s1] }] }));
    assert.equal((await simulation.history()).simulations[0].head, 's_1');

    const m = `${p}/agents/agent_1/machines/workstation`;
    api.routes.set(`PUT ${m}`, reply(200, { ...GRANT, token: undefined }));
    api.routes.set(`DELETE ${m}`, reply(200, { ...GRANT, token: undefined }));
    assert.equal((await simulation.connectAgent('agent_1', 'workstation')).id, 'agent_1');
    assert.equal(api.last().method, 'PUT');
    assert.equal((await simulation.disconnectAgent('agent_1', 'workstation')).id, 'agent_1');
    assert.equal(api.last().method, 'DELETE');
  });
});
