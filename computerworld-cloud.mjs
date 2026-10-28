// computerworld-cloud: a client for the hosted ComputerWorld API.
//
// One ES module, no dependencies, for Node 18+ and browsers. It can be imported from a
// checkout, from `npm install <path to clients/js>`, or straight from a URL:
//
//   import { Client } from 'https://cdn.jsdelivr.net/gh/ComputaCo/computerworld@main/computerworld-cloud.mjs';
//
// Types are in computerworld-cloud.d.mts beside it. The contract is cloud/openapi.yaml.

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://computerworld.pages.dev/v1';
export const USER_AGENT = `computerworld-cloud-js/${VERSION}`;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

// 429 and 503 mean the request was not processed, so any method may be sent again.
// 500, 502 and 504 may come after the world changed, so only idempotent methods retry.
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

function refBody(thing, kind) {
  if (typeof thing === 'string') {
    const i = thing.indexOf('/');
    if (i <= 0 || i === thing.length - 1) throw new Error(`a ${kind} reference is 'world/id', got '${thing}'`);
    return { ref: { world: thing.slice(0, i), id: thing.slice(i + 1) } };
  }
  if (thing && typeof thing === 'object') {
    const keys = Object.keys(thing);
    if (keys.length === 2 && 'world' in thing && 'id' in thing) return { ref: { world: thing.world, id: thing.id } };
    return kind === 'procedure' ? { procedure: thing } : { spec: thing };
  }
  throw new Error(`a ${kind} is 'world/id', { world, id }, or a whole ${kind === 'procedure' ? 'procedure' : 'spec'}`);
}

const envRef = (e) =>
  e instanceof Environment
    ? e.id
    : e && typeof e === 'object'
      ? Object.fromEntries(Object.entries(e).map(([role, x]) => [role, envRef(x)]))
      : e;

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

  /** Make an account; resolves to `{ client, answer }` with a client holding its first API key. */
  static async signup(username, password, { baseUrl, ...opts } = {}) {
    const t = new Transport(baseUrl ?? env('COMPUTERWORLD_API_BASE') ?? DEFAULT_BASE_URL, null, opts);
    const answer = await t.json('POST', '/auth/signup', { username, password });
    return { client: new Client(null, { transport: t.withToken(answer.api_key.key) }), answer };
  }

  // accounts
  health() {
    return this._t.json('GET', '/health', undefined, { auth: false });
  }
  me() {
    return this._get('/me');
  }
  /** Set profile fields; a field left out is kept, `null` clears it. */
  async updateMe(fields) {
    return (await this._t.json('PATCH', '/me', fields)).user;
  }
  async usage(days = 30) {
    return (await this._get('/me/usage', { days })).days;
  }
  async listKeys() {
    return (await this._get('/keys')).keys;
  }
  createKey(name) {
    return this._post('/keys', dropUndefined({ name }));
  }
  revokeKey(keyId) {
    return this._delete(`/keys/${q(keyId)}`);
  }

  // catalog
  async catalogWorlds() {
    return (await this._get('/catalog/worlds')).worlds;
  }
  catalogWorld(name) {
    return this._get(`/catalog/worlds/${q(name)}`);
  }
  async catalogProcedures(world) {
    return (await this._get('/catalog/procedures', { world })).procedures;
  }
  catalogProcedure(world, id) {
    return this._get(`/catalog/procedures/${q(world)}/${q(id)}`);
  }
  async catalogSocieties() {
    return (await this._get('/catalog/societies')).societies;
  }
  catalogSociety(world, id) {
    return this._get(`/catalog/societies/${q(world)}/${q(id)}`);
  }
  vocabulary() {
    return this._get('/catalog/vocabulary');
  }

  // blueprints
  async listBlueprints() {
    return (await this._get('/blueprints')).blueprints;
  }
  /** From a built-in world or blueprint id (`from`), or a `definition`. */
  createBlueprint({ name, from, definition } = {}) {
    return this._post('/blueprints', dropUndefined({ name, from, definition }));
  }
  getBlueprint(id) {
    return this._get(`/blueprints/${q(id)}`);
  }
  updateBlueprint(id, { name, definition } = {}) {
    return this._t.json('PUT', `/blueprints/${q(id)}`, dropUndefined({ name, definition }));
  }
  deleteBlueprint(id) {
    return this._delete(`/blueprints/${q(id)}`);
  }
  blueprintTopology(id) {
    return this._get(`/blueprints/${q(id)}/topology`);
  }
  /** Apply `[{ op, ... }]` in order, all or nothing; resolves to the new topology. */
  editBlueprintTopology(id, edits) {
    return this._t.json('PATCH', `/blueprints/${q(id)}/topology`, { edits });
  }
  validate(definition) {
    return this._post('/validate', { definition });
  }

  // worlds
  async listWorlds() {
    return (await this._get('/worlds')).worlds;
  }
  /** Boot a world: `createWorld('agent-desktop', { seed })`, or `{ blueprint }` / `{ definition }`. */
  async createWorld(world, { blueprint, definition, seed = 1, platform, name } = {}) {
    if ([world, blueprint, definition].filter((x) => x != null).length !== 1) {
      throw new Error('pass exactly one of world, blueprint, definition');
    }
    return new World(this, await this._post('/worlds', dropUndefined({ world, blueprint, definition, seed, platform, name })));
  }
  async getWorld(id) {
    return new World(this, await this._get(`/worlds/${q(id)}`));
  }
  /** Boot a new world from what `world.exportSnapshot()` returned. */
  async importWorld(bundle, name) {
    return new World(this, await this._post('/worlds/import', dropUndefined({ snapshot: bundle, name })));
  }

  // procedures
  /** Draw an instance: `procedure` is `'world/id'`, `{ world, id }` or a whole procedure. */
  instantiate(procedure, seed = 1, overrides) {
    return this._post('/procedures/instantiate', { ...refBody(procedure, 'procedure'), ...dropUndefined({ seed, overrides }) });
  }

  // swarms
  compileSwarm(society, { world, seed } = {}) {
    return this._post('/swarms/compile', { ...refBody(society, 'society'), ...dropUndefined({ world, seed }) });
  }
  async listSwarms() {
    return (await this._get('/swarms')).swarms;
  }
  /** Compile and boot a society. `journal: 'builtin'` replays the recorded one. */
  async createSwarm(society, { world, seed, name, journal } = {}) {
    return new Swarm(this, await this._post('/swarms', { ...refBody(society, 'society'), ...dropUndefined({ world, seed, name, journal }) }));
  }
  async getSwarm(id) {
    return new Swarm(this, await this._get(`/swarms/${q(id)}`));
  }
}

