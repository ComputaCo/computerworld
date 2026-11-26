# computerworld-cloud (Python)

A small client for the hosted ComputerWorld API at `https://computaco.ai/v1`.
Standard library only, Python 3.9 or later, typed (`py.typed`). The contract is
[`openapi.yaml`](https://computaco.ai/openapi.yaml); the guide is
[the hosted API docs](https://computaco.ai/docs/cloud-api.html), and [the clients guide](https://computaco.ai/docs/cloud-clients.html)
covers this client and the [JavaScript one](https://github.com/ComputaCo/computerworld) together.
Get an API key at <https://computaco.ai/console/create-account.html>.

## Install

```sh
pip install computerworld-cloud
# from this repository:  pip install "computerworld-cloud @ git+https://github.com/ComputaCo/computerworld.git#subdirectory=python"
# a tag or commit:  ...computerworld.git@<ref>#subdirectory=python
# from a checkout of this repository:  pip install ./python
```

## Use

```python
from computerworld_cloud import Client

client = Client()   # COMPUTERWORLD_API_KEY and COMPUTERWORLD_API_BASE, or Client("cw_live_…", base_url=...)

with client.create_environment("agent-desktop", seed=1) as sim:  # deleted at the end of the block
    agent = sim.agent()                                          # an external agent; holds the actor token
    agent.click(interaction="shell:launch:editor")               # find in the scene, click its centre
    agent.click(role="textbox", label="Document text")
    agent.type_text("Hello")
    agent.render().save("screen.png")                            # PNG bytes, with .etag .state_hash .tick

    fork = sim.fork()                                            # same state hash, the agents under new tokens
    run = fork.run("agent-desktop/legal-engagement", seed=1)
    print(run["verification"]["passed"], fork.state_hash())
    fork.delete()
```

The names follow the engine's own Python API (`computerworld`, the local engine), so code
moves between a local world and a hosted environment with few changes:

| Local (`computerworld`) | Hosted (`computerworld_cloud`) |
|---|---|
| `World(definition, seed)` | `client.create_environment("agent-desktop", seed=…)`, or `definition=` |
| `world.environment(config)` | `sim.agent(config)` → `Agent` with `.token` |
| `world.session(id)` | `sim.get_agent(id)` |
| `world.snapshot()`, `restore`, `fork` | the same; snapshots are kept server-side and named by id |
| `world.export_snapshot()` / `import_snapshot` | `sim.export_snapshot()` / `client.import_environment(bundle)` (a new environment) |
| `world.state_hash()`, `inspect()`, `definition()`, `trajectory()`, `reset(seed)` | the same |
| `world.add_computer(computer, node, links)`, `remove_computer(id)` | the same |
| `computerworld.instantiate(p, seed)`, `world.stage/project/verify` | `client.instantiate(template, procedure_id, seed)`, `sim.stage/project/verify`, and `sim.run` for all four |
| `sim.step(actions)`, `observe()`, `scene(w, h)` | `agent.step`, `observe`, `scene` (`scene(elements=True)` adds the interactive elements) |
| `sim.render(w, h)` → `{"rgba": …}` | `agent.render(w, h)` → PNG bytes (`format="rgba"` for raw) |

Five words name everything here:

- A **template** is a world definition you start an environment from: built in, or one of
  your organization's own. `list_templates`, `get_template`, `create_template`,
  `update_template`, `delete_template`, `template_topology`, `edit_template_topology`; a
  built-in template's expert procedures (`template_procedures`, `template_procedure`,
  `instantiate`) and societies (`template_societies`, `template_society`); `vocabulary`
  and `validate`.
- An **environment** is one running world. `create_environment(template, seed=, name=,
  platform=, society=, idle_ttl=, place=)`, or `definition=` in place of a template;
  `list_environments`, `get_environment`, `import_environment(bundle, name, place=)`. `place`
  says where it runs: `"lightning"` or `"heavy"` (or a Lightning place's id: `"core"`,
  `"office"`, `"media"`), or a list tried in order; left out, Lightning first. `info["place"]`
  answers where it runs and why, `info["refused"]` the places that refused it. On an `Environment`:
  `rename`, `delete`, `read_file` / `write_file`, `clock` / `state_hash`, `advance("30s")`,
  `reset`, `inspect`, `definition`, `trajectory`, `service_state` / `patch_service_state`, `asks` / `answer_asks`,
  `topology`, `add_computer` / `remove_computer`, `snapshot` / `snapshots` / `restore` (the agents and their
  conversations become the snapshot's) / `snapshot_agents(snapshot)` / `snapshot_messages(snapshot, agent)` / `drop_snapshot` (returns `{snapshots, head}`), `snapshot_frame(snapshot, machine)`
  (the PNG of a machine's screen at a snapshot), `history` (the family's snapshots, forks and
  heads), `export_snapshot`, and the expert procedures: `stage`, `project`, `verify`, `run`.
- An **agent** acts in an environment. `sim.agent(config)` grants an external one (your code,
  Computatrum) and returns an `Agent` holding its actor token. `sim.agents()` lists every
  agent: the external ones and, with a society, its simulated people (`kind: "simulated"`,
  no token). `sim.get_agent(id)` and `sim.revoke(agent)`; `sim.connect_agent(agent, machine)`
  and `sim.disconnect_agent(agent, machine)` connect it to a machine and disconnect it (it
  keeps its id, token and thread); `sim.perform(agent, gesture)`
  does one grounded gesture.
- A **society** is the simulated people of an environment, chosen when it boots
  (`create_environment("company-2026", society={"id": "rumor-cascade", "journal": "builtin"})`).
  `sim.society` has `info`, `run_rounds(count, ask_model=)`, `journal` / `add_journal`,
  `trace(since=)` and `summary`.
- A **fork** is an environment copied from another as it is now: `sim.fork(name=,
  snapshot=, society_ops=, place=)`; left to itself it runs where its parent does. Its `info["forked_from"]` names the parent and the parent's `forks()`
  lists them; each fork runs its own society rounds, and `society.summary()` on the parent
  compares the outcomes per round of every fork.

What else is here:

- **Accounts.** `me`, `update_me`, `set_email` / `verify_email`, `usage`, `list_keys` / `create_key(name, scopes=)` /
  `revoke_key`, `Client.signup(username, password, scopes=)` (makes the account, then one
  key with its session; returns `(client, user, key)`), and the agent models on OpenAI's
  paths (`models`, `chat`). A key's `scopes` are any of `environments`, `templates`,
  `models`, `account` and `research`, every one when left out.
- **Finding elements.** `agent.find(label=, role=, interaction=, value=, index=)` returns
  the frontmost interactive element matching every field given (a string matches exactly,
  a compiled `re` pattern by `search`); `find_all` returns all of them; a miss raises
  `ElementNotFound` naming what is on screen. `agent.click(...)` takes `x, y`, an
  `element`, or the same fields; `press("Ctrl+S")` and `type_text` round it out. These
  helpers raise `ActionFailed` on an unsuccessful outcome (`check=False` to not).
  `find_elements(scene, ...)` and `center(element)` work on a scene you already hold.
- **Agents without the owner's key.** `Agent.connect(token, environment_id, agent_id)` makes a handle
  from an actor token alone; it can step, observe, read the scene and render, nothing else.
- **Retries.** A 429, or a 503 with `Retry-After`, is retried for any method; a 500, 502, 504, a 503
  without `Retry-After` (a failure on our side) or a lost connection only for GET, PUT and DELETE (a POST that may have changed the environment is not
  sent twice). The wait is `Retry-After` when the API sends one, otherwise an exponential
  backoff from 0.5 s (jittered, at most 30 s); four retries by default (`max_retries=`),
  and a `Retry-After` over 120 s is raised at once instead of waited.
- **Errors.** `ApiError` carries `status`, `code` (the API's: `not_found`,
  `rate_limited`, `quota_exceeded`, `invalid_definition`, …), `message`, `retry_after` and the
  method and path. Subclasses by status: `AuthenticationError`, `PermissionDeniedError`,
  `NotFoundError`, `ConflictError`, `RateLimitError`, `ServerError`. An answer that is not
  the API's JSON (a Cloudflare page) is `http_<status>`.
- **User-Agent.** Every request sends `computerworld-cloud-python/<version>` (with your
  `user_agent=` in front of it). Cloudflare refuses Python's `urllib` default with
  `403 error code: 1010`; that is why a stdlib client has to set one.
- **Connections** are kept alive per thread (`http.client`), so a run of steps does not
  pay a TLS handshake each.

## Test

```sh
python -m unittest discover -s tests -v                 # offline, against a local mock (tests/mock_server.py)
COMPUTERWORLD_API_KEY=cw_live_… python -m unittest tests/test_live.py -v
```

The live test boots `agent-desktop`, clicks the editor's launcher, types, renders a PNG,
forks, runs `legal-engagement` in the fork, deletes both environments and checks they are gone,
printing client-side timings.
