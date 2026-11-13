// computerworld-cloud: a client for the hosted ComputerWorld API.
//
// One ES module, no dependencies, for Node 18+ and browsers. It can be imported from a
// checkout, from `npm install <path to clients/js>`, or straight from a URL:
//
//   import { Client } from 'https://cdn.jsdelivr.net/gh/ComputaCo/computerworld@main/computerworld-cloud.mjs';
//
// Types are in computerworld-cloud.d.mts beside it. The contract is cloud/openapi.yaml.

export const VERSION = '0.3.0';
export const DEFAULT_BASE_URL = 'https://computaco.ai/v1';
export const USER_AGENT = `computerworld-cloud-js/${VERSION}`;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

// 429 and 503 mean the request was not processed, so any method may be sent again.
// 500, 502 and 504 may come after the simulation changed, so only idempotent methods retry.
const ALWAYS_RETRY = new Set([429, 503]);
const IDEMPOTENT_RETRY = new Set([500, 502, 504]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

// A browser sends its own User-Agent and a cross-origin fetch may not set one (it is not a
// CORS-safelisted header), so the header is set only outside browsers.
const IS_SERVER = typeof process !== 'undefined' && !!process.versions?.node;

const env = (name) => (typeof process !== 'undefined' ? process.env?.[name] : undefined);

// ------------------------------------------------------------------------------- errors

export class ComputerWorldError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** The API answered with an error. `code` is the API's (`not_found`, `rate_limited`, ...). */
export class ApiError extends ComputerWorldError {
  constructor(status, code, message, { method = '', path = '', retryAfter = null, body = null } = {}) {
    super(`${status} ${code}: ${message}${method ? ` (${method} ${path})` : ''}`);
    this.status = status;
    this.code = code;
    this.detail = message;
    this.method = method;
    this.path = path;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

/** The request never got an answer (network failure or timeout). */
export class ConnectionFailed extends ComputerWorldError {}

/** No element of the scene matched a find. */
export class ElementNotFound extends ComputerWorldError {}

/** A helper's action came back unsuccessful. */
export class ActionFailed extends ComputerWorldError {
  constructor(action, outcome) {
    super(`${action.family} ${action.op} failed: ${JSON.stringify(outcome?.error ?? null)}`);
    this.action = action;
    this.outcome = outcome;
  }
}

// ------------------------------------------------------------------------------- transport

export function normalizeBaseUrl(baseUrl) {
  let base = String(baseUrl).replace(/\/+$/, '');
  if (!base.endsWith('/v1')) base += '/v1';
  return base;
}

/** `Retry-After` in seconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s);
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, (when - now) / 1000);
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Transport {
  constructor(baseUrl, token, opts = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token ?? null;
    this.timeout = opts.timeout ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.backoff = opts.backoff ?? 500;
    this.maxBackoff = opts.maxBackoff ?? 30_000;
    this.maxRetryAfter = opts.maxRetryAfter ?? 120;
    this.userAgent = opts.userAgent ? `${opts.userAgent} ${USER_AGENT}` : USER_AGENT;
    this.sendUserAgent = opts.sendUserAgent ?? IS_SERVER;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? sleepMs;
    this.opts = opts;
  }

  withToken(token) {
    return new Transport(this.baseUrl, token, this.opts);
  }

  async request(method, path, { json, params, headers, ok = [], auth = true } = {}) {
    method = method.toUpperCase();
    let url = this.baseUrl + path;
    if (params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        q.set(k, v === true ? '1' : v === false ? '0' : String(v));
      }
      const qs = q.toString();
      if (qs) url += `?${qs}`;
    }
    const h = { accept: 'application/json', ...headers };
    if (this.sendUserAgent) h['user-agent'] = this.userAgent;
    if (auth && this.token) h.authorization = `Bearer ${this.token}`;
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      h['content-type'] = 'application/json';
    }

    for (let attempt = 0; ; attempt++) {
      let resp;
      try {
        resp = await this.fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(this.timeout) });
      } catch (err) {
        if (IDEMPOTENT.has(method) && attempt < this.maxRetries) {
          await this.sleep(this.delay(attempt, null));
          continue;
        }
        throw new ConnectionFailed(`${method} ${url}: ${err?.message ?? err}`);
      }
      if (resp.status < 400 || ok.includes(resp.status)) return resp;
      const err = await toError(resp, method, path);
      const retryable = ALWAYS_RETRY.has(resp.status) || (IDEMPOTENT_RETRY.has(resp.status) && IDEMPOTENT.has(method));
      if (!retryable || attempt >= this.maxRetries || (err.retryAfter != null && err.retryAfter > this.maxRetryAfter)) {
        throw err;
      }
      await this.sleep(this.delay(attempt, err.retryAfter));
    }
  }

  delay(attempt, retryAfter) {
    if (retryAfter != null) return retryAfter * 1000;
    return Math.min(this.maxBackoff, this.backoff * 2 ** attempt) * (0.5 + Math.random() / 2);
  }

  async json(method, path, json, opts = {}) {
    const resp = await this.request(method, path, { ...opts, json });
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }
}

async function toError(resp, method, path) {
  const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
  const text = await resp.text().catch(() => '');
  let code = `http_${resp.status}`;
  let message = '';
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (parsed && typeof parsed.error === 'object' && parsed.error) {
    code = String(parsed.error.code || code);
    message = String(parsed.error.message || '');
  } else {
    message = text.trim().slice(0, 300) || resp.statusText || '';
    if (text.includes('error code: 1010')) message += " (Cloudflare refused the client's User-Agent)";
  }
  return new ApiError(resp.status, code, message, { method, path, retryAfter, body: parsed ?? text });
}

// ------------------------------------------------------------------------------- scenes

function matches(value, want) {
  if (want === undefined || want === null) return true;
  if (value === undefined || value === null) return false;
  if (want instanceof RegExp) return want.test(String(value));
  return String(value) === want;
}

/** Every element of a scene (`scene({ elements: true })`) matching all fields given, front first. */
export function findElements(scene, { label, role, interaction, value, includeDisabled = false } = {}) {
  if (!Array.isArray(scene?.elements)) throw new Error('the scene has no elements; ask for it with { elements: true }');
  return scene.elements.filter(
    (e) =>
      (includeDisabled || !e.disabled) &&
      matches(e.label, label) &&
      matches(e.role, role) &&
      matches(e.interaction, interaction) &&
      matches(e.value, value),
  );
}

/** The `index`-th match (the frontmost by default); throws ElementNotFound naming what is on screen. */
export function findElement(scene, { index = 0, ...query } = {}) {
  const found = findElements(scene, query);
  if (index < found.length) return found[index];
  const want = Object.fromEntries(
    Object.entries(query)
      .filter(([k, v]) => v != null && k !== 'includeDisabled')
      .map(([k, v]) => [k, String(v)]),
  );
  const seen = [...new Set((scene.elements || []).map((e) => `${e.role}:${e.label}`))].sort().slice(0, 20);
  throw new ElementNotFound(
    `no element matches ${JSON.stringify(want)} (found ${found.length}, wanted index ${index}); ` +
      `on screen: ${seen.join(', ') || 'nothing interactive'}`,
  );
}

/** An element's centre in screen pixels, `[x, y]`. */
export function center(element) {
  if (Array.isArray(element.center) && element.center.length === 2) return [element.center[0], element.center[1]];
  const r = element.rect;
  return [r.x + Math.floor(r.width / 2), r.y + Math.floor(r.height / 2)];
}


// ------------------------------------------------------------------------------- helpers

const q = encodeURIComponent;
const dropUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const idOf = (x) => (typeof x === 'string' ? x : x.id);

/** A picture answer as `{ bytes, etag, stateHash, tick, width, height, format }`. */
async function frameOf(resp, format) {
  const int = (name) => (resp.headers.get(name) == null ? null : Number(resp.headers.get(name)));
  return {
    bytes: new Uint8Array(await resp.arrayBuffer()),
    etag: resp.headers.get('etag'),
    stateHash: resp.headers.get('x-state-hash'),
    tick: int('x-tick'),
    width: int('x-width'),
    height: int('x-height'),
    format,
  };
}

/** `'template/id'`, `{ template, id }`, or a whole procedure → the API's `ref | procedure`. */
function procedureBody(procedure) {
  if (typeof procedure === 'string') {
    const i = procedure.indexOf('/');
    if (i <= 0 || i === procedure.length - 1) throw new Error(`a procedure reference is 'template/id', got '${procedure}'`);
    return { ref: { template: procedure.slice(0, i), id: procedure.slice(i + 1) } };
  }
  if (procedure && typeof procedure === 'object') {
    if (Array.isArray(procedure.phases)) return { procedure };
    if (procedure.template && procedure.id) return { ref: { template: procedure.template, id: procedure.id } };
  }
  throw new Error("a procedure is 'template/id', { template, id }, or a procedure with phases");
}

const agentRef = (a) =>
  a instanceof Agent
    ? a.id
    : a && typeof a === 'object'
      ? Object.fromEntries(Object.entries(a).map(([role, x]) => [role, agentRef(x)]))
      : a;

const ndjson = (text) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

// ------------------------------------------------------------------------------- client

/**
 * The owner's door to the hosted API, authenticated with an API key. `apiKey` and `baseUrl`
 * default to COMPUTERWORLD_API_KEY and COMPUTERWORLD_API_BASE where `process.env` exists.
 */
export class Client {
  constructor(apiKey, { baseUrl, transport, ...opts } = {}) {
    this._t =
      transport ??
      new Transport(baseUrl ?? env('COMPUTERWORLD_API_BASE') ?? DEFAULT_BASE_URL, apiKey ?? env('COMPUTERWORLD_API_KEY'), opts);
  }

  get baseUrl() {
    return this._t.baseUrl;
  }

  _get(path, params) {
    return this._t.json('GET', path, undefined, { params });
  }
  _post(path, body = {}) {
    return this._t.json('POST', path, body);
  }
  async _delete(path) {
    await this._t.request('DELETE', path);
  }

  /**
   * Make an account, then an API key with its session (every scope unless `scopes` names some:
   * simulations, templates, models, account). Resolves to `{ client, user, key }`: a client
   * holding the key, the account, and the key as made (its `key` is the secret, shown once).
   * Server side only: a browser does not let a script read the session cookie.
   */
  static async signup(username, password, { baseUrl, keyName, scopes, ...opts } = {}) {
    const t = new Transport(baseUrl ?? env('COMPUTERWORLD_API_BASE') ?? DEFAULT_BASE_URL, null, opts);
    const resp = await t.request('POST', '/auth/signup', { json: { username, password } });
    const { user } = await resp.json();
    const cookie = (resp.headers.get('set-cookie') ?? '').split(';')[0];
    const key = await t.json('POST', '/keys', dropUndefined({ name: keyName, scopes }), { headers: { cookie } });
    return { client: new Client(null, { transport: t.withToken(key.key) }), user, key };
  }

  // accounts
  health() {
    return this._t.json('GET', '/health', undefined, { auth: false });
  }
  me() {
    return this._get('/me');
  }
  /** Set profile fields (name, date_of_birth); a field left out is kept, `null` clears it. */
  async updateMe(fields) {
    return (await this._t.json('PATCH', '/me', fields)).user;
  }
  /** Set the account's e-mail address and send it a six-digit code; then `verifyEmail(code)`. */
  async setEmail(email) {
    return (await this._t.json('POST', '/me/email', { email })).email;
  }
  /** Confirm the code: `{user, email, standing, tag}` (the tag an academic domain gave, or null). */
  verifyEmail(code) {
    return this._t.json('POST', '/me/email/verify', { code });
  }
  async usage(days = 30) {
    return (await this._get('/me/usage', { days })).days;
  }
  async listKeys() {
    return (await this._get('/keys')).keys;
  }
  /** A new API key; `scopes` defaults to every one. Its `key` field is the secret, shown once. */
  createKey(name, { scopes } = {}) {
    return this._post('/keys', dropUndefined({ name, scopes }));
  }
  revokeKey(keyId) {
    return this._delete(`/keys/${q(keyId)}`);
  }

  // templates
  /** The built-in templates and the organization's own, one list (`source: 'builtin' | 'own'`). */
  async listTemplates() {
    return (await this._get('/templates')).templates;
  }
  /** A template's definition. */
  getTemplate(id) {
    return this._get(`/templates/${q(id)}`);
  }
  /** Save a definition as one of the organization's templates. */
  createTemplate({ name, definition } = {}) {
    return this._post('/templates', dropUndefined({ name, definition }));
  }
  updateTemplate(id, { name, definition } = {}) {
    return this._t.json('PUT', `/templates/${q(id)}`, dropUndefined({ name, definition }));
  }
  deleteTemplate(id) {
    return this._delete(`/templates/${q(id)}`);
  }
  templateTopology(id) {
    return this._get(`/templates/${q(id)}/topology`);
  }
  /** Apply `[{ op, ... }]` in order, all or nothing; resolves to the new topology. */
  editTemplateTopology(id, edits) {
    return this._post(`/templates/${q(id)}/topology`, { edits });
  }
  async templateProcedures(id) {
    return (await this._get(`/templates/${q(id)}/procedures`)).procedures;
  }
  templateProcedure(id, procedureId) {
    return this._get(`/templates/${q(id)}/procedures/${q(procedureId)}`);
  }
  /** Draw an instance of a template's procedure. */
  instantiate(template, procedureId, { seed = 1, overrides } = {}) {
    return this._post(`/templates/${q(template)}/procedures/${q(procedureId)}/instantiate`, dropUndefined({ seed, overrides }));
  }
  async templateSocieties(id) {
    return (await this._get(`/templates/${q(id)}/societies`)).societies;
  }
  templateSociety(id, societyId) {
    return this._get(`/templates/${q(id)}/societies/${q(societyId)}`);
  }
  vocabulary() {
    return this._get('/vocabulary');
  }
  /** Boot a definition with the engine and drop it; with `society`, also the people it compiles to. */
  validate(definition, { society } = {}) {
    return this._post('/validate', dropUndefined({ definition, society }));
  }

  // simulations
  async listSimulations() {
    return (await this._get('/simulations')).simulations;
  }
  /**
   * Boot a simulation: `createSimulation('agent-desktop', { seed })`, or
   * `createSimulation(null, { definition })`. `society` (`{ id | spec, rule, journal, rounds }`,
   * or a template's society id) adds simulated agents. `idleTtl` (seconds): the service deletes
   * the simulation after that long with no request to it. `place`: where it runs, a place's id
   * (`'core'`, `'office'`, `'media'`, `'container'`), `'do'` or `'container'`, or a list of
   * those tried in order; left out, a Durable Object first, and a container only for a stated
   * reason. `info.place` says where it runs and why, `info.refused` the places that refused it.
   */
  async createSimulation(template, { definition, seed = 1, name, platform, society, idleTtl, place } = {}) {
    if ((template == null) === (definition == null)) throw new Error('pass exactly one of template, definition');
    const soc = typeof society === 'string' ? { id: society } : society;
    return new Simulation(
      this,
      await this._post('/simulations', dropUndefined({ template, definition, seed, name, platform, society: soc, idle_ttl: idleTtl, place })),
    );
  }
  async getSimulation(id) {
    return new Simulation(this, await this._get(`/simulations/${q(id)}`));
  }
  /** Boot a new simulation from what `simulation.exportSnapshot()` returned; `place` is as for `createSimulation`. */
  async importSimulation(bundle, name, { place, idleTtl } = {}) {
    return new Simulation(this, await this._post('/simulations/import', dropUndefined({ snapshot: bundle, name, place, idle_ttl: idleTtl })));
  }

  // agent models (OpenAI's paths)
  async models() {
    return (await this._get('/models')).data;
  }
  /** OpenAI chat completions: `chat({ model: 'deepseek-flash', messages, tools })`. */
  chat(body) {
    return this._post('/chat/completions', body);
  }
}

/** A running simulation the organization owns: one world with its clock, machines, snapshots, agents and forks. */
export class Simulation {
  constructor(client, info) {
    this._c = client;
    this.info = info;
    this.id = info.id;
    this._p = `/simulations/${q(this.id)}`;
    this._agents = new Map();
    for (const grant of Array.isArray(info.agents) ? info.agents : []) {
      if (grant?.token) this._agents.set(grant.id, Agent._fromGrant(client, this.id, grant));
    }
    this.society = new Society(client, this._p);
  }

  async refresh() {
    return (this.info = await this._c._get(this._p));
  }
  async rename(name) {
    return (this.info = await this._c._t.json('PATCH', this._p, { name }));
  }
  /** Delete the simulation, its snapshots and its agents. */
  delete() {
    return this._c._delete(this._p);
  }
  /** `await using sim = await client.createSimulation(...)` deletes it at the end of the block. */
  [Symbol.asyncDispose ?? Symbol.for('Symbol.asyncDispose')]() {
    return this.delete();
  }
  /** A file on a machine, as the owner reads it: `{ machine, path, content, base64, bytes }`. */
  readFile(path, { machine } = {}) {
    return this._c._get(`${this._p}/files`, dropUndefined({ machine, path }));
  }
  /** Write a file onto a machine: text, or bytes (a Uint8Array). */
  writeFile(path, data, { machine } = {}) {
    const body = typeof data === 'string' ? { content: data } : { base64: btoa(Array.from(data, (b) => String.fromCharCode(b)).join('')) };
    return this._c._t.json('PUT', `${this._p}/files`, body, { params: dropUndefined({ machine, path }) });
  }

  // clock and state
  async stateHash() {
    return (await this.clock()).state_hash;
  }
  clock() {
    return this._c._get(`${this._p}/state_hash`);
  }
  /** Move the clock: `advance('30s')`, `advance({ ticks: 1_000_000 })`. */
  advance(arg) {
    const body = typeof arg === 'string' ? { duration: arg } : typeof arg === 'number' ? { ticks: arg } : dropUndefined(arg ?? {});
    if (('duration' in body) === ('ticks' in body)) throw new Error('pass one of duration or ticks');
    return this._c._post(`${this._p}/advance`, body);
  }
  /** Back to the definition; external agents are dropped. */
  reset(seed) {
    this._agents.clear();
    return this._c._post(`${this._p}/reset`, dropUndefined({ seed }));
  }
  inspect(pointer) {
    return this._c._get(`${this._p}/inspect`, { pointer });
  }
  definition() {
    return this._c._get(`${this._p}/definition`);
  }
  trajectory() {
    return this._c._get(`${this._p}/trajectory`);
  }
  serviceState(serviceId) {
    return this._c._get(`${this._p}/services/${q(serviceId)}/state`);
  }
  patchServiceState(serviceId, patch) {
    return this._c._t.json('PATCH', `${this._p}/services/${q(serviceId)}/state`, patch);
  }

  // topology
  topology() {
    return this._c._get(`${this._p}/topology`);
  }
  addComputer(computer, node, links, theme) {
    return this._c._post(`${this._p}/machines`, dropUndefined({ computer, node, links, theme }));
  }
  removeComputer(machineId) {
    return this._c._t.json('DELETE', `${this._p}/machines/${q(machineId)}`);
  }

  // snapshots and history
  /** Keep a snapshot: `{ id, label, state_hash, tick, parent, author, frames, head, … }`. It is the simulation's head now. */
  snapshot(label) {
    return this._c._post(`${this._p}/snapshots`, dropUndefined({ label }));
  }
  /** The kept snapshots, oldest first. `history()` and `refresh()` name the head. */
  async snapshots() {
    return (await this._c._get(`${this._p}/snapshots`)).snapshots;
  }
  /**
   * Restore a snapshot: `{ state_hash, tick, head, elapsed_ms, conversations_kept, agents }`. The agents,
   * their connections and their threads become the snapshot's; an agent removed after it comes back
   * with a new `token` in `agents`.
   */
  restore(snapshot) {
    return this._c._post(`${this._p}/snapshots/${q(idOf(snapshot))}/restore`);
  }
  /** The agents a snapshot kept: `{ agents, conversations_kept }`. */
  snapshotAgents(snapshot) {
    return this._c._get(`${this._p}/snapshots/${q(idOf(snapshot))}/agents`);
  }
  /** One agent's thread as a snapshot kept it: `{ messages, state }`, after `after`. */
  snapshotMessages(snapshot, agent, { after = 0 } = {}) {
    return this._c._t.json('GET', `${this._p}/snapshots/${q(idOf(snapshot))}/agents/${q(idOf(agent))}/messages`, undefined, { params: { after } });
  }
  /** Drop a snapshot; its children hang from its parent. Resolves to what is left: `{ snapshots, head }`. */
  dropSnapshot(snapshot) {
    return this._c._t.json('DELETE', `${this._p}/snapshots/${q(idOf(snapshot))}`);
  }
  /**
   * The PNG of a machine's screen when the snapshot was taken, for each machine the
   * snapshot's `frames` names: `{ bytes, etag, stateHash, tick, width, height, format }`,
   * a header the answer lacks being null.
   */
  async snapshotFrame(snapshot, machine) {
    const resp = await this._c._t.request('GET', `${this._p}/snapshots/${q(idOf(snapshot))}/frames/${q(machine)}`, {
      headers: { accept: 'image/png' },
    });
    return frameOf(resp, 'png');
  }
  /**
   * The family's history: `{ simulation, simulations }`, the furthest ancestor first, each
   * with its place, origin, head and snapshots. No simulation is woken to answer.
   */
  history() {
    return this._c._get(`${this._p}/history`);
  }
  exportSnapshot() {
    return this._c._get(`${this._p}/export`);
  }

  // forks
  /**
   * A new simulation copied from this one as it is now (`forked_from` names this one). A
   * society comes over with its runner state, and `societyOps` (an arm's rule ops) are applied
   * to it. External agents come over under new tokens: `fork.getAgent(id)`. `snapshot` forks from
   * a kept snapshot. `place` is as for a new simulation; left out, the fork runs where its
   * parent does (`'do'` moves a container's copy to a Durable Object).
   */
  async fork({ name, snapshot, societyOps, place, idleTtl } = {}) {
    const body = dropUndefined({ name, snapshot: snapshot == null ? undefined : idOf(snapshot), society_ops: societyOps, place, idle_ttl: idleTtl });
    return new Simulation(this._c, await this._c._post(`${this._p}/fork`, body));
  }
  /** The ids of this simulation's forks. */
  async forks() {
    return (await this.refresh()).forks ?? [];
  }

  // agents
  /** Grant an external agent and resolve to its handle, which holds the actor token. */
  async agent(config = {}) {
    const grant = await this._c._post(`${this._p}/agents`, config);
    const agent = Agent._fromGrant(this._c, this.id, grant);
    this._agents.set(agent.id, agent);
    return agent;
  }
  /**
   * A hosted agent: one the platform runs (Computatrum's agent loop) on `machine`, as its user.
   * Prompt it with `agent.prompt(text)` and follow its thread with `agent.stream()`.
   */
  async hostedAgent(machine, { name } = {}) {
    const made = await this._c._post(`${this._p}/agents`, dropUndefined({ kind: 'hosted', machine, name }));
    return Agent._fromGrant(this._c, this.id, made);
  }
  /** Every agent: the external ones (`kind: 'external'`, never their tokens), the hosted ones, and the society's people (`kind: 'simulated'`). */
  async agents() {
    return (await this._c._get(`${this._p}/agents`)).agents;
  }
  /** A handle on one of the society's people, for its thread (what they did in the rounds; it takes no prompt). */
  person(personId) {
    return new Agent(this._c._t, this.id, personId, { grant: { id: personId, kind: 'simulated' }, owner: this._c });
  }
  /** A handle on an external or hosted agent: with its token if this object holds it, else fetched with the owner's key. */
  async getAgent(agentId) {
    if (this._agents.has(agentId)) return this._agents.get(agentId);
    const grant = await this._c._get(`${this._p}/agents/${q(agentId)}`);
    return Agent._fromGrant(this._c, this.id, grant);
  }
  revoke(agent) {
    const id = idOf(agent);
    this._agents.delete(id);
    return this._c._delete(`${this._p}/agents/${q(id)}`);
  }
  /**
   * Connect an agent to a machine; resolves to the agent. It keeps its id, token and thread,
   * and its session is made again. A hosted agent drives one machine, so this moves it.
   */
  connectAgent(agent, machine) {
    return this._c._t.json('PUT', `${this._p}/agents/${q(idOf(agent))}/machines/${q(machine)}`);
  }
  /** Disconnect an agent from a machine; resolves to the agent. */
  disconnectAgent(agent, machine) {
    return this._c._t.json('DELETE', `${this._p}/agents/${q(idOf(agent))}/machines/${q(machine)}`);
  }
  /** One grounded gesture, `{ do: 'click', target: { label: 'Post' } }`, found on the agent's screen. */
  perform(agent, gesture, { width, height } = {}) {
    const body = { agent: agentRef(agent), gesture };
    const options = dropUndefined({ width, height });
    if (Object.keys(options).length) body.options = options;
    return this._c._post(`${this._p}/perform`, body);
  }

  // procedures
  stage(instance) {
    return this._c._post(`${this._p}/procedures/stage`, { instance });
  }
  /** Perform an instance through an agent (or `{ role: agent }`). */
  project(agent, instance, options) {
    return this._c._post(`${this._p}/procedures/project`, dropUndefined({ instance, agent: agentRef(agent), options }));
  }
  verify(instance) {
    return this._c._post(`${this._p}/procedures/verify`, { instance });
  }
  /** Instantiate, stage, project and verify. `fork: true` leaves this simulation as it was. */
  run(procedure, { seed = 1, fork = false, includeSteps = false, options, overrides, agent } = {}) {
    return this._c._post(`${this._p}/procedures/run`, {
      ...procedureBody(procedure),
      ...dropUndefined({ seed, fork, include_steps: includeSteps, options, overrides, agent: agentRef(agent) }),
    });
  }
}

/**
 * An agent of a simulation, with its thread (`messages`, `prompt`, `stream`, `stop`); an
 * external agent is also the actor's door to the simulation. Actor calls use the actor token when
 * the handle has one, so the handle can be given to an agent program without the owner's key.
 * `width`/`height` are the viewport the scene, the render and the pointer helpers use.
 */
export class Agent {
  constructor(transport, simulationId, agentId, { token = null, grant = {}, owner = null, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}) {
    this._t = transport;
    this.simulationId = simulationId;
    this.id = agentId;
    this.token = token;
    this.grant = grant;
    this._owner = owner;
    this.width = width;
    this.height = height;
    this._p = `/simulations/${q(simulationId)}/agents/${q(agentId)}`;
  }

  static _fromGrant(client, simulationId, grant) {
    const t = grant.token ? client._t.withToken(grant.token) : client._t;
    return new Agent(t, simulationId, grant.id, { token: grant.token ?? null, grant, owner: client });
  }

  /** An agent's handle from an actor token alone. */
  static connect(token, simulationId, agentId, { baseUrl, ...opts } = {}) {
    const t = new Transport(baseUrl ?? env('COMPUTERWORLD_API_BASE') ?? DEFAULT_BASE_URL, token, opts);
    return new Agent(t, simulationId, agentId, { token });
  }

  get config() {
    return this.grant.config ?? {};
  }

  /**
   * Send up to 64 actions in order. An action outside the grant is an unsuccessful outcome.
   * `render: { width, height, ifChanged }` answers the screen they left as `frame` (a base64 PNG).
   */
  step(actions, { render } = {}) {
    const body = { actions: Array.isArray(actions) ? actions : [actions] };
    if (render) body.render = dropUndefined({ width: render.width ?? this.width, height: render.height ?? this.height, if_changed: render.ifChanged });
    return this._t.json('POST', `${this._p}/step`, body);
  }
  observe() {
    return this._t.json('GET', `${this._p}/observe`);
  }
  /** The scene graph; `{ elements: true }` adds every interactive element, front first. */
  scene({ width, height, elements = false } = {}) {
    return this._t.json('GET', `${this._p}/scene`, undefined, {
      params: { width: width ?? this.width, height: height ?? this.height, elements: elements ? 1 : undefined },
    });
  }
  /**
   * The screen as `{ bytes, etag, stateHash, tick, width, height, format }`; with
   * `ifNoneMatch` (a previous frame's etag) an unchanged screen resolves to null.
   */
  async render({ width, height, format = 'png', ifNoneMatch } = {}) {
    const headers = { accept: format === 'png' ? 'image/png' : 'application/octet-stream' };
    if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
    const resp = await this._t.request('GET', `${this._p}/render`, {
      params: { width: width ?? this.width, height: height ?? this.height, format },
      headers,
      ok: [304],
    });
    if (resp.status === 304) return null;
    return frameOf(resp, format);
  }
  async info() {
    return (this.grant = await this._t.json('GET', this._p));
  }

  // the thread
  /** The owner's transport: prompts and stops are the owner's. */
  get _ownerT() {
    if (!this._owner?._t.token) throw new ComputerWorldError('this is an owner call; this handle has only an actor token');
    return this._owner._t;
  }
  /**
   * The thread after the message `after` (0: from the start), `{ messages, state }`; with `wait`
   * (seconds, at most 25) a read with nothing new waits for a message.
   */
  messages({ after = 0, wait } = {}) {
    return this._t.json('GET', `${this._p}/messages`, undefined, { params: dropUndefined({ after, wait }) });
  }
  /** A prompt from the owner: `{ message, state }`. A hosted agent starts on it (or after the task it is on). */
  async prompt(text) {
    return this._ownerT.json('POST', `${this._p}/messages`, { text });
  }
  /** What an external agent writes into its own thread: `{ role: 'agent' | 'action' | 'status', text, status?, … }`. */
  post(message) {
    return this._t.json('POST', `${this._p}/messages`, message);
  }
  /** Stop it (the owner): a hosted agent's task is cut short; an external agent's thread says it was stopped. `{ state }`. */
  async stop() {
    return this._ownerT.json('POST', `${this._p}/stop`);
  }
  /**
   * The thread's messages as they come, by long-polling: `for await (const m of agent.stream()) …`.
   * It ends when `until(message, state)` is true of a message, or when `signal` aborts.
   */
  async *stream({ after = 0, wait = 25, until, signal } = {}) {
    while (!signal?.aborted) {
      const { messages, state } = await this.messages({ after, wait });
      for (const m of messages) {
        after = m.seq;
        yield m;
        if (until?.(m, state)) return;
      }
    }
  }

  // helpers
  async findAll(query = {}) {
    return findElements(query.scene ?? (await this.scene({ elements: true })), query);
  }
  /** The frontmost element matching `{ label, role, interaction, value }` (strings exact, or RegExps). */
  async find(query = {}) {
    return findElement(query.scene ?? (await this.scene({ elements: true })), query);
  }
  /**
   * Click `{ x, y }`, an `element`, or the centre of what a fresh scene finds by
   * `label`/`role`/`interaction`. With `check` (default) an unsuccessful outcome throws.
   */
  async click({ x, y, element, label, role, interaction, index = 0, button, modifiers, double = false, machine, check = true } = {}) {
    if (x == null || y == null) {
      if (!element) {
        if (label == null && role == null && interaction == null) throw new Error('click needs x and y, an element, or a label/role/interaction');
        element = await this.find({ label, role, interaction, index });
      }
      [x, y] = center(element);
    }
    const payload = dropUndefined({ x, y, width: this.width, height: this.height, button, modifiers });
    return this._act({ family: 'pointer.v1', op: double ? 'double_click' : 'click', payload }, machine, check);
  }
  typeText(text, { machine, check = true } = {}) {
    return this._act({ family: 'keyboard.v1', op: 'type', payload: { text } }, machine, check);
  }
  /** A key or chord: `'Enter'`, `'Ctrl+S'`. */
  press(key, { machine, check = true } = {}) {
    return this._act({ family: 'keyboard.v1', op: 'key', payload: { key } }, machine, check);
  }
  async _act(action, machine, check) {
    if (machine) action.machine = machine;
    const result = await this.step([action]);
    const outcome = result.outcomes?.[0] ?? {};
    if (check && !outcome.success) throw new ActionFailed(action, outcome);
    return result;
  }
  /** One grounded gesture through this agent (an owner call: needs the API key). */
  perform(gesture) {
    if (!this._owner?._t.token) throw new ComputerWorldError('perform is an owner call; this handle has only an actor token');
    return new Simulation(this._owner, { id: this.simulationId }).perform(this.id, gesture, { width: this.width, height: this.height });
  }
}

/** A simulation's society: its simulated agents, their rules and rounds. */
export class Society {
  constructor(client, simulationPath) {
    this._c = client;
    this._p = `${simulationPath}/society`;
  }
  /** `{ spec_id, people, round, rounds, metrics }`; a 404 when the simulation has no society. */
  info() {
    return this._c._get(this._p);
  }
  /** Run 1 to 100 rounds in this simulation only (a fork runs its own); `pending` lists the model decisions the journal lacks. */
  runRounds(count = 1, { askModel } = {}) {
    return this._c._post(`${this._p}/rounds`, dropUndefined({ count, ask_model: askModel || undefined }));
  }
  async journal() {
    return ndjson(await (await this._c._t.request('GET', `${this._p}/journal`)).text());
  }
  /** Answers for pending decisions: `[{ key, reply }]`. */
  addJournal(entries) {
    return this._c._post(`${this._p}/journal`, { entries });
  }
  async trace({ since } = {}) {
    return ndjson(await (await this._c._t.request('GET', `${this._p}/trace`, { params: { since } })).text());
  }
  /** Outcomes per round for this simulation and each fork, their divergence and state hashes. */
  summary() {
    return this._c._get(`${this._p}/summary`);
  }
}
