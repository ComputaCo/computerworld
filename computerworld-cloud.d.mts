// Types for computerworld-cloud.mjs. The wire shapes are cloud/openapi.yaml's; fields the
// contract leaves open are typed loosely (`Json`) rather than guessed.

export type Json = Record<string, any>;

export declare const VERSION: string;
export declare const DEFAULT_BASE_URL: string;
export declare const USER_AGENT: string;

export declare class ComputerWorldError extends Error {}
export declare class ApiError extends ComputerWorldError {
  /** The HTTP status. */
  status: number;
  /** The API's error code (`not_found`, `rate_limited`, `invalid_world`, ...), or `http_<status>`. */
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

export interface WorldInfo extends Clock {
  id: string;
  name?: string;
  source?: string;
  definition_id?: string;
  seed?: number;
  created_at?: number;
  machines?: string[];
  environments?: number | EnvironmentGrant[];
  snapshots?: number;
  boot_ms?: number;
  memory?: { wasm_bytes: number };
  [k: string]: any;
}

export interface EnvironmentConfig {
  actor?: string;
  machines?: string[];
  actions?: string[];
  observations?: string[];
  action_budget?: number;
  label?: string;
  [k: string]: any;
}

export interface EnvironmentGrant {
  id: string;
  session?: string;
  label?: string;
  config?: EnvironmentConfig;
  created_at?: number;
  token_prefix?: string;
  /** The actor token, present only when the grant was just made (or carried by a fork). */
  token?: string;
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
}

export interface Gesture {
  do: string;
  target?: { role?: string; label?: string; text?: string; interaction?: string; app?: string };
  [k: string]: any;
}

/** `'world/id'`, `{ world, id }`, or a whole procedure (or society spec). */
export type Ref = string | { world: string; id: string } | Json;

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
  world: string | null;
  state_hash: string;
  timings_ms?: Json;
}

type EnvRef = string | Environment | Record<string, string | Environment>;

export declare function normalizeBaseUrl(baseUrl: string): string;
export declare function parseRetryAfter(value: string | null | undefined, now?: number): number | null;
export declare function findElements(scene: Scene, query?: ElementQuery): Element[];
export declare function findElement(scene: Scene, query?: ElementQuery & { index?: number }): Element;
export declare function center(element: Element): [number, number];

export declare class Client {
  constructor(apiKey?: string | null, options?: ClientOptions);
  readonly baseUrl: string;
  static signup(username: string, password: string, options?: ClientOptions): Promise<{ client: Client; answer: Json }>;

  health(): Promise<Json>;
  me(): Promise<Json>;
  updateMe(fields: { name?: string | null; email?: string | null; date_of_birth?: string | null }): Promise<Json>;
  usage(days?: number): Promise<Json[]>;
  listKeys(): Promise<Json[]>;
  createKey(name?: string): Promise<Json & { key: string }>;
  revokeKey(keyId: string): Promise<void>;

  catalogWorlds(): Promise<Json[]>;
  catalogWorld(name: string): Promise<Json>;
  catalogProcedures(world?: string): Promise<Json[]>;
  catalogProcedure(world: string, id: string): Promise<Json>;
  catalogSocieties(): Promise<Json[]>;
  catalogSociety(world: string, id: string): Promise<Json>;
  vocabulary(): Promise<Json>;

  listBlueprints(): Promise<Json[]>;
  createBlueprint(options: { name?: string; from?: string; definition?: Json }): Promise<Json>;
  getBlueprint(id: string): Promise<Json>;
  updateBlueprint(id: string, options: { name?: string; definition?: Json }): Promise<Json>;
  deleteBlueprint(id: string): Promise<void>;
  blueprintTopology(id: string): Promise<Json>;
  editBlueprintTopology(id: string, edits: ({ op: string } & Json)[]): Promise<Json>;
  validate(definition: Json): Promise<{ ok: boolean; errors?: string[]; machines?: number; services?: number }>;

  listWorlds(): Promise<WorldInfo[]>;
  createWorld(
    world?: string | null,
    options?: { blueprint?: string; definition?: Json; seed?: number; platform?: string; name?: string },
  ): Promise<World>;
  getWorld(id: string): Promise<World>;
  importWorld(bundle: Json, name?: string): Promise<World>;

  instantiate(procedure: Ref, seed?: number, overrides?: Json): Promise<Json>;

  compileSwarm(society: Ref, options?: { world?: string; seed?: number }): Promise<Json>;
  listSwarms(): Promise<Json[]>;
  createSwarm(
    society: Ref,
    options?: { world?: string; seed?: number; name?: string; journal?: string | { key: string; reply: string }[] },
  ): Promise<Swarm>;
  getSwarm(id: string): Promise<Swarm>;
}

export declare class World {
  readonly id: string;
  info: WorldInfo;
  refresh(): Promise<WorldInfo>;
  delete(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;

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

  snapshot(label?: string): Promise<Snapshot>;
  snapshots(): Promise<Snapshot[]>;
  restore(snapshot: string | Snapshot): Promise<Clock>;
  dropSnapshot(snapshot: string | Snapshot): Promise<void>;
  fork(snapshot?: string | Snapshot | null, name?: string): Promise<World>;
  exportSnapshot(): Promise<Json>;

  environment(config?: EnvironmentConfig): Promise<Environment>;
  environments(): Promise<EnvironmentGrant[]>;
  session(envId: string): Promise<Environment>;
  revoke(environment: string | Environment): Promise<void>;
  perform(environment: string | Environment, gesture: Gesture, options?: { width?: number; height?: number }): Promise<Json>;

  stage(instance: Json): Promise<Clock>;
  project(environment: EnvRef, instance: Json, options?: ProjectOptions): Promise<Demonstration>;
  verify(instance: Json): Promise<Verification>;
  run(
    procedure: Ref,
    options?: { seed?: number; fork?: boolean; includeSteps?: boolean; options?: ProjectOptions; overrides?: Json; environment?: EnvRef },
  ): Promise<RunResult>;
}

export interface ActOptions {
  machine?: string;
  check?: boolean;
}

export declare class Environment {
  readonly id: string;
  readonly worldId: string;
  readonly token: string | null;
  grant: EnvironmentGrant;
  readonly config: EnvironmentConfig;
  width: number;
  height: number;
  static connect(token: string, envId: string, options?: ClientOptions & { worldId?: string }): Environment;

  step(actions: Action | Action[]): Promise<StepResult>;
  observe(): Promise<{ channels: Json; tick: number }>;
  scene(options?: { width?: number; height?: number; elements?: boolean }): Promise<Scene>;
  render(options?: { width?: number; height?: number; format?: 'png' | 'rgba'; ifNoneMatch?: string }): Promise<Frame | null>;
  info(): Promise<EnvironmentGrant>;

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

export declare class Swarm {
  readonly id: string;
  info: Json;
  refresh(): Promise<Json>;
  delete(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  runRounds(count?: number, options?: { askModel?: boolean; arms?: string[] }): Promise<Json>;
  fork(): Promise<Json>;
  journal(): Promise<{ key: string; reply: string }[]>;
  addJournal(entries: { key: string; reply: string }[]): Promise<{ entries: number }>;
  trace(options?: { arm?: string; since?: number }): Promise<Json[]>;
  summary(): Promise<Json>;
}
