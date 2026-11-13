# ComputerWorld clients

A small client for the hosted ComputerWorld API at `https://computaco.ai/v1`.
One ES module with no dependencies, for Node 18 or later and browsers, with TypeScript
declarations beside it. The contract is [`openapi.yaml`](https://computaco.ai/openapi.yaml); the
guide is [the hosted API docs](https://computaco.ai/docs/cloud-api.html), and
[the clients guide](https://computaco.ai/docs/cloud-clients.html) covers this client and the [Python one](https://github.com/ComputaCo/computerworld/tree/main/python) together.
Get an API key at <https://computaco.ai/console/create-account.html>.

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

## The engine's source

This repository is the clients of the hosted API and the home of the engine's release assets
(`engine-v0.3.0`). The engine's open-core source — the simulator, the SDK and module ABI, the
application catalog, the fidelity tooling — is
[ComputaCo/computerworld-engine](https://github.com/ComputaCo/computerworld-engine), MIT.

## Use

```js
import { Client } from 'computerworld-cloud';

const client = new Client(); // COMPUTERWORLD_API_KEY / COMPUTERWORLD_API_BASE, or new Client('cw_live_…', { baseUrl })

const simulation = await client.createSimulation('agent-desktop', { seed: 1 });
try {
  const agent = await simulation.agent();                    // an external agent; holds the actor token
  await agent.click({ interaction: 'shell:launch:editor' });  // find in the scene, click its centre
  await agent.click({ role: 'textbox', label: 'Document text' });
  await agent.typeText('Hello');
  const frame = await agent.render();                         // { bytes: Uint8Array (PNG), etag, stateHash, tick, ... }

  const fork = await simulation.fork();                      // same state hash, the agents under new tokens
  const run = await fork.run('agent-desktop/legal-engagement', { seed: 1 });
  console.log(run.verification.passed, await fork.stateHash());
  await fork.delete();
} finally {
  await simulation.delete();
}
```

Five words name everything here:

- A **template** is a world definition you start a simulation from: built in, or one of
  your organization's own. `listTemplates`, `getTemplate`, `createTemplate`,
  `updateTemplate`, `deleteTemplate`, `templateTopology`, `editTemplateTopology`; a
  built-in template's expert procedures (`templateProcedures`, `templateProcedure`,
  `instantiate`) and societies (`templateSocieties`, `templateSociety`); `vocabulary` and
  `validate`.
- An **simulation** is one running world. `createSimulation(template, { seed, name, platform,
  society, idleTtl, place })`, or `{ definition }` in place of a template; `listSimulations`,
  `getSimulation`, `importSimulation(bundle, name, { place })`. `place` says where it runs:
  a place's id (`'core'`, `'office'`, `'media'`, `'container'`), `'do'` or `'container'`, or a
  list tried in order; left out, a Durable Object first. `info.place` answers where it runs
  and why, `info.refused` the places that refused it. On an `Simulation`: `rename`, `delete`,
  `readFile` / `writeFile`, `clock` / `stateHash`, `advance('30s')`, `reset`, `inspect`,
  `definition`, `trajectory`, `serviceState` / `patchServiceState`, `topology`,
  `addComputer` / `removeComputer`, `snapshot` / `snapshots` / `restore` (the agents and their conversations become the snapshot's) /
  `snapshotAgents(snapshot)` / `snapshotMessages(snapshot, agent)` (what a snapshot kept) /
  `dropSnapshot` (resolves to `{ snapshots, head }`), `snapshotFrame(snapshot, machine)` (the
  PNG of a machine's screen at a snapshot), `history` (the family's snapshots, forks and
  heads), `exportSnapshot`, and the expert procedures: `stage`, `project`, `verify`, `run`.
- An **agent** acts in a simulation. `simulation.agent(config)` makes an external one (your
  code, Computatrum) and returns an `Agent` holding its actor token, with `step`, `observe`,
  `scene` and `render` (PNG bytes; `format: 'rgba'` for raw). `simulation.agents()` lists
  every agent: the external ones and, with a society, its simulated people (`kind:
  'simulated'`, no token). `simulation.getAgent(id)` and `simulation.revoke(agent)`;
  `simulation.connectAgent(agent, machine)` and `disconnectAgent(agent, machine)` connect it
  to a machine and disconnect it (it keeps its id, token and thread);
  `simulation.perform(agent, gesture)` does one grounded gesture.
- A **society** is the simulated people of a simulation, chosen when it boots
  (`createSimulation('company-2026', { society: { id: 'rumor-cascade', journal: 'builtin' } })`).
  `simulation.society` has `info`, `runRounds(count, { askModel })`, `journal` /
  `addJournal`, `trace({ since })` and `summary`.
- A **fork** is a simulation copied from another as it is now: `simulation.fork({ name,
  snapshot, societyOps, place })`; left to itself it runs where its parent does. Its `info.forked_from` names the parent and the parent's `forks()` lists
  them; each fork runs its own society rounds, and `society.summary()` on the parent
  compares the outcomes per round of every fork.

What else is here:

- **Accounts.** `me`, `updateMe`, `setEmail` / `verifyEmail`, `usage`, `listKeys` / `createKey(name, { scopes })` /
  `revokeKey`, `Client.signup(username, password, { scopes })` (makes the account, then one
  key with its session; resolves to `{ client, user, key }`), and the agent models on
  OpenAI's paths (`models`, `chat`). A key's `scopes` are any of `simulations`,
  `templates`, `models`, `account` and `research`, every one when left out.
- **Finding elements.** `agent.find({ label, role, interaction, value, index })` resolves to
  the frontmost interactive element matching every field given (a string matches exactly,
  a `RegExp` by `test`); `findAll` to all of them; a miss throws `ElementNotFound` naming
  what is on screen. `agent.click({...})` takes `x, y`, an `element`, or the same fields;
  `press('Ctrl+S')` and `typeText` round it out. These helpers throw `ActionFailed` on an
  unsuccessful outcome (`check: false` to not). `findElements(scene, query)` and
  `center(element)` work on a scene already held.
- **Agents without the owner's key.** `Agent.connect(token, simulationId, agentId)` makes a handle
  from an actor token alone: step, observe, scene and render, nothing else.
- **Retries.** A 429 or 503 is retried for any method; a 500, 502, 504 or a network
  failure only for GET, PUT and DELETE (a POST that may have changed the simulation is not
  sent twice). The wait is `Retry-After` when the API sends one, otherwise an exponential
  backoff from 500 ms (jittered, at most 30 s); four retries by default (`maxRetries`), and
  a `Retry-After` over 120 s is thrown at once instead of waited.
- **Errors.** `ApiError` carries `status`, `code` (the API's: `not_found`,
  `rate_limited`, `quota_exceeded`, `invalid_definition`, …), `detail` (its message),
  `retryAfter`, `method` and `path`; an answer that is not the API's JSON is
  `http_<status>`. A request that gets no answer is `ConnectionFailed`.
- **User-Agent.** In Node (and Bun and Deno) every request sends
  `computerworld-cloud-js/<version>`, with your `userAgent` in front. A browser sends its
  own: a cross-origin `fetch` may not set `User-Agent`, and Cloudflare accepts browsers'.
- **Cleanup.** `Simulation` implements `Symbol.asyncDispose`, so where `await using` is
  available, `await using simulation = await client.createSimulation(...)` deletes the
  simulation at the end of the block.

## Test

```sh
npm test                                          # offline, against a local mock (test/mock-server.mjs)
COMPUTERWORLD_API_KEY=cw_live_… npm run test:live
npm run typecheck                                 # tsc over test/types.check.mts (needs typescript)
```

The live test boots `agent-desktop`, clicks the editor's launcher, types, renders a PNG,
forks, runs `legal-engagement` in the fork, deletes both simulations and checks they are gone,
printing client-side timings.
