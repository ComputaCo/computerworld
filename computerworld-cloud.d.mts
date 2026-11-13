// Types for computerworld-cloud.mjs. The wire shapes are cloud/openapi.yaml's; fields the
// contract leaves open are typed loosely (`Json`) rather than guessed.

export type Json = Record<string, any>;
/**
 * Where to run a simulation: a place's id, a kind word (`do`: the Durable Object place that
 * carries most of what the world launches; `container`), or a list of those tried in order.
 */
export type PlaceChoice = 'do' | 'container' | 'core' | 'office' | 'media' | PlaceChoice[];
/** Where a simulation runs. `reason` says why, on the simulation's own answers. */
export interface Place {
  id: string;
  /** `do` (a Durable Object, 128 MB) or `container:<size>` (a container of its own). */
  kind: string;
  memory_mb: number;
  /** True when it is counted in container-minutes. */
  metered: boolean;
  /** The application modules it carries. */
  modules: string[];
  reason?: string;
}
/** A place that refused a simulation before the one it runs in. */
export interface Refusal {
  place: string;
  code: string;
  message?: string;
}

export declare const VERSION: string;
export declare const DEFAULT_BASE_URL: string;
export declare const USER_AGENT: string;

export declare class ComputerWorldError extends Error {}
export declare class ApiError extends ComputerWorldError {
  /** The HTTP status. */
  status: number;
  /** The API's error code (`not_found`, `rate_limited`, `invalid_definition`, ...), or `http_<status>`. */
  code: string;
  /** The API's message. */
  detail: string;
  method: string;
  path: string;
  /** `Retry-After`, in seconds, when one was sent. */
  retryAfter: number | null;
  body: unknown;
}
export declare class ConnectionFailed extends ComputerWorldError {}
export declare class ElementNotFound extends ComputerWorldError {}
export declare class ActionFailed extends ComputerWorldError {
  action: Action;
  outcome: Outcome;
}

