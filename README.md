# ComputerWorld clients

A small client for the hosted ComputerWorld API at `https://computaco.ai/v1`.
One ES module with no dependencies, for Node 18 or later and browsers, with TypeScript
declarations beside it. The contract is [`openapi.yaml`](https://computaco.ai/openapi.yaml); the
guide is [the hosted API docs](https://computaco.ai/docs/cloud-api.html), and
[the clients guide](https://computaco.ai/docs/cloud-clients.html) covers this client and the [Python one](https://github.com/ComputaCo/computerworld/tree/main/python) together.
Get an API key at <https://computaco.ai/console/create-account.html>.

## Install

```sh
npm install computerworld-cloud                    # then: import { Client } from 'computerworld-cloud'
```

Or take the one file, `computerworld-cloud.mjs`, from a URL (browsers, Deno; pin a tag or commit for anything lasting):

```js
import { Client } from 'https://cdn.jsdelivr.net/gh/ComputaCo/computerworld@main/computerworld-cloud.mjs';
```

## Python

```sh
pip install computerworld-cloud
```

See [python/README.md](python/README.md).

## The engine's source

This repository is where the clients of the hosted API are written, and the home of the engine's release assets
(`engine-v0.3.0`). The engine's open-core source — the simulator, the SDK and module ABI, the
application catalog, the fidelity tooling — is
[ComputaCo/computaco-core-public](https://github.com/ComputaCo/computaco-core-public), MIT.

## Use

```js
import { Client } from 'computerworld-cloud';

const client = new Client(); // COMPUTERWORLD_API_KEY / COMPUTERWORLD_API_BASE, or new Client('cw_live_…', { baseUrl })

const environment = await client.createEnvironment('agent-desktop', { seed: 1 });
try {
  const agent = await environment.agent();                    // an external agent; holds the actor token
  await agent.click({ interaction: 'shell:launch:editor' });  // find in the scene, click its centre
  await agent.click({ role: 'textbox', label: 'Document text' });
  await agent.typeText('Hello');
  const frame = await agent.render();                         // { bytes: Uint8Array (PNG), etag, stateHash, tick, ... }

  const fork = await environment.fork();                      // same state hash, the agents under new tokens
  const run = await fork.run('agent-desktop/legal-engagement', { seed: 1 });
  console.log(run.verification.passed, await fork.stateHash());
  await fork.delete();
} finally {
  await environment.delete();
}
```

Five words name everything here:

- A **template** is a world definition you start an environment from: built in, or one of
  your organization's own. `listTemplates`, `getTemplate`, `createTemplate`,
  `updateTemplate`, `deleteTemplate`, `templateTopology`, `editTemplateTopology`; a
  built-in template's expert procedures (`templateProcedures`, `templateProcedure`,
  `instantiate`) and societies (`templateSocieties`, `templateSociety`); `vocabulary` and
  `validate`.
- An **environment** is one running world. `createEnvironment(template, { seed, name, platform,
  society, idleTtl, place })`, or `{ definition }` in place of a template; `listEnvironments`,
  `getEnvironment`, `importEnvironment(bundle, name, { place })`. `place` says where it runs:
  `'lightning'` or `'heavy'` (or a Lightning place's id: `'core'`, `'office'`, `'media'`), or a
  list tried in order; left out, Lightning first. `info.place` answers where it runs
  and why, `info.refused` the places that refused it. On an `Environment`: `rename`, `delete`,
  `readFile` / `writeFile`, `clock` / `stateHash`, `advance('30s')`, `reset`, `inspect`,
  `definition`, `trajectory`, `serviceState` / `patchServiceState`, `asks` / `answerAsks`, `topology`,
  `addComputer` / `removeComputer`, `snapshot` / `snapshots` / `restore` (the agents and their conversations become the snapshot's) /
  `snapshotAgents(snapshot)` / `snapshotMessages(snapshot, agent)` (what a snapshot kept) /
  `dropSnapshot` (resolves to `{ snapshots, head }`), `snapshotFrame(snapshot, machine)` (the
  PNG of a machine's screen at a snapshot), `history` (the family's snapshots, forks and
  heads), `exportSnapshot`, and the expert procedures: `stage`, `project`, `verify`, `run`.
- An **agent** acts in an environment. `environment.agent(config)` makes an external one (your
  code, Computatrum) and returns an `Agent` holding its actor token, with `step`, `observe`,
  `scene` and `render` (PNG bytes; `format: 'rgba'` for raw). `environment.agents()` lists
  every agent: the external ones and, with a society, its simulated people (`kind:
  'simulated'`, no token). `environment.getAgent(id)` and `environment.revoke(agent)`;
  `environment.connectAgent(agent, machine)` and `disconnectAgent(agent, machine)` connect it
  to a machine and disconnect it (it keeps its id, token and thread);
  `environment.perform(agent, gesture)` does one grounded gesture.
- A **society** is the simulated people of an environment, chosen when it boots
  (`createEnvironment('company-2026', { society: { id: 'rumor-cascade', journal: 'builtin' } })`).
  `environment.society` has `info`, `runRounds(count, { askModel })`, `journal` /
  `addJournal`, `trace({ since })` and `summary`.
- A **fork** is an environment copied from another as it is now: `environment.fork({ name,
  snapshot, societyOps, place })`; left to itself it runs where its parent does. Its `info.forked_from` names the parent and the parent's `forks()` lists
  them; each fork runs its own society rounds, and `society.summary()` on the parent
  compares the outcomes per round of every fork.

What else is here:

- **Accounts.** `me`, `updateMe`, `setEmail` / `verifyEmail`, `usage`, `listKeys` / `createKey(name, { scopes })` /
  `revokeKey`, `Client.signup(username, password, { scopes })` (makes the account, then one
  key with its session; resolves to `{ client, user, key }`), and the agent models on
  OpenAI's paths (`models`, `chat`). A key's `scopes` are any of `environments`,
  `templates`, `models`, `account` and `research`, every one when left out.
- **Finding elements.** `agent.find({ label, role, interaction, value, index })` resolves to
  the frontmost interactive element matching every field given (a string matches exactly,
  a `RegExp` by `test`); `findAll` to all of them; a miss throws `ElementNotFound` naming
  what is on screen. `agent.click({...})` takes `x, y`, an `element`, or the same fields;
  `press('Ctrl+S')` and `typeText` round it out. These helpers throw `ActionFailed` on an
  unsuccessful outcome (`check: false` to not). `findElements(scene, query)` and
  `center(element)` work on a scene already held.
- **Agents without the owner's key.** `Agent.connect(token, environmentId, agentId)` makes a handle
  from an actor token alone: step, observe, scene and render, nothing else.
- **Retries.** A 429, or a 503 with `Retry-After`, is retried for any method; a 500, 502, 504, a 503
  without `Retry-After` (a failure on our side) or a network failure only for GET, PUT and DELETE (a POST that may have changed the environment is not
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
- **Cleanup.** `Environment` implements `Symbol.asyncDispose`, so where `await using` is
  available, `await using environment = await client.createEnvironment(...)` deletes the
  environment at the end of the block.

## Test

```sh
npm test                                          # offline, against a local mock (test/mock-server.mjs)
COMPUTERWORLD_API_KEY=cw_live_… npm run test:live
npm run typecheck                                 # tsc over test/types.check.mts (needs typescript)
```

The live test boots `agent-desktop`, clicks the editor's launcher, types, renders a PNG,
forks, runs `legal-engagement` in the fork, deletes both environments and checks they are gone,
printing client-side timings.
