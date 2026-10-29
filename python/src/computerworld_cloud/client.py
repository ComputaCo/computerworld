"""The client and the handles it returns: ``World``, ``Environment``, ``Swarm``."""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Union
from urllib.parse import quote

from ._http import Transport
from .errors import ComputerWorldError
from .scene import Matcher, center, find_element, find_elements

DEFAULT_BASE_URL = "https://computaco.ai/v1"
DEFAULT_WIDTH, DEFAULT_HEIGHT = 1280, 800

JSON = Dict[str, Any]
ProcedureLike = Union[str, Mapping[str, Any]]
_UNSET: Any = object()


def _q(segment: str) -> str:
    return quote(str(segment), safe="")


def _procedure_body(procedure: ProcedureLike) -> JSON:
    """``"world/id"``, ``{"world", "id"}`` or a whole procedure → the API's ``procedure|ref``."""
    if isinstance(procedure, str):
        world, sep, pid = procedure.partition("/")
        if not sep or not world or not pid:
            raise ValueError(f"a procedure reference is 'world/id', got {procedure!r}")
        return {"ref": {"world": world, "id": pid}}
    if "phases" in procedure:
        return {"procedure": dict(procedure)}
    if "world" in procedure and "id" in procedure:
        return {"ref": {"world": procedure["world"], "id": procedure["id"]}}
    raise ValueError("a procedure is 'world/id', {'world', 'id'}, or a procedure with phases")


def _society_body(society: ProcedureLike) -> JSON:
    if isinstance(society, str):
        world, sep, sid = society.partition("/")
        if not sep or not world or not sid:
            raise ValueError(f"a society reference is 'world/id', got {society!r}")
        return {"ref": {"world": world, "id": sid}}
    if set(society) <= {"world", "id"}:
        return {"ref": dict(society)}
    return {"spec": dict(society)}


def _drop_none(body: Mapping[str, Any]) -> JSON:
    return {k: v for k, v in body.items() if v is not None}


class Frame(bytes):
    """A rendered screen: the PNG (or RGBA) bytes, with the answer's headers as attributes."""

    etag: Optional[str]
    state_hash: Optional[str]
    tick: Optional[int]
    width: Optional[int]
    height: Optional[int]
    format: str

    def __new__(cls, data: bytes, headers: Mapping[str, str], fmt: str) -> "Frame":
        self = super().__new__(cls, data)
        self.etag = headers.get("etag")
        self.state_hash = headers.get("x-state-hash")
        self.tick = int(headers["x-tick"]) if headers.get("x-tick", "").isdigit() else None
        self.width = int(headers["x-width"]) if headers.get("x-width", "").isdigit() else None
        self.height = int(headers["x-height"]) if headers.get("x-height", "").isdigit() else None
        self.format = fmt
        return self

    def save(self, path: Union[str, "os.PathLike[str]"]) -> None:
        with open(path, "wb") as f:
            f.write(self)


