# computerworld-cloud (Python)

A small client for the hosted ComputerWorld API at `https://computerworld.pages.dev/v1`.
Standard library only, Python 3.9 or later, typed (`py.typed`). The contract is
[`openapi.yaml`](https://computerworld.pages.dev/openapi.yaml); the guide is
[the hosted API docs](https://computerworld.pages.dev/docs/cloud-api), and [the clients guide](https://computerworld.pages.dev/docs/cloud-clients)
covers this client and the [JavaScript one](https://github.com/ComputaCo/computerworld) together.
Get an API key at <https://computerworld.pages.dev/console/create-account.html>.

## Install

It is not on PyPI. Install it from this repository:

```sh
pip install "computerworld-cloud @ git+https://github.com/ComputaCo/computerworld.git#subdirectory=python"
# a tag or commit:  ...computerworld.git@<ref>#subdirectory=python
# from a checkout:  pip install .
```

## Use

```python
from computerworld_cloud import Client

client = Client()   # COMPUTERWORLD_API_KEY and COMPUTERWORLD_API_BASE, or Client("cw_live_…", base_url=...)

with client.create_world("agent-desktop", seed=1) as world:      # deleted at the end of the block
    env = world.environment()                                    # holds the actor token
    env.click(interaction="shell:launch:editor")                 # find in the scene, click its centre
    env.click(role="textbox", label="Document text")
    env.type_text("Hello")
    env.render().save("screen.png")                              # PNG bytes, with .etag .state_hash .tick

    fork = world.fork()                                          # same state hash, new tokens
    run = fork.run("agent-desktop/legal-engagement", seed=1)
    print(run["verification"]["passed"], fork.state_hash())
    fork.delete()
```

The names follow the local `computerworld` package, so code moves between a local
`World` and a hosted one with few changes:

| Local (`computerworld`) | Hosted (`computerworld_cloud`) |
|---|---|
| `World(definition, seed)` | `client.create_world("agent-desktop", seed=…)`, or `definition=`, `blueprint=` |
| `world.environment(config)` | `world.environment(config)` → `Environment` with `.token` |
| `world.session(id)` | `world.session(id)` |
| `world.snapshot()`, `restore`, `fork` | the same; snapshots are kept server-side and named by id |
| `world.export_snapshot()` / `import_snapshot` | `world.export_snapshot()` / `client.import_world(bundle)` (a new world) |
| `world.state_hash()`, `inspect()`, `definition()`, `trajectory()`, `reset(seed)` | the same |
| `world.add_computer(computer, node, links)`, `remove_computer(id)` | the same |
| `computerworld.instantiate(p, seed)`, `world.stage/project/verify` | `client.instantiate(p, seed)`, `world.stage/project/verify`, and `world.run` for all four |
| `env.step(actions)`, `observe()`, `scene(w, h)` | the same (`scene(elements=True)` adds the interactive elements) |
| `env.render(w, h)` → `{"rgba": …}` | `env.render(w, h)` → PNG bytes (`format="rgba"` for raw) |

What else is here:

- **Every route group.** `me`, `update_me`, `usage`, `list_keys`/`create_key`/`revoke_key`;
  `catalog_worlds`, `catalog_procedures`, `catalog_societies`, `vocabulary`;
  `list_blueprints`, `create_blueprint`, `update_blueprint`, `blueprint_topology`,
  `edit_blueprint_topology`, `validate`; on a `World`: `advance("30s")`, `service_state`,
  `patch_service_state`, `topology`, `snapshots`, `drop_snapshot`, `perform`, `revoke`;
  `create_swarm` / `compile_swarm` and a `Swarm` with `run_rounds`, `fork`, `journal`,
  `add_journal`, `trace`, `summary`; `Client.signup(username, password)`.
- **Finding elements.** `env.find(label=, role=, interaction=, value=, index=)` returns
  the frontmost interactive element matching every field given (a string matches exactly,
  a compiled `re` pattern by `search`); `find_all` returns all of them; a miss raises
  `ElementNotFound` naming what is on screen. `env.click(...)` takes `x, y`, an
  `element`, or the same fields; `press("Ctrl+S")` and `type_text` round it out. These
  helpers raise `ActionFailed` on an unsuccessful outcome (`check=False` to not).
  `find_elements(scene, ...)` and `center(element)` work on a scene you already hold.
- **Agents without the owner's key.** `Environment.connect(token, "env_1")` makes a handle
  from an actor token alone; it can step, observe, read the scene and render, nothing else.
- **Retries.** A 429 or 503 is retried for any method; a 500, 502, 504 or a lost
  connection only for GET, PUT and DELETE (a POST that may have changed the world is not
  sent twice). The wait is `Retry-After` when the API sends one, otherwise an exponential
  backoff from 0.5 s (jittered, at most 30 s); four retries by default (`max_retries=`),
  and a `Retry-After` over 120 s is raised at once instead of waited.
- **Errors.** `ApiError` carries `status`, `code` (the API's: `not_found`,
  `rate_limited`, `quota_exceeded`, `invalid_world`, …), `message`, `retry_after` and the
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
forks, runs `legal-engagement` in the fork, deletes both worlds and checks they are gone,
printing client-side timings.
