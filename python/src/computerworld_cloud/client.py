"""The client and the handles it returns: ``Simulation``, ``Agent``, ``Society``."""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Union
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


def _id(thing: Union[str, Mapping[str, Any], Any]) -> str:
    if isinstance(thing, str):
        return thing
    return thing["id"] if isinstance(thing, Mapping) else thing.id


def _procedure_body(procedure: ProcedureLike) -> JSON:
    """``"template/id"``, ``{"template", "id"}`` or a whole procedure → the API's ``ref|procedure``."""
    if isinstance(procedure, str):
        template, sep, pid = procedure.partition("/")
        if not sep or not template or not pid:
            raise ValueError(f"a procedure reference is 'template/id', got {procedure!r}")
        return {"ref": {"template": template, "id": pid}}
    if "phases" in procedure:
        return {"procedure": dict(procedure)}
    if "template" in procedure and "id" in procedure:
        return {"ref": {"template": procedure["template"], "id": procedure["id"]}}
    raise ValueError("a procedure is 'template/id', {'template', 'id'}, or a procedure with phases")


def _drop_none(body: Mapping[str, Any]) -> JSON:
    return {k: v for k, v in body.items() if v is not None}


def _place(place: Union[str, Sequence[str], None]) -> Union[str, List[str], None]:
    return place if place is None or isinstance(place, str) else list(place)


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
        cls,
        username: str,
        password: str,
        base_url: Optional[str] = None,
        *,
        key_name: Optional[str] = None,
        scopes: Optional[Sequence[str]] = None,
        **kw: Any,
    ) -> "tuple[Client, JSON, JSON]":
        """Make an account, then an API key with its session (every scope unless ``scopes``
        names some: simulations, templates, models, account). Return a client holding the
        key, the account, and the key as made (its ``key`` is the secret, shown once)."""
        base = base_url or os.environ.get("COMPUTERWORLD_API_BASE") or DEFAULT_BASE_URL
        t = Transport(base, None, **kw)
        resp = t.request(
            "POST", "/auth/signup", json_body={"username": username, "password": password}
        )
        cookie = resp.headers.get("set-cookie", "").split(";")[0]
        key = t.request(
            "POST",
            "/keys",
            json_body=_drop_none({"name": key_name, "scopes": None if scopes is None else list(scopes)}),
            headers={"Cookie": cookie},
        ).json()
        return cls(_transport=t.with_token(key["key"])), resp.json()["user"], key

    def health(self) -> JSON:
        return self._json("GET", "/health", auth=False)

    def me(self) -> JSON:
        """The account, its quotas and its usage."""
        return self._get("/me")

    def update_me(self, *, name: Any = _UNSET, date_of_birth: Any = _UNSET) -> JSON:
        """Set profile fields; a field left out is kept, ``None`` clears it."""
        body = {k: v for k, v in (("name", name), ("date_of_birth", date_of_birth)) if v is not _UNSET}
        if not body:
            raise ValueError("update_me needs at least one of name, date_of_birth")
        return self._json("PATCH", "/me", body)["user"]

    def set_email(self, email: str) -> JSON:
        """Set the account's e-mail address and send it a six-digit code; then ``verify_email(code)``."""
        return self._json("POST", "/me/email", {"email": email})["email"]

    def verify_email(self, code: str) -> JSON:
        """Confirm the code: ``{user, email, standing, tag}`` (the tag an academic domain gave, or None)."""
        return self._json("POST", "/me/email/verify", {"code": code})

    def usage(self, days: int = 30) -> List[JSON]:
        return self._get("/me/usage", days=days)["days"]

    def list_keys(self) -> List[JSON]:
        return self._get("/keys")["keys"]

    def create_key(self, name: Optional[str] = None, scopes: Optional[Sequence[str]] = None) -> JSON:
        """A new API key with ``scopes`` (default every one: simulations, templates, models,
        account); its ``key`` field is the secret, shown once."""
        return self._post(
            "/keys", _drop_none({"name": name, "scopes": None if scopes is None else list(scopes)})
        )

    def revoke_key(self, key_id: str) -> None:
        self._delete(f"/keys/{_q(key_id)}")

    # -- templates ---------------------------------------------------------------------------

    def list_templates(self) -> List[JSON]:
        """The built-in templates and the organization's own, one list (``source``: ``builtin`` | ``own``)."""
        return self._get("/templates")["templates"]

    def get_template(self, template_id: str) -> JSON:
        """A template's definition."""
        return self._get(f"/templates/{_q(template_id)}")

    def create_template(self, definition: JSON, *, name: Optional[str] = None) -> JSON:
        """Save a definition as one of the organization's templates."""
        return self._post("/templates", _drop_none({"name": name, "definition": definition}))

    def update_template(
        self, template_id: str, *, name: Optional[str] = None, definition: Optional[JSON] = None
    ) -> JSON:
        return self._json(
            "PUT", f"/templates/{_q(template_id)}", _drop_none({"name": name, "definition": definition})
        )

    def delete_template(self, template_id: str) -> None:
        self._delete(f"/templates/{_q(template_id)}")

    def template_topology(self, template_id: str) -> JSON:
        return self._get(f"/templates/{_q(template_id)}/topology")

    def edit_template_topology(self, template_id: str, edits: Sequence[JSON]) -> JSON:
        """Apply ``[{op: ...}, ...]`` in order, all or nothing; return the new topology."""
        return self._post(f"/templates/{_q(template_id)}/topology", {"edits": list(edits)})

    def template_procedures(self, template_id: str) -> List[JSON]:
        return self._get(f"/templates/{_q(template_id)}/procedures")["procedures"]

    def template_procedure(self, template_id: str, procedure_id: str) -> JSON:
        return self._get(f"/templates/{_q(template_id)}/procedures/{_q(procedure_id)}")

    def instantiate(
        self, template_id: str, procedure_id: str, seed: int = 1, overrides: Optional[JSON] = None
    ) -> JSON:
        """Draw an instance of a template's procedure."""
        return self._post(
            f"/templates/{_q(template_id)}/procedures/{_q(procedure_id)}/instantiate",
            _drop_none({"seed": seed, "overrides": overrides}),
        )

    def template_societies(self, template_id: str) -> List[JSON]:
        return self._get(f"/templates/{_q(template_id)}/societies")["societies"]

    def template_society(self, template_id: str, society_id: str) -> JSON:
        return self._get(f"/templates/{_q(template_id)}/societies/{_q(society_id)}")

    def vocabulary(self) -> JSON:
        return self._get("/vocabulary")

    def validate(self, definition: JSON, *, society: Optional[JSON] = None) -> JSON:
        """Boot a definition with the engine and drop it: ``{ok, errors, machines, ...}``; with
        ``society``, also the number of people it compiles to."""
        return self._post("/validate", _drop_none({"definition": definition, "society": society}))

    # -- simulations ------------------------------------------------------------------------

    def list_simulations(self) -> List[JSON]:
        return self._get("/simulations")["simulations"]

    def create_simulation(
        self,
        template: Optional[str] = None,
        *,
        definition: Optional[JSON] = None,
        seed: int = 1,
        name: Optional[str] = None,
        platform: Optional[str] = None,
        society: Union[str, JSON, None] = None,
        idle_ttl: Optional[int] = None,
        place: Union[str, Sequence[str], None] = None,
    ) -> "Simulation":
        """Boot a simulation from a template id or a definition.

        ``society`` (``{"id" | "spec", "rule", "journal", "rounds"}``, or a template's society
        id) adds simulated agents; ``"journal": "builtin"`` replays the recorded decisions.
        ``idle_ttl`` (seconds): the service deletes the simulation after that long with no
        request to it. ``place``: where it runs, a place's id (``"core"``, ``"office"``,
        ``"media"``, ``"container"``), ``"do"`` or ``"container"``, or a list of those tried in
        order; left out, a Durable Object first, and a container only for a stated reason.
        ``info["place"]`` says where it runs and why, ``info["refused"]`` the places that
        refused it.
        """
        if (template is None) == (definition is None):
            raise ValueError("pass exactly one of template, definition")
        body = _drop_none(
            {
                "template": template,
                "definition": definition,
                "seed": seed,
                "name": name,
                "platform": platform,
                "society": {"id": society} if isinstance(society, str) else society,
                "idle_ttl": idle_ttl,
                "place": _place(place),
            }
        )
        return Simulation(self, self._post("/simulations", body))

    def get_simulation(self, simulation_id: str) -> "Simulation":
        return Simulation(self, self._get(f"/simulations/{_q(simulation_id)}"))

    def import_simulation(
        self,
        bundle: JSON,
        name: Optional[str] = None,
        *,
        place: Union[str, Sequence[str], None] = None,
        idle_ttl: Optional[int] = None,
    ) -> "Simulation":
        """Boot a new simulation from what :meth:`Simulation.export_snapshot` returned;
        ``place`` is as for :meth:`create_simulation`."""
        body = _drop_none({"snapshot": bundle, "name": name, "place": _place(place), "idle_ttl": idle_ttl})
        return Simulation(self, self._post("/simulations/import", body))

    # -- agent models (OpenAI's paths) ---------------------------------------------------------

    def models(self) -> List[JSON]:
        """The agent models: ``deepseek-flash`` (text and tools) and the vision model."""
        return self._get("/models")["data"]

    def chat(self, body: JSON) -> JSON:
        """OpenAI chat completions: ``chat({"model": "deepseek-flash", "messages": [...]})``."""
        return self._post("/chat/completions", body)