export interface TransportOptions {
  /** Per-request timeout in ms (default 120000). */
  timeout?: number;
  /** Retries of a 429/503 (any method) or a 500/502/504 or network error (GET, PUT, DELETE). Default 4. */
  maxRetries?: number;
  /** First backoff in ms (default 500), doubled each retry, jittered, capped at `maxBackoff` (30000). */
  backoff?: number;
  maxBackoff?: number;
  /** A `Retry-After` longer than this many seconds is not waited for (default 120). */
  maxRetryAfter?: number;
  /** Prepended to `computerworld-cloud-js/<version>`. */
  userAgent?: string;
  /** Send the User-Agent header (default: outside browsers only). */
  sendUserAgent?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ClientOptions extends TransportOptions {
  /** `https://host`, or `https://host/v1`. Default COMPUTERWORLD_API_BASE, else DEFAULT_BASE_URL. */
  baseUrl?: string;
}

export interface Clock {
  state_hash: string;
  tick: number;
}

export interface SimulationInfo extends Clock {
  id: string;
  name?: string;
  source?: string;
  seed?: number;
  created_at?: number;
  machines?: string[];
  /** Agents with their actor tokens, when the simulation was just made (a fork carries its parent's under new tokens). */
  agents?: number | AgentGrant[];
  snapshots?: number;
  /** The ids of the simulations forked from this one. */
  forks?: string[];
  forked_from?: string | Json | null;
  /** Where it runs; null for a recording, which nothing executes. */
  place?: Place | null;
  /** On the answer of a boot, a fork and an import: the places that refused it first. */
  refused?: Refusal[];
  /** The snapshot its state came from last. */
  head?: string | null;
  boot_ms?: number;
  memory?: { wasm_bytes: number };
  [k: string]: any;
}

export interface AgentConfig {
  actor?: string;
  machines?: string[];
  actions?: string[];
  observations?: string[];
  action_budget?: number;
  label?: string;
  [k: string]: any;
}

export type ThreadState = 'idle' | 'working' | 'stopped';

/** One message of an agent's thread; a role's own fields (a status's `status`, an action's `action`, `ok`, …) come with it. */
export interface Message {
  seq: number;
  role: 'person' | 'agent' | 'action' | 'status';
  text: string;
  /** Milliseconds since the epoch; null in a simulated agent's thread. */
  at: number | null;
  status?: 'started' | 'finished' | 'stopped' | 'failed';
  [k: string]: any;
}

/** An agent the platform runs: Computatrum's agent loop on one machine. It has no token. */
export interface HostedAgentInfo {
  id: string;
  kind: 'hosted';
  name: string;
  machine: string;
  session: string;
  config: AgentConfig & { screen: [number, number] };
  created_at: number;
  state: ThreadState;
}

export interface AgentGrant {
  id: string;
  kind?: 'external';
  state?: ThreadState;
  session?: string;
  label?: string;
  config?: AgentConfig;
  created_at?: number;
  token_prefix?: string;
  /** The actor token, present only when the agent was just granted (or carried by a fork). */
  token?: string;
}

/** One of a society's people: acts in the simulation, run by it, with no token. */
export interface SimulatedAgent {
  id: string;
  kind: 'simulated';
  name?: string;
  population?: string;
  [k: string]: any;
}

export interface TemplateInfo {
  /** A built-in's name (`company-2026`), or an own template's id. */
  id: string;
  name: string;
  source: 'builtin' | 'own';
  description?: string;
  machines?: any;
  services?: any;
  internet?: any;
  products?: any;
  procedures?: any;
  societies?: any;
  boots?: boolean;
  updated_at?: number;
  [k: string]: any;
}

/** How a simulation's society is booted: a template's society by `id`, or a whole `spec`. */
export interface SocietyChoice {
  id?: string;
  spec?: Json;
  rule?: any;
  /** `'builtin'` replays the recorded journal; or JSONL text; or `[{ key, reply }]`. */
  journal?: 'builtin' | string | JournalEntry[];
  rounds?: number;
}

export interface JournalEntry {
  key: string;
  reply: string;
}

export interface Action {
  family: string;
  op: string;
  machine?: string;
  payload?: Json;
}

export interface Outcome {
  success: boolean;
  value?: any;
  error?: Json | null;
  effect?: Json;
  index?: number;
}

export interface StepResult extends Clock {
  outcomes: Outcome[];
  /** The screen the actions left, when the step asked for `render`. */
  frame?: { png: string; width: number; height: number; state_hash: string };
  observation?: Json;
  pending?: number;
  elapsed_ms?: number;
}

export interface Element {
  role?: string;
  label?: string;
  value?: string;
  interaction?: string;
  rect?: { x: number; y: number; width: number; height: number };
  center?: [number, number];
  focused?: boolean;
  disabled?: boolean;
}

export interface Scene {
  width: number;
  height: number;
  digest?: string;
  focus?: Json;
  nodes: Json[];
  elements?: Element[];
  [k: string]: any;
}

export type Matcher = string | RegExp;

export interface ElementQuery {
  label?: Matcher;
  role?: Matcher;
  interaction?: Matcher;
  value?: Matcher;
  includeDisabled?: boolean;
}

export interface Frame {
  bytes: Uint8Array;
  etag: string | null;
  stateHash: string | null;
  tick: number | null;
  width: number | null;
  height: number | null;
  format: 'png' | 'rgba';
}

export interface Snapshot {
  id: string;
  label?: string;
  state_hash: string;
  tick: number;
  bytes?: number;
  created_at?: number;
  /** The simulation's head when it was taken; null at the simulation's start. */
  parent?: string | null;
  /** The username that took it. */
  author?: string | null;
  /** The machines a picture was kept for (`snapshotFrame`). */
  frames?: string[];
}

export interface SnapshotList {
  snapshots: Snapshot[];
  /** The snapshot the simulation's state came from last. */
  head: string | null;
}

export interface Restored extends Clock {
  head: string | null;
  elapsed_ms: number;
  /** False for a snapshot kept before snapshots held conversations: its agents come back with empty threads. */
  conversations_kept: boolean;
  /** The agents now, the snapshot's; one removed after it and back carries a new `token`, shown once. */
  agents: ((AgentGrant | HostedAgentInfo) & { token?: string })[];
}

/** One simulation of a family, as its history holds it. */
export interface HistorySimulation {
  id: string;
  name?: string;
  source?: string;
  created_at?: number;
  /** The simulation it was forked from. */
  parent: string | null;
  /** Where it left its parent. */
  origin: { snapshot: string | null; tick: number | null; state_hash: string } | null;
  head: string | null;
  place: Place | null;
  snapshots: Snapshot[];
  [k: string]: any;
}

export interface History {
  simulation: string;
  /** The family, the furthest ancestor first. */
  simulations?: HistorySimulation[];
  /** A recording's history: its steps. */
  steps?: Json[];
}

export interface Gesture {
  do: string;
  target?: { role?: string; label?: string; text?: string; interaction?: string; app?: string };
  [k: string]: any;
}

/** `'template/id'`, `{ template, id }`, or a whole procedure. */
export type ProcedureRef = string | { template: string; id: string } | Json;

export interface ProjectOptions {
  width?: number;
  height?: number;
  mode?: 'gui' | 'tool';
  typing?: 'text' | 'keys';
}

export interface Verification {
  passed: boolean;
  checks: { check: Json; passed: boolean; detail?: any }[];
}

export interface Demonstration {
  completed: boolean;
  failure?: any;
  steps?: Json[];
  verification?: Verification;
  state_hash?: string;
  counts?: Json;
}

export interface RunResult {
  instance: Json;
  demonstration: Demonstration;
  verification: Verification;
  simulation: string | null;
  state_hash: string;
  timings_ms?: Json;
}

type AgentRef = string | Agent | Record<string, string | Agent>;

export declare function normalizeBaseUrl(baseUrl: string): string;
export declare function parseRetryAfter(value: string | null | undefined, now?: number): number | null;
export declare function findElements(scene: Scene, query?: ElementQuery): Element[];
export declare function findElement(scene: Scene, query?: ElementQuery & { index?: number }): Element;
export declare function center(element: Element): [number, number];

/** What an API key may reach (docs/cloud-api.md § Authentication). */
export type Scope = 'simulations' | 'templates' | 'models' | 'account';
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  org_id: string;
  created_by: string;
  scopes: Scope[];
}