class Client:
    """The owner's door to the hosted API, authenticated with an API key.

    ``api_key`` and ``base_url`` default to ``COMPUTERWORLD_API_KEY`` and
    ``COMPUTERWORLD_API_BASE``. Requests that get a 429 or a 503 are retried for any method,
    a 500, 502 or 504 only for GET, PUT and DELETE, with exponential backoff that waits as
    long as ``Retry-After`` says.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        *,
        timeout: float = 120.0,
        max_retries: int = 4,
        user_agent: Optional[str] = None,
        _transport: Optional[Transport] = None,
    ) -> None:
        if _transport is None:
            api_key = api_key if api_key is not None else os.environ.get("COMPUTERWORLD_API_KEY")
            base_url = base_url or os.environ.get("COMPUTERWORLD_API_BASE") or DEFAULT_BASE_URL
            _transport = Transport(
                base_url, api_key, timeout=timeout, max_retries=max_retries, user_agent=user_agent
            )
        self._t = _transport

    @property
    def base_url(self) -> str:
        return self._t.base_url

    def close(self) -> None:
        self._t.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"Client(base_url={self.base_url!r})"

    # -- plumbing ----------------------------------------------------------------------------

    def _json(self, method: str, path: str, body: Any = None, **kw: Any) -> Any:
        return self._t.request(method, path, json_body=body, **kw).json()

    def _get(self, path: str, **params: Any) -> Any:
        return self._json("GET", path, params=params or None)

    def _post(self, path: str, body: Any = None) -> Any:
        return self._json("POST", path, {} if body is None else body)

    def _delete(self, path: str) -> None:
        self._t.request("DELETE", path)

    # -- accounts ----------------------------------------------------------------------------

    @classmethod
    def signup(
        cls, username: str, password: str, base_url: Optional[str] = None, **kw: Any
    ) -> "tuple[Client, JSON]":
        """Make an account; return a client holding its first API key, and the answer."""
        base = base_url or os.environ.get("COMPUTERWORLD_API_BASE") or DEFAULT_BASE_URL
        t = Transport(base, None, **kw)
        answer = t.request(
            "POST", "/auth/signup", json_body={"username": username, "password": password}
        ).json()
        return cls(_transport=t.with_token(answer["api_key"]["key"])), answer

    def health(self) -> JSON:
        return self._json("GET", "/health", auth=False)

    def me(self) -> JSON:
        """The account, its quotas and its usage."""
        return self._get("/me")

    def update_me(
        self, *, name: Any = _UNSET, email: Any = _UNSET, date_of_birth: Any = _UNSET
    ) -> JSON:
        """Set profile fields; a field left out is kept, ``None`` clears it."""
        body = {
            k: v
            for k, v in (("name", name), ("email", email), ("date_of_birth", date_of_birth))
            if v is not _UNSET
        }
        if not body:
            raise ValueError("update_me needs at least one of name, email, date_of_birth")
        return self._json("PATCH", "/me", body)["user"]

    def usage(self, days: int = 30) -> List[JSON]:
        return self._get("/me/usage", days=days)["days"]

    def list_keys(self) -> List[JSON]:
        return self._get("/keys")["keys"]

    def create_key(self, name: Optional[str] = None) -> JSON:
        """A new API key; its ``key`` field is the secret, shown once."""
        return self._post("/keys", _drop_none({"name": name}))

    def revoke_key(self, key_id: str) -> None:
        self._delete(f"/keys/{_q(key_id)}")

    # -- catalog -----------------------------------------------------------------------------

    def catalog_worlds(self) -> List[JSON]:
        return self._get("/catalog/worlds")["worlds"]

    def catalog_world(self, name: str) -> JSON:
        """A built-in world's whole definition."""
        return self._get(f"/catalog/worlds/{_q(name)}")

    def catalog_procedures(self, world: Optional[str] = None) -> List[JSON]:
        return self._get("/catalog/procedures", world=world)["procedures"]

    def catalog_procedure(self, world: str, procedure_id: str) -> JSON:
        return self._get(f"/catalog/procedures/{_q(world)}/{_q(procedure_id)}")

    def catalog_societies(self) -> List[JSON]:
        return self._get("/catalog/societies")["societies"]

    def catalog_society(self, world: str, society_id: str) -> JSON:
        return self._get(f"/catalog/societies/{_q(world)}/{_q(society_id)}")

    def vocabulary(self) -> JSON:
        return self._get("/catalog/vocabulary")

    # -- blueprints --------------------------------------------------------------------------

    def list_blueprints(self) -> List[JSON]:
        return self._get("/blueprints")["blueprints"]

    def create_blueprint(
        self,
        name: Optional[str] = None,
        *,
        from_: Optional[str] = None,
        definition: Optional[JSON] = None,
    ) -> JSON:
        """From a built-in world or blueprint id (``from_``), or a ``definition``."""
        return self._post(
            "/blueprints", _drop_none({"name": name, "from": from_, "definition": definition})
        )

    def get_blueprint(self, blueprint_id: str) -> JSON:
        return self._get(f"/blueprints/{_q(blueprint_id)}")

    def update_blueprint(
        self, blueprint_id: str, *, name: Optional[str] = None, definition: Optional[JSON] = None
    ) -> JSON:
        return self._json(
            "PUT",
            f"/blueprints/{_q(blueprint_id)}",
            _drop_none({"name": name, "definition": definition}),
        )

    def delete_blueprint(self, blueprint_id: str) -> None:
        self._delete(f"/blueprints/{_q(blueprint_id)}")

    def blueprint_topology(self, blueprint_id: str) -> JSON:
        return self._get(f"/blueprints/{_q(blueprint_id)}/topology")

    def edit_blueprint_topology(self, blueprint_id: str, edits: Sequence[JSON]) -> JSON:
        """Apply ``[{op: ...}, ...]`` in order, all or nothing; return the new topology."""
        return self._json(
            "PATCH", f"/blueprints/{_q(blueprint_id)}/topology", {"edits": list(edits)}
        )

    def validate(self, definition: JSON) -> JSON:
        """Boot a definition with the engine and drop it: ``{ok, errors, machines, ...}``."""
        return self._post("/validate", {"definition": definition})

    # -- worlds ------------------------------------------------------------------------------

    def list_worlds(self) -> List[JSON]:
        return self._get("/worlds")["worlds"]

    def create_world(
        self,
        world: Optional[str] = None,
        *,
        blueprint: Optional[str] = None,
        definition: Optional[JSON] = None,
        seed: int = 1,
        platform: Optional[str] = None,
        name: Optional[str] = None,
        idle_ttl: Optional[int] = None,
    ) -> "World":
        """Boot a world from a built-in world name, a blueprint id or a definition.

        ``idle_ttl`` (seconds): the service deletes the world after that long with no request to it.
        """
        if sum(x is not None for x in (world, blueprint, definition)) != 1:
            raise ValueError("pass exactly one of world, blueprint, definition")
        body = _drop_none(
            {
                "world": world,
                "blueprint": blueprint,
                "definition": definition,
                "seed": seed,
                "platform": platform,
                "name": name,
                "idle_ttl": idle_ttl,
            }
        )
        return World(self, self._post("/worlds", body))

    # -- agent models (OpenAI's paths) ---------------------------------------------------------

    def models(self) -> List[JSON]:
        """The agent models: ``deepseek-flash`` (text and tools) and the vision model."""
        return self._get("/models")["data"]

    def chat(self, body: JSON) -> JSON:
        """OpenAI chat completions: ``chat({"model": "deepseek-flash", "messages": [...]})``."""
        return self._post("/chat/completions", body)

    def get_world(self, world_id: str) -> "World":
        return World(self, self._get(f"/worlds/{_q(world_id)}"))

    def import_world(self, bundle: JSON, name: Optional[str] = None) -> "World":
        """Boot a new world from what :meth:`World.export_snapshot` returned."""
        return World(self, self._post("/worlds/import", _drop_none({"snapshot": bundle, "name": name})))

    # -- procedures --------------------------------------------------------------------------

    def instantiate(
        self, procedure: ProcedureLike, seed: int = 1, overrides: Optional[JSON] = None
    ) -> JSON:
        """Draw an instance: ``procedure`` is ``"world/id"``, ``{world, id}`` or a procedure."""
        body = _procedure_body(procedure)
        body.update(_drop_none({"seed": seed, "overrides": overrides}))
        return self._post("/procedures/instantiate", body)

    # -- swarms ------------------------------------------------------------------------------

    def compile_swarm(
        self, society: ProcedureLike, *, world: Optional[str] = None, seed: Optional[int] = None
    ) -> JSON:
        """The plan a society compiles to; ``society`` is ``"world/id"`` or a spec."""
        body = _society_body(society)
        body.update(_drop_none({"world": world, "seed": seed}))
        return self._post("/swarms/compile", body)

    def list_swarms(self) -> List[JSON]:
        return self._get("/swarms")["swarms"]

    def create_swarm(
        self,
        society: ProcedureLike,
        *,
        world: Optional[str] = None,
        seed: Optional[int] = None,
        name: Optional[str] = None,
        journal: Union[str, Sequence[JSON], None] = None,
    ) -> "Swarm":
        """Compile and boot a society. ``journal="builtin"`` replays the recorded one."""
        body = _society_body(society)
        body.update(
            _drop_none(
                {
                    "world": world,
                    "seed": seed,
                    "name": name,
                    "journal": list(journal) if isinstance(journal, (list, tuple)) else journal,
                }
            )
        )
        return Swarm(self, self._post("/swarms", body))

    def get_swarm(self, swarm_id: str) -> "Swarm":
        return Swarm(self, self._get(f"/swarms/{_q(swarm_id)}"))