class Simulation:
    """A running simulation the organization owns: one world with its clock, machines,
    snapshots, agents and forks. Use as a context manager to delete it on exit.
    """

    def __init__(self, client: Client, info: JSON) -> None:
        self._c = client
        self.info = info
        self.id: str = info["id"]
        self._p = f"/simulations/{_q(self.id)}"
        self._agents: Dict[str, Agent] = {}
        for grant in info.get("agents") or []:
            if isinstance(grant, dict) and grant.get("token"):
                agent = Agent._from_grant(client, self.id, grant)
                self._agents[agent.id] = agent
        self.society = Society(client, self._p)

    def __repr__(self) -> str:
        return f"Simulation(id={self.id!r}, source={self.info.get('source')!r})"

    def __enter__(self) -> "Simulation":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.delete()

    def refresh(self) -> JSON:
        self.info = self._c._get(self._p)
        return self.info

    def rename(self, name: str) -> JSON:
        self.info = self._c._json("PATCH", self._p, {"name": name})
        return self.info

    def delete(self) -> None:
        """Delete the simulation, its snapshots and its agents."""
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
        """Back to the definition; external agents are dropped."""
        self._agents.clear()
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

    # -- snapshots and history ----------------------------------------------------------------

    def snapshot(self, label: Optional[str] = None) -> JSON:
        """Keep a snapshot; returns ``{id, label, state_hash, tick, bytes, parent, author,
        frames, head, ...}``. It is the simulation's head now."""
        return self._c._post(self._p + "/snapshots", _drop_none({"label": label}))

    def snapshots(self) -> List[JSON]:
        """The kept snapshots, oldest first. :meth:`history` and :meth:`refresh` name the head."""
        return self._c._get(self._p + "/snapshots")["snapshots"]

    def restore(self, snapshot: Union[str, JSON]) -> JSON:
        """Restore a snapshot: ``{state_hash, tick, head, elapsed_ms, conversations_kept, agents}``.
        The agents, their connections and their threads become the snapshot's; an agent removed
        after it comes back with a new ``token`` in ``agents``."""
        return self._c._post(f"{self._p}/snapshots/{_q(_id(snapshot))}/restore")

    def snapshot_agents(self, snapshot: Union[str, JSON]) -> JSON:
        """The agents a snapshot kept: ``{agents, conversations_kept}``."""
        return self._c._get(f"{self._p}/snapshots/{_q(_id(snapshot))}/agents")

    def snapshot_messages(self, snapshot: Union[str, JSON], agent: Union[str, JSON, "Agent"], after: int = 0) -> JSON:
        """One agent's thread as a snapshot kept it: ``{messages, state}``, after ``after``."""
        return self._c._get(f"{self._p}/snapshots/{_q(_id(snapshot))}/agents/{_q(_id(agent))}/messages", after=int(after))

    def drop_snapshot(self, snapshot: Union[str, JSON]) -> JSON:
        """Drop a snapshot; its children hang from its parent. Returns what is left:
        ``{snapshots, head}``."""
        return self._c._json("DELETE", f"{self._p}/snapshots/{_q(_id(snapshot))}")

    def snapshot_frame(self, snapshot: Union[str, JSON], machine: str) -> Frame:
        """The PNG of a machine's screen when the snapshot was taken (a :class:`Frame`), for
        each machine the snapshot's ``frames`` names."""
        resp = self._c._t.request(
            "GET",
            f"{self._p}/snapshots/{_q(_id(snapshot))}/frames/{_q(machine)}",
            headers={"Accept": "image/png"},
        )
        return Frame(resp.body, resp.headers, "png")

    def history(self) -> JSON:
        """The family's history: ``{simulation, simulations}``, the furthest ancestor first,
        each with its place, origin, head and snapshots. No simulation is woken to answer."""
        return self._c._get(self._p + "/history")

    def export_snapshot(self) -> JSON:
        """A portable bundle; :meth:`Client.import_simulation` boots it."""
        return self._c._get(self._p + "/export")

    # -- forks --------------------------------------------------------------------------------

    def fork(
        self,
        *,
        name: Optional[str] = None,
        snapshot: Union[str, JSON, None] = None,
        society_ops: Optional[Sequence[JSON]] = None,
        place: Union[str, Sequence[str], None] = None,
        idle_ttl: Optional[int] = None,
    ) -> "Simulation":
        """A new simulation copied from this one as it is now (``forked_from`` names this one).

        A society comes over with its runner state and ``society_ops`` (an arm's rule ops)
        applied to it. External agents come over under new tokens: ``fork.get_agent(agent_id)``.
        ``snapshot`` forks from a kept snapshot. ``place`` is as for a new simulation; left
        out, the fork runs where its parent does (``"do"`` moves a container's copy to a
        Durable Object).
        """
        body = _drop_none(
            {
                "name": name,
                "snapshot": None if snapshot is None else _id(snapshot),
                "society_ops": list(society_ops) if society_ops is not None else None,
                "place": _place(place),
                "idle_ttl": idle_ttl,
            }
        )
        return Simulation(self._c, self._c._post(self._p + "/fork", body))

    def forks(self) -> List[str]:
        """The ids of this simulation's forks."""
        return self.refresh().get("forks") or []

    # -- agents -------------------------------------------------------------------------------

    def agent(self, config: Optional[JSON] = None, **fields: Any) -> "Agent":
        """Grant an external agent (``actor``, ``machines``, ``actions``, ``observations``,
        ``action_budget``, ``label``) and return its handle, which holds the actor token."""
        body = dict(config or {})
        body.update(_drop_none(fields))
        agent = Agent._from_grant(self._c, self.id, self._c._post(self._p + "/agents", body))
        self._agents[agent.id] = agent
        return agent

    def hosted_agent(self, machine: Optional[str] = None, *, name: Optional[str] = None) -> "Agent":
        """A hosted agent: one the platform runs (Computatrum's agent loop) on ``machine``, as its
        user. Prompt it with ``agent.prompt(text)`` and follow its thread with ``agent.stream()``."""
        made = self._c._post(self._p + "/agents", _drop_none({"kind": "hosted", "machine": machine, "name": name}))
        return Agent._from_grant(self._c, self.id, made)

    def agents(self) -> List[JSON]:
        """Every agent: the external ones (``kind: "external"``, never their tokens), the hosted
        ones, and the society's people (``kind: "simulated"``)."""
        return self._c._get(self._p + "/agents")["agents"]

    def person(self, person_id: str) -> "Agent":
        """A handle on one of the society's people, for its thread (what they did in the rounds;
        it takes no prompt)."""
        return Agent(self._c._t, self.id, person_id, grant={"id": person_id, "kind": "simulated"}, owner=self._c)

    def get_agent(self, agent_id: str) -> "Agent":
        """A handle on an external agent: with its actor token when this object holds it (it
        granted it, or it is a fork that carried it), otherwise acting with the owner's key."""
        if agent_id in self._agents:
            return self._agents[agent_id]
        grant = self._c._get(f"{self._p}/agents/{_q(agent_id)}")
        return Agent._from_grant(self._c, self.id, grant)

    def revoke(self, agent: Union[str, "Agent"]) -> None:
        agent_id = _id(agent)
        self._agents.pop(agent_id, None)
        self._c._delete(f"{self._p}/agents/{_q(agent_id)}")

    def connect_agent(self, agent: Union[str, "Agent"], machine: str) -> JSON:
        """Connect an agent to a machine; returns the agent. It keeps its id, token and
        thread, and its session is made again. A hosted agent drives one machine, so this
        moves it."""
        return self._c._json("PUT", f"{self._p}/agents/{_q(_id(agent))}/machines/{_q(machine)}")

    def disconnect_agent(self, agent: Union[str, "Agent"], machine: str) -> JSON:
        """Disconnect an agent from a machine; returns the agent."""
        return self._c._json("DELETE", f"{self._p}/agents/{_q(_id(agent))}/machines/{_q(machine)}")

    def perform(
        self,
        agent: Union[str, "Agent"],
        gesture: JSON,
        *,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> JSON:
        """One grounded gesture, ``{"do": "click", "target": {"label": "Post"}}``, found on
        the agent's screen the way a procedure finds it."""
        body: JSON = {"agent": _id(agent), "gesture": gesture}
        options = _drop_none({"width": width, "height": height})
        if options:
            body["options"] = options
        return self._c._post(self._p + "/perform", body)

    # -- procedures ---------------------------------------------------------------------------

    def stage(self, instance: JSON) -> JSON:
        return self._c._post(self._p + "/procedures/stage", {"instance": instance})

    def project(
        self,
        agent: Union[str, "Agent", Mapping[str, Union[str, "Agent"]]],
        instance: JSON,
        options: Optional[JSON] = None,
    ) -> JSON:
        """Perform an instance through an agent (or ``{role: agent}``)."""
        body = _drop_none({"instance": instance, "agent": _agent_ref(agent), "options": options})
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
        agent: Any = None,
    ) -> JSON:
        """Instantiate, stage, project and verify in one call. ``fork=True`` runs it in a
        throwaway copy and leaves this simulation as it was."""
        body = _procedure_body(procedure)
        body.update(
            _drop_none(
                {
                    "seed": seed,
                    "fork": fork,
                    "include_steps": include_steps,
                    "options": options,
                    "overrides": overrides,
                    "agent": _agent_ref(agent) if agent is not None else None,
                }
            )
        )
        return self._c._post(self._p + "/procedures/run", body)