export declare class Client {
  constructor(apiKey?: string | null, options?: ClientOptions);
  readonly baseUrl: string;
  static signup(username: string, password: string, options?: ClientOptions & { keyName?: string; scopes?: Scope[] }): Promise<{ client: Client; user: Json; key: ApiKey & { key: string } }>;

  health(): Promise<Json>;
  me(): Promise<Json>;
  updateMe(fields: { name?: string | null; date_of_birth?: string | null }): Promise<Json>;
  setEmail(email: string): Promise<Json>;
  verifyEmail(code: string): Promise<Json>;
  usage(days?: number): Promise<Json[]>;
  listKeys(): Promise<ApiKey[]>;
  createKey(name?: string, options?: { scopes?: Scope[] }): Promise<ApiKey & { key: string }>;
  revokeKey(keyId: string): Promise<void>;

  listTemplates(): Promise<TemplateInfo[]>;
  getTemplate(id: string): Promise<Json>;
  createTemplate(options: { name?: string; definition: Json }): Promise<TemplateInfo>;
  updateTemplate(id: string, options: { name?: string; definition?: Json }): Promise<TemplateInfo>;
  deleteTemplate(id: string): Promise<void>;
  templateTopology(id: string): Promise<Json>;
  editTemplateTopology(id: string, edits: ({ op: string } & Json)[]): Promise<Json>;
  templateProcedures(id: string): Promise<Json[]>;
  templateProcedure(id: string, procedureId: string): Promise<Json>;
  instantiate(template: string, procedureId: string, options?: { seed?: number; overrides?: Json }): Promise<Json>;
  templateSocieties(id: string): Promise<Json[]>;
  templateSociety(id: string, societyId: string): Promise<Json>;
  vocabulary(): Promise<Json>;
  validate(definition: Json, options?: { society?: SocietyChoice }): Promise<{ ok: boolean; errors?: string[]; machines?: number; services?: number; people?: number; [k: string]: any }>;

  listSimulations(): Promise<SimulationInfo[]>;
  createSimulation(
    template: string | null,
    options?: { definition?: Json; seed?: number; name?: string; platform?: string; society?: string | SocietyChoice; idleTtl?: number; place?: PlaceChoice },
  ): Promise<Simulation>;
  getSimulation(id: string): Promise<Simulation>;
  importSimulation(bundle: Json, name?: string, options?: { place?: PlaceChoice; idleTtl?: number }): Promise<Simulation>;

  models(): Promise<Json[]>;
  chat(body: Json): Promise<Json>;
}