/** A running world the account owns: the hosted counterpart of the engine's `World`. */
export class World {
  constructor(client, info) {
    this._c = client;
    this.info = info;
    this.id = info.id;
    this._p = `/worlds/${q(this.id)}`;
    this._handles = new Map();
    for (const grant of Array.isArray(info.environments) ? info.environments : []) {
      if (grant?.token) this._handles.set(grant.id, Environment._fromGrant(client, this.id, grant));
    }
  }

  async refresh() {
    return (this.info = await this._c._get(this._p));
  }
  /** Delete the world, its snapshots and its environments. */
  delete() {
    return this._c._delete(this._p);
  }
  /** `await using world = await client.createWorld(...)` deletes it at the end of the block. */
  [Symbol.asyncDispose ?? Symbol.for('Symbol.asyncDispose')]() {
    return this.delete();
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
  reset(seed) {
    this._handles.clear();
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

  // snapshots
  snapshot(label) {
    return this._c._post(`${this._p}/snapshots`, dropUndefined({ label }));
  }
  async snapshots() {
    return (await this._c._get(`${this._p}/snapshots`)).snapshots;
  }
  restore(snapshot) {
    const id = typeof snapshot === 'string' ? snapshot : snapshot.id;
    return this._c._post(`${this._p}/snapshots/${q(id)}/restore`);
  }
  dropSnapshot(snapshot) {
    const id = typeof snapshot === 'string' ? snapshot : snapshot.id;
    return this._c._delete(`${this._p}/snapshots/${q(id)}`);
  }
  /** A new world from now (or a kept snapshot); its environments come over under new tokens. */
  async fork(snapshot, name) {
    const id = snapshot == null ? undefined : typeof snapshot === 'string' ? snapshot : snapshot.id;
    return new World(this._c, await this._c._post(`${this._p}/fork`, dropUndefined({ snapshot: id, name })));
  }
  exportSnapshot() {
    return this._c._get(`${this._p}/export`);
  }

  // environments
  /** Grant an environment and resolve to a handle holding its actor token. */
  async environment(config = {}) {
    const grant = await this._c._post(`${this._p}/environments`, config);
    const handle = Environment._fromGrant(this._c, this.id, grant);
    this._handles.set(handle.id, handle);
    return handle;
  }
  async environments() {
    return (await this._c._get(`${this._p}/environments`)).environments;
  }
  /** A handle on an existing environment: with its token if this object holds it, else the owner's key. */
  async session(envId) {
    if (this._handles.has(envId)) return this._handles.get(envId);
    const grant = await this._c._get(`${this._p}/environments/${q(envId)}`);
    return Environment._fromGrant(this._c, this.id, grant);
  }
  revoke(environment) {
    const id = typeof environment === 'string' ? environment : environment.id;
    this._handles.delete(id);
    return this._c._delete(`${this._p}/environments/${q(id)}`);
  }
  /** One grounded gesture, `{ do: 'click', target: { label: 'Post' } }`, found on the environment's screen. */
  perform(environment, gesture, { width, height } = {}) {
    const body = { environment: envRef(environment), gesture };
    const options = dropUndefined({ width, height });
    if (Object.keys(options).length) body.options = options;
    return this._c._post(`${this._p}/perform`, body);
  }

  // procedures
  stage(instance) {
    return this._c._post(`${this._p}/procedures/stage`, { instance });
  }
  /** Perform an instance through an environment (or `{ role: environment }`). */
  project(environment, instance, options) {
    return this._c._post(`${this._p}/procedures/project`, dropUndefined({ instance, environment: envRef(environment), options }));
  }
  verify(instance) {
    return this._c._post(`${this._p}/procedures/verify`, { instance });
  }
  /** Instantiate, stage, project and verify. `fork: true` leaves this world as it was. */
  run(procedure, { seed = 1, fork = false, includeSteps = false, options, overrides, environment } = {}) {
    return this._c._post(`${this._p}/procedures/run`, {
      ...refBody(procedure, 'procedure'),
      ...dropUndefined({ seed, fork, include_steps: includeSteps, options, overrides, environment: envRef(environment) }),
    });
  }
}

/**
 * An actor's environment. Actor calls use the actor token when the handle has one, so the
 * handle can be given to an agent without the owner's key. `width`/`height` are the viewport
 * the scene, the render and the pointer helpers use.
 */
export class Environment {
  constructor(transport, worldId, envId, { token = null, grant = {}, owner = null, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}) {
    this._t = transport;
    this.worldId = worldId;
    this.id = envId;
    this.token = token;
    this.grant = grant;
    this._owner = owner;
    this.width = width;
    this.height = height;
    this._p = `/worlds/${q(worldId)}/environments/${q(envId)}`;
  }

  static _fromGrant(client, worldId, grant) {
    const t = grant.token ? client._t.withToken(grant.token) : client._t;
    return new Environment(t, worldId, grant.id, { token: grant.token ?? null, grant, owner: client });
  }

  /** An agent's handle from an actor token alone (`cwa_<world>_<secret>`). */
  static connect(token, envId, { worldId, baseUrl, ...opts } = {}) {
    if (!worldId) {
      if (!token.startsWith('cwa_') || token.split('_').length < 3) throw new Error('pass worldId: the token does not name its world');
      worldId = token.slice(4, token.lastIndexOf('_'));
    }
    const t = new Transport(baseUrl ?? env('COMPUTERWORLD_API_BASE') ?? DEFAULT_BASE_URL, token, opts);
    return new Environment(t, worldId, envId, { token });
  }

  get config() {
    return this.grant.config ?? {};
  }

  /** Send up to 64 actions in order. An action outside the grant is an unsuccessful outcome. */
  step(actions) {
    return this._t.json('POST', `${this._p}/step`, { actions: Array.isArray(actions) ? actions : [actions] });
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
  async info() {
    return (this.grant = await this._t.json('GET', this._p));
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
  /** One grounded gesture through this environment (an owner call: needs the API key). */
  perform(gesture) {
    if (!this._owner?._t.token) throw new ComputerWorldError('perform is an owner call; this handle has only an actor token');
    return new World(this._owner, { id: this.worldId }).perform(this.id, gesture, { width: this.width, height: this.height });
  }
}

/** A society running over the API. */
export class Swarm {
  constructor(client, info) {
    this._c = client;
    this.info = info;
    this.id = info.id;
    this._p = `/swarms/${q(this.id)}`;
  }
  async refresh() {
    return (this.info = await this._c._get(this._p));
  }
  delete() {
    return this._c._delete(this._p);
  }
  [Symbol.asyncDispose ?? Symbol.for('Symbol.asyncDispose')]() {
    return this.delete();
  }
  /** Run rounds in every arm; `pending` lists LLM decisions the journal lacks. */
  runRounds(count = 1, { askModel, arms } = {}) {
    return this._c._post(`${this._p}/rounds`, dropUndefined({ count, ask_model: askModel || undefined, arms }));
  }
  async fork() {
    return (this.info = await this._c._post(`${this._p}/fork`));
  }
  async journal() {
    return ndjson(await (await this._c._t.request('GET', `${this._p}/journal`)).text());
  }
  /** Answers for pending decisions: `[{ key, reply }]`. */
  addJournal(entries) {
    return this._c._post(`${this._p}/journal`, { entries });
  }
  async trace({ arm, since } = {}) {
    return ndjson(await (await this._c._t.request('GET', `${this._p}/trace`, { params: { arm, since } })).text());
  }
  summary() {
    return this._c._get(`${this._p}/summary`);
  }
}