def _agent_ref(agent: Any) -> Any:
    if isinstance(agent, Agent):
        return agent.id
    if isinstance(agent, Mapping):
        return {role: _agent_ref(a) for role, a in agent.items()}
    return agent


class Agent:
    """An agent of a simulation, with its thread (``messages``, ``prompt``, ``stream``,
    ``stop``); an external agent is also the actor's door to the simulation.

    Actor calls (``step``, ``observe``, ``scene``, ``render``) use the actor token when the
    handle has one, so a handle can be given to an agent program without the owner's key.
    ``width`` and ``height`` are the viewport the scene, the render and the pointer helpers use.
    """

    def __init__(
        self,
        transport: Transport,
        simulation_id: str,
        agent_id: str,
        *,
        token: Optional[str] = None,
        grant: Optional[JSON] = None,
        owner: Optional[Client] = None,
        width: int = DEFAULT_WIDTH,
        height: int = DEFAULT_HEIGHT,
    ) -> None:
        self._t = transport
        self.simulation_id = simulation_id
        self.id = agent_id
        self.token = token
        self.grant = grant or {}
        self._owner = owner
        self.width = width
        self.height = height
        self._p = f"/simulations/{_q(simulation_id)}/agents/{_q(agent_id)}"

    @classmethod
    def _from_grant(cls, client: Client, simulation_id: str, grant: JSON) -> "Agent":
        token = grant.get("token")
        transport = client._t.with_token(token) if token else client._t
        return cls(transport, simulation_id, grant["id"], token=token, grant=grant, owner=client)

    @classmethod
    def connect(
        cls,
        token: str,
        simulation_id: str,
        agent_id: str,
        *,
        base_url: Optional[str] = None,
        **kw: Any,
    ) -> "Agent":
        """An agent's handle from an actor token alone."""
        base = base_url or os.environ.get("COMPUTERWORLD_API_BASE") or DEFAULT_BASE_URL
        return cls(Transport(base, token, **kw), simulation_id, agent_id, token=token)

    def __repr__(self) -> str:
        return f"Agent(simulation_id={self.simulation_id!r}, id={self.id!r})"

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

    # -- the thread ---------------------------------------------------------------------------

    def _owner_t(self) -> Transport:
        if self._owner is None or not self._owner._t.token:
            raise ComputerWorldError("this is an owner call; this handle has only an actor token")
        return self._owner._t

    def messages(self, after: int = 0, wait: Optional[float] = None) -> JSON:
        """The thread after the message ``after`` (0: from the start), ``{messages, state}``; with
        ``wait`` (seconds, at most 25) a read with nothing new waits for a message."""
        return self._t.request("GET", self._p + "/messages", params=_drop_none({"after": after, "wait": wait})).json()

    def prompt(self, text: str) -> JSON:
        """A prompt from the owner: ``{message, state}``. A hosted agent starts on it (or after
        the task it is on)."""
        return self._owner_t().request("POST", self._p + "/messages", json_body={"text": text}).json()

    def post(self, role: str, text: str, **fields: Any) -> JSON:
        """What an external agent writes into its own thread: ``role`` is ``agent``, ``action``
        or ``status`` (with ``status=started | finished | stopped | failed``)."""
        return self._t.request("POST", self._p + "/messages", json_body={"role": role, "text": text, **fields}).json()

    def stop(self) -> JSON:
        """Stop it (the owner): a hosted agent's task is cut short; an external agent's thread
        says it was stopped. ``{state}``."""
        return self._owner_t().request("POST", self._p + "/stop").json()

    def stream(
        self, after: int = 0, *, wait: float = 25, until: Optional[Callable[[JSON, str], bool]] = None
    ) -> Iterator[JSON]:
        """The thread's messages as they come, by long-polling; it ends when ``until(message,
        state)`` is true of a message (or when the caller stops iterating)."""
        while True:
            page = self.messages(after, wait)
            for m in page["messages"]:
                after = m["seq"]
                yield m
                if until is not None and until(m, page["state"]):
                    return

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
        """One grounded gesture through this agent (an owner call: needs the API key)."""
        if self._owner is None or not self._owner._t.token:
            raise ComputerWorldError("perform is an owner call; this handle has only an actor token")
        return Simulation(self._owner, {"id": self.simulation_id}).perform(
            self.id, gesture, width=self.width, height=self.height
        )


