# ComputerWorld clients

A small client for the hosted ComputerWorld API at `https://computerworld.pages.dev/v1`.
One ES module with no dependencies, for Node 18 or later and browsers, with TypeScript
declarations beside it. The contract is [`openapi.yaml`](https://computerworld.pages.dev/openapi.yaml); the
guide is [the hosted API docs](https://computerworld.pages.dev/docs/cloud-api), and
[the clients guide](https://computerworld.pages.dev/docs/cloud-clients) covers this client and the [Python one](https://github.com/ComputaCo/computerworld/tree/main/python) together.
Get an API key at <https://computerworld.pages.dev/console/create-account.html>.

## Install

It is not on npm. Install it from this repository, or take the one file,
`computerworld-cloud.mjs`, in whichever way suits:

```js
// From a URL (browsers, Deno; pin a tag or commit instead of main for anything lasting):
import { Client } from 'https://cdn.jsdelivr.net/gh/ComputaCo/computerworld@main/computerworld-cloud.mjs';
```

```sh
# Into a Node project, straight from GitHub:
npm install github:ComputaCo/computerworld        # then: import { Client } from 'computerworld-cloud'
# Or copy computerworld-cloud.mjs (and computerworld-cloud.d.mts for types) into your project.
```

## Python

```sh
pip install "computerworld-cloud @ git+https://github.com/ComputaCo/computerworld.git#subdirectory=python"
```

See [python/README.md](python/README.md).

## Use

```js
import { Client } from 'computerworld-cloud';

const client = new Client(); // COMPUTERWORLD_API_KEY / COMPUTERWORLD_API_BASE, or new Client('cw_live_…', { baseUrl })

const world = await client.createWorld('agent-desktop', { seed: 1 });
try {
  const env = await world.environment();                    // holds the actor token
  await env.click({ interaction: 'shell:launch:editor' });  // find in the scene, click its centre
  await env.click({ role: 'textbox', label: 'Document text' });
  await env.typeText('Hello');
  const frame = await env.render();                         // { bytes: Uint8Array (PNG), etag, stateHash, tick, ... }

  const fork = await world.fork();                          // same state hash, new tokens
  const run = await fork.run('agent-desktop/legal-engagement', { seed: 1 });
  console.log(run.verification.passed, await fork.stateHash());
  await fork.delete();
} finally {
  await world.delete();
}
```

The names follow the engine's JavaScript and Python API, in camelCase:
`createWorld` (for `new World(definition, seed)`), `world.environment(config)`,
`session(id)`, `snapshot`, `restore`, `fork`, `exportSnapshot` / `client.importWorld`,
`stateHash`, `inspect`, `definition`, `trajectory`, `reset`, `addComputer`,
`removeComputer`, `client.instantiate`, `world.stage` / `project` / `verify` / `run`;
and on an `Environment`, `step`, `observe`, `scene` and `render` (PNG bytes; `format: 'rgba'`
for raw).

What else is here:

- **Every route group.** `me`, `updateMe`, `usage`, `listKeys` / `createKey` / `revokeKey`;
  `catalogWorlds`, `catalogProcedures`, `catalogSocieties`, `vocabulary`; `listBlueprints`,
  `createBlueprint`, `updateBlueprint`, `blueprintTopology`, `editBlueprintTopology`,
  `validate`; on a `World`: `advance('30s')`, `serviceState`, `patchServiceState`,
  `topology`, `snapshots`, `dropSnapshot`, `perform`, `revoke`; `createSwarm` /
  `compileSwarm` and a `Swarm` with `runRounds`, `fork`, `journal`, `addJournal`, `trace`,
  `summary`; `Client.signup(username, password)`.
- **Finding elements.** `env.find({ label, role, interaction, value, index })` resolves to
  the frontmost interactive element matching every field given (a string matches exactly,
  a `RegExp` by `test`); `findAll` to all of them; a miss throws `ElementNotFound` naming
  what is on screen. `env.click({...})` takes `x, y`, an `element`, or the same fields;
  `press('Ctrl+S')` and `typeText` round it out. These helpers throw `ActionFailed` on an
  unsuccessful outcome (`check: false` to not). `findElements(scene, query)` and
  `center(element)` work on a scene already held.
- **Agents without the owner's key.** `Environment.connect(token, 'env_1')` makes a handle
  from an actor token alone: step, observe, scene and render, nothing else.
- **Retries.** A 429 or 503 is retried for any method; a 500, 502, 504 or a network
  failure only for GET, PUT and DELETE (a POST that may have changed the world is not sent
  twice). The wait is `Retry-After` when the API sends one, otherwise an exponential
  backoff from 500 ms (jittered, at most 30 s); four retries by default (`maxRetries`), and
  a `Retry-After` over 120 s is thrown at once instead of waited.
- **Errors.** `ApiError` carries `status`, `code` (the API's: `not_found`,
  `rate_limited`, `quota_exceeded`, `invalid_world`, …), `detail` (its message),
  `retryAfter`, `method` and `path`; an answer that is not the API's JSON is
  `http_<status>`. A request that gets no answer is `ConnectionFailed`.
- **User-Agent.** In Node (and Bun and Deno) every request sends
  `computerworld-cloud-js/<version>`, with your `userAgent` in front. A browser sends its
  own: a cross-origin `fetch` may not set `User-Agent`, and Cloudflare accepts browsers'.
- **Cleanup.** `World` and `Swarm` implement `Symbol.asyncDispose`, so where
  `await using` is available, `await using world = await client.createWorld(...)` deletes
  the world at the end of the block.

## Test

```sh
npm test                                          # offline, against a local mock (test/mock-server.mjs)
COMPUTERWORLD_API_KEY=cw_live_… npm run test:live
npm run typecheck                                 # tsc over test/types.check.mts (needs typescript)
```

The live test boots `agent-desktop`, clicks the editor's launcher, types, renders a PNG,
forks, runs `legal-engagement` in the fork, deletes both worlds and checks they are gone,
printing client-side timings.