class World:
    """A running world the account owns: the hosted counterpart of ``computerworld.World``.

    Use as a context manager to delete it on exit.
    """

    def __init__(self, client: Client, info: JSON) -> None:
        self._c = client
        self.info = info
        self.id: str = info["id"]
        self._p = f"/worlds/{_q(self.id)}"
        self._handles: Dict[str, Environment] = {}
        for env in info.get("environments") or []:
            if isinstance(env, dict) and env.get("token"):
                handle = Environment._from_grant(client, self.id, env)
                self._handles[handle.id] = handle

    def __repr__(self) -> str:
        return f"World(id={self.id!r}, source={self.info.get('source')!r})"

    def __enter__(self) -> "World":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.delete()

    def refresh(self) -> JSON:
        self.info = self._c._get(self._p)
        return self.info

    def delete(self) -> None:
        """Delete the world, its snapshots and its environments."""
        self._c._delete(self._p)

    def read_file(self, path: str, *, machine: Optional[str] = None) -> JSON:
        """A file on a machine, as the owner reads it: ``{machine, path, content, base64, bytes}``."""
        return self._c._json("GET", self._p + "/files", params=_drop_none({"machine": machine, "path": path}))

    def write_file(self, path: str, data: Union[str, bytes], *, machine: Optional[str] = None) -> JSON:
        """Write a file onto a machine: text (``str``) or ``bytes``."""
        body = {"content": data} if isinstance(data, str) else {"base64": base64.b64encode(data).decode("ascii")}
        return self._c._json("PUT", self._p + "/files", body, params=_drop_none({"machine": machine, "path": path}))

    # -- clock and state ----------------------------------------------------------------------

    def state_hash(self) -> str:
        return self.clock()["state_hash"]

    def clock(self) -> JSON:
        """``{state_hash, tick}``."""
        return self._c._get(self._p + "/state_hash")

    def advance(self, duration: Union[str, int, None] = None, *, ticks: Optional[int] = None) -> JSON:
        """Move the clock: ``advance("30s")``, ``advance(ticks=1_000_000)``."""
        if isinstance(duration, int) and ticks is None:
            duration, ticks = None, duration
        if (duration is None) == (ticks is None):
            raise ValueError("pass one of duration or ticks")
        return self._c._post(self._p + "/advance", _drop_none({"duration": duration, "ticks": ticks}))

    def reset(self, seed: Optional[int] = None) -> JSON:
        """Back to the definition; environments are dropped."""
        self._handles.clear()
        return self._c._post(self._p + "/reset", _drop_none({"seed": seed}))

    def inspect(self, pointer: Optional[str] = None) -> Any:
        """The owner's view of the whole state, or the value at a JSON Pointer."""
        return self._c._get(self._p + "/inspect", pointer=pointer)

    def definition(self) -> JSON:
        return self._c._get(self._p + "/definition")

    def trajectory(self) -> JSON:
        return self._c._get(self._p + "/trajectory")

    def service_state(self, service_id: str) -> JSON:
        return self._c._get(f"{self._p}/services/{_q(service_id)}/state")

    def patch_service_state(self, service_id: str, patch: JSON) -> JSON:
        """An owner write (JSON merge patch), recorded for replay."""
        return self._c._json("PATCH", f"{self._p}/services/{_q(service_id)}/state", patch)

    # -- topology -----------------------------------------------------------------------------

    def topology(self) -> JSON:
        return self._c._get(self._p + "/topology")

    def add_computer(
        self,
        computer: JSON,
        node: Optional[JSON] = None,
        links: Optional[Sequence[JSON]] = None,
        theme: Optional[str] = None,
    ) -> JSON:
        body = _drop_none(
            {"computer": computer, "node": node, "links": list(links) if links else None, "theme": theme}
        )
        return self._c._post(self._p + "/machines", body)

    def remove_computer(self, machine_id: str) -> JSON:
        return self._c._json("DELETE", f"{self._p}/machines/{_q(machine_id)}")

    # -- snapshots ----------------------------------------------------------------------------

    def snapshot(self, label: Optional[str] = None) -> JSON:
        """Keep a snapshot; returns ``{id, state_hash, tick, bytes, ...}``."""
        return self._c._post(self._p + "/snapshots", _drop_none({"label": label}))

    def snapshots(self) -> List[JSON]:
        return self._c._get(self._p + "/snapshots")["snapshots"]

    def restore(self, snapshot: Union[str, JSON]) -> JSON:
        sid = snapshot if isinstance(snapshot, str) else snapshot["id"]
        return self._c._post(f"{self._p}/snapshots/{_q(sid)}/restore")

    def drop_snapshot(self, snapshot: Union[str, JSON]) -> None:
        sid = snapshot if isinstance(snapshot, str) else snapshot["id"]
        self._c._delete(f"{self._p}/snapshots/{_q(sid)}")

    def fork(self, snapshot: Union[str, JSON, None] = None, name: Optional[str] = None) -> "World":
        """A new world from now (or a kept snapshot), at the same state hash.

        The environments come over under new tokens: ``fork.session(env_id)``.
        """
        sid = snapshot if isinstance(snapshot, (str, type(None))) else snapshot["id"]
        return World(self._c, self._c._post(self._p + "/fork", _drop_none({"snapshot": sid, "name": name})))

    def export_snapshot(self) -> JSON:
        """A portable bundle; :meth:`Client.import_world` boots it."""
        return self._c._get(self._p + "/export")

    # -- environments -------------------------------------------------------------------------

    def environment(self, config: Optional[JSON] = None, **fields: Any) -> "Environment":
        """Grant an environment (``actor``, ``machines``, ``actions``, ``observations``,
        ``action_budget``, ``label``) and return a handle holding its actor token."""
        body = dict(config or {})
        body.update(_drop_none(fields))
        grant = self._c._post(self._p + "/environments", body)
        handle = Environment._from_grant(self._c, self.id, grant)
        self._handles[handle.id] = handle
        return handle

    def environments(self) -> List[JSON]:
        """The grants (never their tokens)."""
        return self._c._get(self._p + "/environments")["environments"]

    def session(self, env_id: str) -> "Environment":
        """A handle on an existing environment: with its actor token when this object holds
        it (it granted or forked it), otherwise acting with the owner's key."""
        if env_id in self._handles:
            return self._handles[env_id]
        grant = self._c._get(f"{self._p}/environments/{_q(env_id)}")
        return Environment._from_grant(self._c, self.id, grant)

    def revoke(self, environment: Union[str, "Environment"]) -> None:
        env_id = environment if isinstance(environment, str) else environment.id
        self._handles.pop(env_id, None)
        self._c._delete(f"{self._p}/environments/{_q(env_id)}")

    def perform(
        self,
        environment: Union[str, "Environment"],
        gesture: JSON,
        *,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> JSON:
        """One grounded gesture, ``{"do": "click", "target": {"label": "Post"}}``, found on
        the environment's screen the way a procedure finds it."""
        env_id = environment if isinstance(environment, str) else environment.id
        body: JSON = {"environment": env_id, "gesture": gesture}
        options = _drop_none({"width": width, "height": height})
        if options:
            body["options"] = options
        return self._c._post(self._p + "/perform", body)

    # -- procedures ---------------------------------------------------------------------------

    def stage(self, instance: JSON) -> JSON:
        return self._c._post(self._p + "/procedures/stage", {"instance": instance})

    def project(
        self,
        environment: Union[str, "Environment", Mapping[str, Union[str, "Environment"]]],
        instance: JSON,
        options: Optional[JSON] = None,
    ) -> JSON:
        """Perform an instance through an environment (or ``{role: environment}``)."""
        body = _drop_none(
            {"instance": instance, "environment": _env_ref(environment), "options": options}
        )
        return self._c._post(self._p + "/procedures/project", body)

    def verify(self, instance: JSON) -> JSON:
        return self._c._post(self._p + "/procedures/verify", {"instance": instance})

    def run(
        self,
        procedure: ProcedureLike,
        seed: int = 1,
        *,
        fork: bool = False,
        include_steps: bool = False,
        options: Optional[JSON] = None,
        overrides: Optional[JSON] = None,
        environment: Any = None,
    ) -> JSON:
        """Instantiate, stage, project and verify in one call. ``fork=True`` runs it in a
        throwaway copy and leaves this world as it was."""
        body = _procedure_body(procedure)
        body.update(
            _drop_none(
                {
                    "seed": seed,
                    "fork": fork,
                    "include_steps": include_steps,
                    "options": options,
                    "overrides": overrides,
                    "environment": _env_ref(environment) if environment is not None else None,
                }
            )
        )
        return self._c._post(self._p + "/procedures/run", body)


def _env_ref(environment: Any) -> Any:
    if isinstance(environment, Environment):
        return environment.id
    if isinstance(environment, Mapping):
        return {role: _env_ref(env) for role, env in environment.items()}
    return environment


class Environment:
    """An actor's environment: the hosted counterpart of ``computerworld.Environment``.

    Actor calls (``step``, ``observe``, ``scene``, ``render``) use the actor token when the
    handle has one, so a handle can be given to an agent without the owner's key. ``width``
    and ``height`` are the viewport the scene, the render and the pointer helpers use.
    """

    def __init__(
        self,
        transport: Transport,
        world_id: str,
        env_id: str,
        *,
        token: Optional[str] = None,
        grant: Optional[JSON] = None,
        owner: Optional[Client] = None,
        width: int = DEFAULT_WIDTH,
        height: int = DEFAULT_HEIGHT,
    ) -> None:
        self._t = transport
        self.world_id = world_id
        self.id = env_id
        self.token = token
        self.grant = grant or {}
        self._owner = owner
        self.width = width
        self.height = height
        self._p = f"/worlds/{_q(world_id)}/environments/{_q(env_id)}"

    @classmethod
    def _from_grant(cls, client: Client, world_id: str, grant: JSON) -> "Environment":
        token = grant.get("token")
        transport = client._t.with_token(token) if token else client._t
        return cls(transport, world_id, grant["id"], token=token, grant=grant, owner=client)

    @classmethod
    def connect(
        cls,
        token: str,
        env_id: str,
        *,
        world_id: Optional[str] = None,
        base_url: Optional[str] = None,
        **kw: Any,
    ) -> "Environment":
        """An agent's handle from an actor token alone (``cwa_<world>_<secret>``)."""
        if world_id is None:
            if not token.startswith("cwa_") or token.count("_") < 2:
                raise ValueError("pass world_id: the token does not name its world")
            world_id = token[len("cwa_") :].rsplit("_", 1)[0]
        base = base_url or os.environ.get("COMPUTERWORLD_API_BASE") or DEFAULT_BASE_URL
        return cls(Transport(base, token, **kw), world_id, env_id, token=token)

    def __repr__(self) -> str:
        return f"Environment(world_id={self.world_id!r}, id={self.id!r})"

    def close(self) -> None:
        """Close this thread's kept-alive connection (the handle stays usable)."""
        self._t.close()

    @property
    def config(self) -> JSON:
        return self.grant.get("config") or {}

    # -- the four engine calls ----------------------------------------------------------------

    def step(self, actions: Union[JSON, Iterable[JSON]], *, render: Optional[JSON] = None) -> JSON:
        """Send up to 64 actions in order: ``{outcomes, observation, state_hash, tick}``.

        An action outside the grant is an unsuccessful outcome, not an exception. ``render``
        (``{"width", "height", "if_changed"}``) adds ``frame``: the screen they left, a base64 PNG.
        """
        batch = [actions] if isinstance(actions, Mapping) else list(actions)
        body: JSON = {"actions": batch}
        if render is not None:
            body["render"] = {"width": self.width, "height": self.height, **render}
        return self._t.request("POST", self._p + "/step", json_body=body).json()

    def observe(self) -> JSON:
        return self._t.request("GET", self._p + "/observe").json()

    def scene(
        self, width: Optional[int] = None, height: Optional[int] = None, *, elements: bool = False
    ) -> JSON:
        """The scene graph; ``elements=True`` adds every interactive element, front first."""
        params = {"width": width or self.width, "height": height or self.height}
        if elements:
            params["elements"] = 1
        return self._t.request("GET", self._p + "/scene", params=params).json()

    def render(
        self,
        width: Optional[int] = None,
        height: Optional[int] = None,
        *,
        format: str = "png",
        if_none_match: Optional[str] = None,
    ) -> Optional[Frame]:
        """The screen as PNG bytes (a :class:`Frame`). With ``if_none_match`` (a previous
        frame's ``etag``), an unchanged screen returns ``None`` and is not counted."""
        params = {"width": width or self.width, "height": height or self.height, "format": format}
        headers = {"Accept": "image/png" if format == "png" else "application/octet-stream"}
        if if_none_match:
            headers["If-None-Match"] = if_none_match
        resp = self._t.request(
            "GET", self._p + "/render", params=params, headers=headers, ok=(304,)
        )
        if resp.status == 304:
            return None
        return Frame(resp.body, resp.headers, format)

    def info(self) -> JSON:
        """The grant, as the API has it now."""
        self.grant = self._t.request("GET", self._p).json()
        return self.grant

    # -- helpers ------------------------------------------------------------------------------

    def find_all(
        self,
        *,
        label: Matcher = None,
        role: Matcher = None,
        interaction: Matcher = None,
        value: Matcher = None,
        scene: Optional[JSON] = None,
    ) -> List[JSON]:
        """Elements on the screen now matching every field given (exact string, or ``re``)."""
        scene = scene or self.scene(elements=True)
        return find_elements(scene, label=label, role=role, interaction=interaction, value=value)

    def find(
        self,
        *,
        label: Matcher = None,
        role: Matcher = None,
        interaction: Matcher = None,
        value: Matcher = None,
        index: int = 0,
        scene: Optional[JSON] = None,
    ) -> JSON:
        """The frontmost match; raises :class:`ElementNotFound` naming what is on screen."""
        scene = scene or self.scene(elements=True)
        return find_element(
            scene, label=label, role=role, interaction=interaction, value=value, index=index
        )

    def click(
        self,
        x: Optional[int] = None,
        y: Optional[int] = None,
        *,
        label: Matcher = None,
        role: Matcher = None,
        interaction: Matcher = None,
        element: Optional[JSON] = None,
        index: int = 0,
        button: Optional[int] = None,
        modifiers: Optional[Sequence[str]] = None,
        double: bool = False,
        machine: Optional[str] = None,
        check: bool = True,
    ) -> JSON:
        """Click a point, an element, or the centre of the element a fresh scene finds by
        ``label``/``role``/``interaction``. With ``check`` an unsuccessful outcome raises
        :class:`ActionFailed`."""
        if x is None or y is None:
            if element is None:
                if label is None and role is None and interaction is None:
                    raise ValueError("click needs x and y, an element, or a label/role/interaction")
                element = self.find(label=label, role=role, interaction=interaction, index=index)
            x, y = center(element)
        payload: JSON = {"x": int(x), "y": int(y), "width": self.width, "height": self.height}
        if button is not None:
            payload["button"] = button
        if modifiers:
            payload["modifiers"] = list(modifiers)
        action = {"family": "pointer.v1", "op": "double_click" if double else "click", "payload": payload}
        return self._act(action, machine, check)

    def type_text(self, text: str, *, machine: Optional[str] = None, check: bool = True) -> JSON:
        return self._act({"family": "keyboard.v1", "op": "type", "payload": {"text": text}}, machine, check)

    def press(self, key: str, *, machine: Optional[str] = None, check: bool = True) -> JSON:
        """A key or chord: ``"Enter"``, ``"Ctrl+S"``."""
        return self._act({"family": "keyboard.v1", "op": "key", "payload": {"key": key}}, machine, check)

    def _act(self, action: JSON, machine: Optional[str], check: bool) -> JSON:
        if machine:
            action["machine"] = machine
        result = self.step([action])
        outcome = (result.get("outcomes") or [{}])[0]
        if check and not outcome.get("success"):
            raise ActionFailed(action, outcome)
        return result

    def perform(self, gesture: JSON) -> JSON:
        """One grounded gesture through this environment (an owner call: needs the API key)."""
        if self._owner is None or not self._owner._t.token:
            raise ComputerWorldError("perform is an owner call; this handle has only an actor token")
        return World(self._owner, {"id": self.world_id}).perform(
            self.id, gesture, width=self.width, height=self.height
        )


class ActionFailed(ComputerWorldError):
    """A helper's action came back unsuccessful."""

    def __init__(self, action: JSON, outcome: JSON) -> None:
        self.action = action
        self.outcome = outcome
        super().__init__(f"{action['family']} {action['op']} failed: {json.dumps(outcome.get('error'))}")


class Swarm:
    """A society running over the API. Use as a context manager to delete it on exit."""

    def __init__(self, client: Client, info: JSON) -> None:
        self._c = client
        self.info = info
        self.id: str = info["id"]
        self._p = f"/swarms/{_q(self.id)}"

    def __repr__(self) -> str:
        return f"Swarm(id={self.id!r}, round={self.info.get('round')!r})"

    def __enter__(self) -> "Swarm":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.delete()

    def refresh(self) -> JSON:
        self.info = self._c._get(self._p)
        return self.info

    def delete(self) -> None:
        self._c._delete(self._p)

    def run_rounds(
        self, count: int = 1, *, ask_model: bool = False, arms: Optional[Sequence[str]] = None
    ) -> JSON:
        """Run rounds in every arm; ``pending`` lists LLM decisions the journal lacks."""
        body = _drop_none({"count": count, "ask_model": ask_model or None, "arms": list(arms) if arms else None})
        return self._c._post(self._p + "/rounds", body)

    def fork(self) -> JSON:
        """Fork the arms now, before ``fork_at``."""
        self.info = self._c._post(self._p + "/fork")
        return self.info

    def journal(self) -> List[JSON]:
        return _ndjson(self._c._t.request("GET", self._p + "/journal").body)

    def add_journal(self, entries: Sequence[JSON]) -> JSON:
        """Answers for pending decisions: ``[{key, reply}]``."""
        return self._c._post(self._p + "/journal", {"entries": list(entries)})

    def trace(self, arm: Optional[str] = None, since: Optional[int] = None) -> List[JSON]:
        resp = self._c._t.request("GET", self._p + "/trace", params={"arm": arm, "since": since})
        return _ndjson(resp.body)

    def summary(self) -> JSON:
        return self._c._get(self._p + "/summary")


def _ndjson(body: bytes) -> List[JSON]:
    return [json.loads(line) for line in body.decode().splitlines() if line.strip()]