class ActionFailed(ComputerWorldError):
    """A helper's action came back unsuccessful."""

    def __init__(self, action: JSON, outcome: JSON) -> None:
        self.action = action
        self.outcome = outcome
        super().__init__(f"{action['family']} {action['op']} failed: {json.dumps(outcome.get('error'))}")


class Society:
    """A simulation's society: its simulated agents, their rules and rounds."""

    def __init__(self, client: Client, simulation_path: str) -> None:
        self._c = client
        self._p = simulation_path + "/society"

    def __repr__(self) -> str:
        return f"Society({self._p!r})"

    def info(self) -> JSON:
        """``{spec_id, people, round, rounds, metrics}``; ``NotFoundError`` when the simulation has none."""
        return self._c._get(self._p)

    def run_rounds(self, count: int = 1, *, ask_model: bool = False) -> JSON:
        """Run 1 to 100 rounds in this simulation only (a fork runs its own); ``pending``
        lists the model decisions the journal lacks."""
        return self._c._post(self._p + "/rounds", _drop_none({"count": count, "ask_model": ask_model or None}))

    def journal(self) -> List[JSON]:
        return _ndjson(self._c._t.request("GET", self._p + "/journal").body)

    def add_journal(self, entries: Sequence[JSON]) -> JSON:
        """Answers for pending decisions: ``[{key, reply}]``."""
        return self._c._post(self._p + "/journal", {"entries": list(entries)})

    def trace(self, since: Optional[int] = None) -> List[JSON]:
        return _ndjson(self._c._t.request("GET", self._p + "/trace", params={"since": since}).body)

    def summary(self) -> JSON:
        """Outcomes per round for this simulation and each fork, their divergence and state hashes."""
        return self._c._get(self._p + "/summary")


def _ndjson(body: bytes) -> List[JSON]:
    return [json.loads(line) for line in body.decode().splitlines() if line.strip()]