export declare class Simulation {
  readonly id: string;
  info: SimulationInfo;
  readonly society: Society;
  refresh(): Promise<SimulationInfo>;
  rename(name: string): Promise<SimulationInfo>;
  delete(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  readFile(path: string, options?: { machine?: string }): Promise<{ machine: string; path: string; content: string; base64: string; bytes: number }>;
  writeFile(path: string, data: string | Uint8Array, options?: { machine?: string }): Promise<Clock & { machine: string; path: string; bytes: number }>;

  stateHash(): Promise<string>;
  clock(): Promise<Clock>;
  advance(arg: string | number | { duration?: string; ticks?: number }): Promise<Clock>;
  reset(seed?: number): Promise<Clock>;
  inspect(pointer?: string): Promise<any>;
  definition(): Promise<Json>;
  trajectory(): Promise<Json>;
  serviceState(serviceId: string): Promise<Json>;
  patchServiceState(serviceId: string, patch: Json): Promise<Clock>;

  topology(): Promise<Json>;
  addComputer(computer: Json, node?: Json, links?: Json[], theme?: string): Promise<Json>;
  removeComputer(machineId: string): Promise<Json>;

  snapshot(label?: string): Promise<Snapshot & { head: string | null }>;
  snapshots(): Promise<Snapshot[]>;
  /** The agents, their connections and their threads become the snapshot's. */
  restore(snapshot: string | Snapshot): Promise<Restored>;
  /** The agents a snapshot kept, each with its state then. */
  snapshotAgents(snapshot: string | Snapshot): Promise<{ agents: (AgentGrant | HostedAgentInfo)[]; conversations_kept: boolean }>;
  /** One agent's thread as a snapshot kept it. */
  snapshotMessages(snapshot: string | Snapshot, agent: string | Agent, options?: { after?: number }): Promise<{ messages: Message[]; state: ThreadState }>;
  dropSnapshot(snapshot: string | Snapshot): Promise<SnapshotList>;
  /** The PNG of a machine's screen when the snapshot was taken. */
  snapshotFrame(snapshot: string | Snapshot, machine: string): Promise<Frame>;
  history(): Promise<History>;
  exportSnapshot(): Promise<Json>;

  fork(options?: { name?: string; snapshot?: string | Snapshot; societyOps?: Json[]; place?: PlaceChoice; idleTtl?: number }): Promise<Simulation>;
  forks(): Promise<string[]>;

  agent(config?: AgentConfig): Promise<Agent>;
  hostedAgent(machine?: string, options?: { name?: string }): Promise<Agent>;
  agents(): Promise<(AgentGrant | HostedAgentInfo | SimulatedAgent)[]>;
  person(personId: string): Agent;
  getAgent(agentId: string): Promise<Agent>;
  revoke(agent: string | Agent): Promise<void>;
  /** Connect an agent to a machine; the answer is the agent. */
  connectAgent(agent: string | Agent, machine: string): Promise<AgentGrant | HostedAgentInfo>;
  disconnectAgent(agent: string | Agent, machine: string): Promise<AgentGrant | HostedAgentInfo>;
  perform(agent: string | Agent, gesture: Gesture, options?: { width?: number; height?: number }): Promise<Json>;

  stage(instance: Json): Promise<Clock>;
  project(agent: AgentRef, instance: Json, options?: ProjectOptions): Promise<Demonstration>;
  verify(instance: Json): Promise<Verification>;
  run(
    procedure: ProcedureRef,
    options?: { seed?: number; fork?: boolean; includeSteps?: boolean; options?: ProjectOptions; overrides?: Json; agent?: AgentRef },
  ): Promise<RunResult>;
}

export interface ActOptions {
  machine?: string;
  check?: boolean;
}

export declare class Agent {
  readonly id: string;
  readonly simulationId: string;
  readonly token: string | null;
  grant: AgentGrant | HostedAgentInfo | { id: string; kind: 'simulated' };
  readonly config: AgentConfig;
  width: number;
  height: number;
  static connect(token: string, simulationId: string, agentId: string, options?: ClientOptions): Agent;

  step(actions: Action | Action[], options?: { render?: { width?: number; height?: number; ifChanged?: boolean } }): Promise<StepResult>;
  observe(): Promise<{ channels: Json; tick: number }>;
  scene(options?: { width?: number; height?: number; elements?: boolean }): Promise<Scene>;
  render(options?: { width?: number; height?: number; format?: 'png' | 'rgba'; ifNoneMatch?: string }): Promise<Frame | null>;
  info(): Promise<AgentGrant | HostedAgentInfo>;

  messages(options?: { after?: number; wait?: number }): Promise<{ messages: Message[]; state: ThreadState }>;
  prompt(text: string): Promise<{ message: Message; state: ThreadState }>;
  post(message: { role: 'agent' | 'action' | 'status'; text: string; status?: 'started' | 'finished' | 'stopped' | 'failed'; [k: string]: any }): Promise<{ message: Message; state: ThreadState }>;
  stop(): Promise<{ state: ThreadState }>;
  stream(options?: { after?: number; wait?: number; until?: (message: Message, state: ThreadState) => boolean; signal?: AbortSignal }): AsyncGenerator<Message, void, unknown>;

  findAll(query?: ElementQuery & { scene?: Scene }): Promise<Element[]>;
  find(query?: ElementQuery & { index?: number; scene?: Scene }): Promise<Element>;
  click(
    options: {
      x?: number;
      y?: number;
      element?: Element;
      label?: Matcher;
      role?: Matcher;
      interaction?: Matcher;
      index?: number;
      button?: number;
      modifiers?: string[];
      double?: boolean;
    } & ActOptions,
  ): Promise<StepResult>;
  typeText(text: string, options?: ActOptions): Promise<StepResult>;
  press(key: string, options?: ActOptions): Promise<StepResult>;
  perform(gesture: Gesture): Promise<Json>;
}

export declare class Society {
  info(): Promise<{ spec_id: string; people: number; round: number; rounds: number; metrics?: Json; [k: string]: any }>;
  runRounds(count?: number, options?: { askModel?: boolean }): Promise<Json>;
  journal(): Promise<JournalEntry[]>;
  addJournal(entries: JournalEntry[]): Promise<{ entries: number }>;
  trace(options?: { since?: number }): Promise<Json[]>;
  summary(): Promise<Json>;
}
