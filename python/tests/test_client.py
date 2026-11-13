"""Offline tests against a local mock of the API."""

from __future__ import annotations

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from computerworld_cloud import (  # noqa: E402
    ActionFailed,
    Agent,
    ApiError,
    Client,
    ConnectionFailed,
    ElementNotFound,
    NotFoundError,
    RateLimitError,
    ServerError,
    __version__,
)
from computerworld_cloud.client import DEFAULT_BASE_URL  # noqa: E402
from computerworld_cloud._http import Transport, normalize_base_url, parse_retry_after  # noqa: E402
from mock_server import MockApi, error, reply  # noqa: E402

SIMULATION = {"id": "w_abc", "source": "builtin:agent-desktop", "state_hash": "h0", "tick": 0, "machines": ["workstation"]}
GRANT = {
    "id": "agent_1",
    "kind": "external",
    "session": "session-0",
    "config": {"actor": "ada", "machines": ["workstation"]},
    "token": "cwa_w_abc_secret",
}
SCENE = {
    "width": 1280,
    "height": 800,
    "nodes": [],
    "elements": [
        {"role": "button", "label": "Show applications", "interaction": "shell:launcher", "rect": {"x": 6, "y": 738, "width": 56, "height": 54}, "center": [34, 765]},
        {"role": "button", "label": "Text Editor", "interaction": "shell:launch:editor", "rect": {"x": 6, "y": 162, "width": 56, "height": 50}, "center": [34, 187]},
        {"role": "button", "label": "Text Editor", "interaction": "shell:launch:editor", "rect": {"x": 600, "y": 400, "width": 10, "height": 10}},
        {"role": "button", "label": "Save", "interaction": "editor:save", "disabled": True, "center": [1, 1]},
    ],
}
STEP_OK = {"outcomes": [{"success": True, "value": None, "error": None}], "state_hash": "h1", "tick": 0}
AGENT = "/v1/simulations/w_abc/agents/agent_1"


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.api = MockApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.sleeps = []
        self.transport = Transport(self.api.url, "cw_live_test", sleep=self.sleeps.append)
        self.client = Client(_transport=self.transport)
        self.addCleanup(self.client.close)

    def boot(self):
        self.api.routes[("POST", "/v1/simulations")] = reply(201, SIMULATION)
        self.api.routes[("POST", "/v1/simulations/w_abc/agents")] = reply(201, GRANT)
        simulation = self.client.create_simulation("agent-desktop", seed=1)
        return simulation, simulation.agent()


class OneComputerTests(Base):
    def test_step_with_frame_files_and_idle_ttl(self) -> None:
        self.api.routes[("POST", "/v1/simulations")] = reply(201, {**SIMULATION, "idle_ttl": 900})
        self.api.routes[("POST", "/v1/simulations/w_abc/agents")] = reply(201, GRANT)
        simulation = self.client.create_simulation("agent-desktop", platform="ubuntu", idle_ttl=900)
        self.assertEqual(self.api.requests[-1]["body"], {"template": "agent-desktop", "seed": 1, "platform": "ubuntu", "idle_ttl": 900})
        agent = simulation.agent()
        frame = {"png": "iVBORw0K", "width": 1280, "height": 800, "state_hash": "h1"}
        self.api.routes[("POST", AGENT + "/step")] = reply(200, {**STEP_OK, "frame": frame})
        r = agent.step({"family": "keyboard.v1", "op": "type", "payload": {"text": "x"}}, render={"if_changed": True})
        self.assertEqual(r["frame"]["png"], "iVBORw0K")
        self.assertEqual(self.api.requests[-1]["body"]["render"], {"width": 1280, "height": 800, "if_changed": True})
        self.api.routes[("PUT", "/v1/simulations/w_abc/files")] = lambda req: reply(200, {"machine": "workstation", "path": req["query"]["path"], "bytes": 3, "got": req["body"]})
        self.assertEqual(simulation.write_file("/home/ada/a.txt", "hey", machine="workstation")["got"], {"content": "hey"})
        self.assertEqual(self.api.requests[-1]["query"], {"machine": "workstation", "path": "/home/ada/a.txt"})
        simulation.write_file("/home/ada/b.bin", b"\x00\xff")
        self.assertEqual(self.api.requests[-1]["body"], {"base64": "AP8="})
        self.api.routes[("GET", "/v1/simulations/w_abc/files")] = reply(200, {"machine": "workstation", "path": "/home/ada/a.txt", "content": "hey", "base64": "aGV5", "bytes": 3})
        self.assertEqual(simulation.read_file("/home/ada/a.txt")["content"], "hey")
        self.assertEqual(self.api.requests[-1]["query"], {"path": "/home/ada/a.txt"})

    def test_agent_models_on_openai_paths(self) -> None:
        self.api.routes[("GET", "/v1/models")] = reply(200, {"object": "list", "data": [{"id": "deepseek-flash"}, {"id": "glm-5.3-flash"}]})
        self.assertEqual([m["id"] for m in self.client.models()], ["deepseek-flash", "glm-5.3-flash"])
        self.api.routes[("POST", "/v1/chat/completions")] = reply(200, {"choices": [{"message": {"content": "hi"}}]})
        self.assertEqual(self.client.chat({"model": "deepseek-flash", "messages": []})["choices"][0]["message"]["content"], "hi")
        self.assertEqual(self.api.requests[-1]["body"]["model"], "deepseek-flash")


class ThreadTests(Base):
    def test_hosted_agent_prompt_stream_stop_and_an_actor_writing_its_thread(self) -> None:
        self.api.routes[("POST", "/v1/simulations")] = reply(201, SIMULATION)
        simulation = self.client.create_simulation("agent-desktop")
        self.api.routes[("POST", "/v1/simulations/w_abc/agents")] = reply(201, {"id": "agent_2", "kind": "hosted", "name": "Typist", "machine": "workstation", "state": "idle"})
        hosted = simulation.hosted_agent("workstation", name="Typist")
        self.assertEqual(self.api.requests[-1]["body"], {"kind": "hosted", "machine": "workstation", "name": "Typist"})
        self.assertIsNone(hosted.token)
        h = "/v1/simulations/w_abc/agents/agent_2"
        self.api.routes[("POST", h + "/messages")] = reply(201, {"message": {"seq": 1, "role": "person", "text": "Type hello", "at": 1}, "state": "working"})
        self.assertEqual(hosted.prompt("Type hello")["state"], "working")
        self.assertEqual(self.api.requests[-1]["body"], {"text": "Type hello"})
        self.api.routes[("GET", h + "/messages")] = [
            reply(200, {"messages": [{"seq": 2, "role": "status", "status": "started", "text": "Working", "at": 2}], "state": "working"}),
            reply(200, {"messages": [], "state": "working"}),
            reply(200, {"messages": [{"seq": 3, "role": "action", "text": "Typed", "at": 3}, {"seq": 4, "role": "status", "status": "finished", "text": "Done", "at": 4}], "state": "idle"}),
        ]
        seen = [m["seq"] for m in hosted.stream(1, until=lambda m, s: m["role"] == "status" and m["status"] != "started")]
        self.assertEqual(seen, [2, 3, 4])
        self.assertEqual([r["query"] for r in self.api.requests if r["method"] == "GET"], [{"after": "1", "wait": "25"}, {"after": "2", "wait": "25"}, {"after": "2", "wait": "25"}])
        self.api.routes[("POST", h + "/stop")] = reply(200, {"state": "stopped"})
        self.assertEqual(hosted.stop(), {"state": "stopped"})

        self.api.routes[("POST", "/v1/simulations/w_abc/agents")] = reply(201, GRANT)
        external = simulation.agent()
        self.api.routes[("POST", AGENT + "/messages")] = reply(201, {"message": {"seq": 2, "role": "status", "status": "started", "text": "On it", "at": 5}, "state": "working"})
        external.post("status", "On it", status="started")
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], "Bearer cwa_w_abc_secret")
        self.assertEqual(self.api.requests[-1]["body"], {"role": "status", "text": "On it", "status": "started"})
        external.prompt("Next")
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], "Bearer cw_live_test")
        with self.assertRaises(Exception):
            Agent.connect("cwa_w_abc_secret", "w_abc", "agent_1", base_url=self.api.url).prompt("x")
        self.api.routes[("GET", "/v1/simulations/w_abc/agents/p1/messages")] = reply(200, {"messages": [{"seq": 1, "role": "status", "status": "started", "text": "Round 0", "at": None}], "state": "idle"})
        self.assertIsNone(simulation.person("p1").messages()["messages"][0]["at"])


class TransportTests(Base):
    def test_user_agent_and_bearer_are_always_sent(self) -> None:
        self.api.routes[("GET", "/v1/me")] = reply(200, {"user": {"username": "ada"}})
        self.client.me()
        h = self.api.requests[0]["headers"]
        self.assertEqual(h["user-agent"], f"computerworld-cloud-python/{__version__}")
        self.assertEqual(h["authorization"], "Bearer cw_live_test")

    def test_custom_user_agent_is_prefixed(self) -> None:
        t = Transport(self.api.url, "k", user_agent="my-agent/2")
        self.api.routes[("GET", "/v1/health")] = reply(200, {"ok": True})
        Client(_transport=t).health()
        self.assertEqual(self.api.requests[0]["headers"]["user-agent"], f"my-agent/2 computerworld-cloud-python/{__version__}")
        self.assertNotIn("authorization", self.api.requests[0]["headers"])  # health is public

    def test_base_url_normalization(self) -> None:
        self.assertEqual(normalize_base_url("https://x.dev"), "https://x.dev/v1")
        self.assertEqual(normalize_base_url("https://x.dev/v1/"), "https://x.dev/v1")

    def test_default_base_url_and_another_base(self) -> None:
        self.assertEqual(DEFAULT_BASE_URL, "https://computaco.ai/v1")
        self.assertEqual(Client("cw_live_x").base_url, "https://computaco.ai/v1")
        self.assertEqual(
            Client("cw_live_x", base_url="https://dev.computaco.ai").base_url,
            "https://dev.computaco.ai/v1",
        )

    def test_error_carries_code_message_and_status(self) -> None:
        self.api.routes[("GET", "/v1/simulations/w_x")] = error(404, "not_found", "no such simulation")
        with self.assertRaises(NotFoundError) as cm:
            self.client.get_simulation("w_x")
        e = cm.exception
        self.assertEqual((e.status, e.code, e.message), (404, "not_found", "no such simulation"))
        self.assertIn("GET /simulations/w_x", str(e))
        self.assertEqual(len(self.api.requests), 1)

    def test_non_json_error_names_cloudflare_1010(self) -> None:
        self.api.routes[("GET", "/v1/me")] = reply(403, b"error code: 1010", {"Content-Type": "text/plain"})
        with self.assertRaises(ApiError) as cm:
            self.client.me()
        self.assertEqual(cm.exception.code, "http_403")
        self.assertIn("User-Agent", cm.exception.message)

    def test_429_retries_honoring_retry_after(self) -> None:
        self.api.routes[("POST", AGENT + "/step")] = [
            error(429, "rate_limited", "slow down", {"Retry-After": "2"}),
            error(429, "rate_limited", "slow down", {"Retry-After": "1"}),
            reply(200, STEP_OK),
        ]
        _, agent = self.boot()
        self.assertEqual(agent.step({"family": "keyboard.v1", "op": "type", "payload": {"text": "x"}})["state_hash"], "h1")
        self.assertEqual(self.sleeps, [2.0, 1.0])

    def test_429_gives_up_after_max_retries(self) -> None:
        self.api.routes[("GET", "/v1/simulations")] = error(429, "quota_exceeded", "", {"Retry-After": "0"})
        with self.assertRaises(RateLimitError) as cm:
            self.client.list_simulations()
        self.assertEqual(cm.exception.retry_after, 0.0)
        self.assertEqual(len(self.api.requests), 1 + self.transport.max_retries)

    def test_retry_after_too_long_is_not_waited(self) -> None:
        self.api.routes[("GET", "/v1/simulations")] = error(429, "quota_exceeded", "", {"Retry-After": "86400"})
        with self.assertRaises(RateLimitError):
            self.client.list_simulations()
        self.assertEqual(self.sleeps, [])

    def test_5xx_backoff_on_get_but_not_post(self) -> None:
        self.api.routes[("GET", "/v1/simulations")] = [error(502, "bad_gateway"), error(500, "engine_error"), reply(200, {"simulations": []})]
        self.assertEqual(self.client.list_simulations(), [])
        self.assertEqual(len(self.sleeps), 2)
        self.assertTrue(0.25 <= self.sleeps[0] <= 0.5 and 0.5 <= self.sleeps[1] <= 1.0, self.sleeps)
        self.api.routes[("POST", "/v1/simulations")] = error(500, "engine_error", "boom")
        with self.assertRaises(ServerError):
            self.client.create_simulation("agent-desktop")
        self.assertEqual(self.api.requests[-1]["method"], "POST")
        self.assertEqual(sum(r["method"] == "POST" for r in self.api.requests), 1)

    def test_503_retries_post(self) -> None:
        self.api.routes[("POST", "/v1/simulations")] = [error(503, "unavailable"), reply(201, SIMULATION)]
        self.assertEqual(self.client.create_simulation("agent-desktop").id, "w_abc")

    def test_connection_failure(self) -> None:
        t = Transport("http://127.0.0.1:9", "k", max_retries=1, sleep=lambda s: None, timeout=2)
        with self.assertRaises(ConnectionFailed):
            Client(_transport=t).me()

    def test_parse_retry_after_http_date(self) -> None:
        self.assertEqual(parse_retry_after("Wed, 21 Oct 2015 07:28:10 GMT", now=1445412480.0), 10.0)
        self.assertIsNone(parse_retry_after("soon"))


class SimulationTests(Base):
    def test_create_simulation_body_and_handles(self) -> None:
        simulation, agent = self.boot()
        self.assertEqual(self.api.requests[0]["body"], {"template": "agent-desktop", "seed": 1})
        self.assertEqual(simulation.id, "w_abc")
        self.assertEqual(agent.token, "cwa_w_abc_secret")
        with self.assertRaises(ValueError):
            self.client.create_simulation("a", definition={})
        with self.assertRaises(ValueError):
            self.client.create_simulation()

    def test_a_society_is_booted_with_the_simulation(self) -> None:
        self.api.routes[("POST", "/v1/simulations")] = reply(201, SIMULATION)
        self.client.create_simulation("company-2026", society="rumor-cascade")
        self.assertEqual(self.api.requests[-1]["body"], {"template": "company-2026", "seed": 1, "society": {"id": "rumor-cascade"}})
        society = {"spec": {"people": []}, "journal": "builtin", "rounds": 4}
        self.client.create_simulation(definition={"computers": []}, society=society)
        self.assertEqual(self.api.requests[-1]["body"]["society"], society)

    def test_owner_routes(self) -> None:
        simulation, _ = self.boot()
        p = "/v1/simulations/w_abc"
        self.api.routes[("POST", p + "/advance")] = reply(200, {"state_hash": "h", "tick": 30_000_000})
        self.api.routes[("POST", p + "/snapshots")] = reply(201, {"id": "s_1"})
        self.api.routes[("POST", p + "/snapshots/s_1/restore")] = reply(200, {"state_hash": "h", "tick": 0, "head": "s_1", "elapsed_ms": 3})
        self.api.routes[("GET", p + "/inspect")] = reply(200, {"x": 1})
        self.api.routes[("PATCH", p)] = lambda req: reply(200, dict(SIMULATION, name=req["body"]["name"]))
        self.api.routes[("DELETE", p)] = reply(204)
        simulation.advance("30s")
        self.assertEqual(self.api.requests[-1]["body"], {"duration": "30s"})
        simulation.advance(ticks=5)
        self.assertEqual(self.api.requests[-1]["body"], {"ticks": 5})
        snap = simulation.snapshot("before")
        simulation.restore(snap)
        self.api.routes[("GET", p + "/snapshots/s_1/agents")] = reply(200, {"agents": [{"id": "agent_1", "kind": "external", "state": "idle"}], "conversations_kept": True})
        self.api.routes[("GET", p + "/snapshots/s_1/agents/agent_1/messages")] = reply(200, {"messages": [{"seq": 1, "role": "person", "text": "then", "at": 1}], "state": "idle"})
        self.assertTrue(simulation.snapshot_agents(snap)["conversations_kept"])
        self.assertEqual(simulation.snapshot_messages(snap, "agent_1")["messages"][0]["text"], "then")
        self.assertEqual(self.api.requests[-1]["query"], {"after": "0"})
        simulation.inspect("/state/services")
        self.assertEqual(self.api.requests[-1]["query"], {"pointer": "/state/services"})
        self.assertEqual(simulation.rename("office")["name"], "office")
        simulation.delete()
        self.assertEqual(self.api.requests[-1]["method"], "DELETE")

    def test_context_manager_deletes(self) -> None:
        self.api.routes[("POST", "/v1/simulations")] = reply(201, SIMULATION)
        self.api.routes[("DELETE", "/v1/simulations/w_abc")] = reply(204)
        with self.client.create_simulation("agent-desktop"):
            pass
        self.assertEqual(self.api.requests[-1]["method"], "DELETE")

    def test_procedure_references(self) -> None:
        simulation, agent = self.boot()
        self.api.routes[("POST", "/v1/templates/agent-desktop/procedures/legal-engagement/instantiate")] = reply(200, {"seed": 2})
        self.api.routes[("POST", "/v1/simulations/w_abc/procedures/run")] = reply(200, {"verification": {"passed": True}})
        self.api.routes[("POST", "/v1/simulations/w_abc/procedures/project")] = reply(200, {"completed": True})
        self.client.instantiate("agent-desktop", "legal-engagement", seed=2)
        self.assertEqual(self.api.requests[-1]["body"], {"seed": 2})
        simulation.run({"template": "agent-desktop", "id": "legal-engagement"}, seed=3, fork=True, agent=agent)
        self.assertEqual(
            self.api.requests[-1]["body"],
            {"ref": {"template": "agent-desktop", "id": "legal-engagement"}, "seed": 3, "fork": True, "include_steps": False, "agent": "agent_1"},
        )
        simulation.run("agent-desktop/legal-engagement")
        self.assertEqual(self.api.requests[-1]["body"]["ref"], {"template": "agent-desktop", "id": "legal-engagement"})
        simulation.project({"lawyer": agent}, {"seed": 2})
        self.assertEqual(self.api.requests[-1]["body"]["agent"], {"lawyer": "agent_1"})
        with self.assertRaises(ValueError):
            simulation.run("legal-engagement")

    def test_update_me_distinguishes_none_from_left_out(self) -> None:
        self.api.routes[("PATCH", "/v1/me")] = reply(200, {"user": {}})
        self.client.update_me(date_of_birth=None, name="Ada")
        self.assertEqual(self.api.requests[-1]["body"], {"date_of_birth": None, "name": "Ada"})

    def test_set_email_sends_a_code_and_verify_email_confirms_it(self) -> None:
        self.api.routes[("POST", "/v1/me/email")] = reply(202, {"email": {"address": "ada@cs.example.edu", "verified": False}})
        self.api.routes[("POST", "/v1/me/email/verify")] = reply(200, {"user": {}, "tag": "academic"})
        self.assertEqual(self.client.set_email("ada@cs.example.edu"), {"address": "ada@cs.example.edu", "verified": False})
        self.assertEqual(self.api.requests[-1]["body"], {"email": "ada@cs.example.edu"})
        self.assertEqual(self.client.verify_email("123456")["tag"], "academic")
        self.assertEqual(self.api.requests[-1]["body"], {"code": "123456"})

    def test_signup_makes_a_key_with_the_session_and_its_scopes(self) -> None:
        self.api.routes[("POST", "/v1/auth/signup")] = reply(
            201, {"user": {"id": "u_1", "username": "ada"}}, {"Set-Cookie": "cw_session=cws_abc; Path=/; HttpOnly"}
        )

        def make_key(req):
            if req["headers"].get("cookie") != "cw_session=cws_abc":
                return error(401, "unauthenticated")
            return reply(201, {"id": "key_1", "key": "cw_live_secret", "scopes": (req["body"] or {}).get("scopes")})

        self.api.routes[("POST", "/v1/keys")] = make_key
        self.api.routes[("GET", "/v1/me")] = reply(200, {"user": {}})
        made, user, key = Client.signup(
            "ada", "a long enough password", base_url=self.api.url, key_name="ci", scopes=("simulations", "templates")
        )
        self.addCleanup(made.close)
        self.assertEqual(user["username"], "ada")
        self.assertEqual(key["scopes"], ["simulations", "templates"])
        self.assertEqual(self.api.requests[1]["body"], {"name": "ci", "scopes": ["simulations", "templates"]})
        self.assertNotIn("authorization", self.api.requests[1]["headers"])
        made.me()
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], "Bearer cw_live_secret")
        # Without scopes the key asks for none, and the API gives it every one.
        other, _, _ = Client.signup("bob", "a long enough password", base_url=self.api.url)
        self.addCleanup(other.close)
        self.assertEqual(self.api.requests[-1]["body"], {})

    def test_create_key_sends_its_scopes(self) -> None:
        self.api.routes[("POST", "/v1/keys")] = reply(201, {"id": "key_2", "key": "cw_live_x", "scopes": ["models"]})
        self.client.create_key("agent", scopes=["models"])
        self.assertEqual(self.api.requests[-1]["body"], {"name": "agent", "scopes": ["models"]})
        self.client.create_key()
        self.assertEqual(self.api.requests[-1]["body"], {})


class AgentTests(Base):
    def test_actor_calls_use_the_actor_token(self) -> None:
        _, agent = self.boot()
        self.api.routes[("GET", AGENT + "/observe")] = reply(200, {"channels": {}})
        agent.observe()
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], "Bearer cwa_w_abc_secret")

    def test_connect_makes_a_handle_from_the_actor_token_alone(self) -> None:
        remote = Agent.connect("cwa_w_abc_secret", "w_abc", "agent_1", base_url=self.api.url)
        self.addCleanup(remote.close)
        self.api.routes[("GET", AGENT + "/observe")] = reply(200, {"channels": {}})
        remote.observe()
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], "Bearer cwa_w_abc_secret")

    def test_list_holds_external_and_simulated_agents(self) -> None:
        simulation, agent = self.boot()
        p = "/v1/simulations/w_abc/agents"
        listed = [{k: v for k, v in GRANT.items() if k != "token"}, {"id": "p_nina", "kind": "simulated", "name": "Nina", "population": "staff"}]
        self.api.routes[("GET", p)] = reply(200, {"agents": listed})
        self.api.routes[("GET", p + "/agent_2")] = reply(200, {"id": "agent_2", "kind": "external", "token": "cwa_w_abc_two"})
        self.api.routes[("DELETE", p + "/agent_2")] = reply(204)
        self.assertEqual([a["kind"] for a in simulation.agents()], ["external", "simulated"])
        self.assertIs(simulation.get_agent("agent_1"), agent)
        two = simulation.get_agent("agent_2")
        self.assertEqual(two.token, "cwa_w_abc_two")
        simulation.revoke(two)
        self.assertEqual(self.api.requests[-1]["path"], p + "/agent_2")


class AgentHelperTests(Base):
    def setUp(self) -> None:
        super().setUp()
        self.simulation, self.agent = self.boot()
        self.api.routes[("GET", AGENT + "/scene")] = reply(200, SCENE)
        self.api.routes[("POST", AGENT + "/step")] = reply(200, STEP_OK)

    def test_find_by_label_role_interaction_and_regex(self) -> None:
        self.assertEqual(self.agent.find(label="Text Editor")["center"], [34, 187])
        self.assertEqual(self.api.requests[-1]["query"], {"width": "1280", "height": "800", "elements": "1"})
        self.assertEqual(len(self.agent.find_all(interaction=re.compile(r"^shell:launch"))), 3)
        self.assertEqual(self.agent.find(role="button", label="Text Editor", index=1)["rect"]["x"], 600)

    def test_find_skips_disabled_and_explains_misses(self) -> None:
        with self.assertRaises(ElementNotFound) as cm:
            self.agent.find(label="Save")
        self.assertIn("button:Text Editor", str(cm.exception))

    def test_click_by_interaction_sends_the_center(self) -> None:
        self.agent.click(interaction="shell:launch:editor")
        action = self.api.requests[-1]["body"]["actions"][0]
        self.assertEqual(action, {"family": "pointer.v1", "op": "click", "payload": {"x": 34, "y": 187, "width": 1280, "height": 800}})

    def test_click_center_from_rect_and_double(self) -> None:
        self.agent.click(label="Text Editor", index=1, double=True)
        action = self.api.requests[-1]["body"]["actions"][0]
        self.assertEqual((action["op"], action["payload"]["x"], action["payload"]["y"]), ("double_click", 605, 405))

    def test_unsuccessful_helper_raises(self) -> None:
        self.api.routes[("POST", AGENT + "/step")] = reply(200, {"outcomes": [{"success": False, "error": {"code": "denied"}}]})
        with self.assertRaises(ActionFailed):
            self.agent.press("Ctrl+S")
        self.assertFalse(self.agent.type_text("x", check=False)["outcomes"][0]["success"])

    def test_render_returns_frame_and_304(self) -> None:
        png = b"\x89PNG\r\n\x1a\nrest"
        route = ("GET", AGENT + "/render")
        self.api.routes[route] = reply(200, png, {"Content-Type": "image/png", "ETag": '"e1"', "X-State-Hash": "h1", "X-Tick": "7"})
        frame = self.agent.render()
        self.assertEqual(bytes(frame), png)
        self.assertEqual((frame.etag, frame.state_hash, frame.tick), ('"e1"', "h1", 7))
        self.api.routes[route] = lambda req: reply(304) if req["headers"].get("if-none-match") == '"e1"' else reply(200, png)
        self.assertIsNone(self.agent.render(if_none_match=frame.etag))

    def test_perform_goes_through_the_owner(self) -> None:
        self.api.routes[("POST", "/v1/simulations/w_abc/perform")] = reply(200, {"steps": []})
        self.agent.perform({"do": "click", "target": {"label": "Post"}})
        req = self.api.requests[-1]
        self.assertEqual(req["headers"]["authorization"], "Bearer cw_live_test")
        self.assertEqual(req["body"]["agent"], "agent_1")


class TemplateTests(Base):
    def test_builtin_and_own_in_one_list_own_ones_are_edited(self) -> None:
        self.api.routes[("GET", "/v1/templates")] = reply(200, {"templates": [{"id": "company-2026", "source": "builtin"}, {"id": "bp_1", "source": "own"}]})
        self.api.routes[("POST", "/v1/templates")] = reply(201, {"id": "bp_2", "source": "own"})
        self.api.routes[("PUT", "/v1/templates/bp_2")] = reply(200, {"id": "bp_2", "name": "b"})
        self.api.routes[("POST", "/v1/templates/bp_2/topology")] = reply(200, {"nodes": []})
        self.api.routes[("DELETE", "/v1/templates/bp_2")] = reply(204)
        self.api.routes[("GET", "/v1/simulations/w_abc/definition")] = reply(200, {"computers": []})
        self.assertEqual([t["source"] for t in self.client.list_templates()], ["builtin", "own"])
        simulation, _ = self.boot()
        self.client.create_template(simulation.definition(), name="a")
        self.assertEqual(self.api.requests[-1]["body"], {"name": "a", "definition": {"computers": []}})
        self.client.update_template("bp_2", name="b")
        self.assertEqual(self.api.requests[-1]["body"], {"name": "b"})
        edits = [{"op": "remove_machine", "id": "m"}]
        self.client.edit_template_topology("bp_2", edits)
        self.assertEqual((self.api.requests[-1]["method"], self.api.requests[-1]["body"]), ("POST", {"edits": edits}))
        self.client.delete_template("bp_2")
        self.assertEqual(self.api.requests[-1]["method"], "DELETE")

    def test_procedures_societies_vocabulary_and_validate(self) -> None:
        self.api.routes[("GET", "/v1/templates/company-2026/procedures")] = reply(200, {"procedures": [{"id": "p"}]})
        self.api.routes[("GET", "/v1/templates/company-2026/societies")] = reply(200, {"societies": [{"id": "rumor-cascade"}]})
        self.api.routes[("GET", "/v1/templates/company-2026/societies/rumor-cascade")] = reply(200, {"id": "rumor-cascade"})
        self.api.routes[("GET", "/v1/vocabulary")] = reply(200, {"applications": []})
        self.api.routes[("POST", "/v1/validate")] = reply(200, {"ok": True, "people": 16})
        self.assertEqual(self.client.template_procedures("company-2026")[0]["id"], "p")
        self.assertEqual(self.client.template_societies("company-2026")[0]["id"], "rumor-cascade")
        self.assertEqual(self.client.template_society("company-2026", "rumor-cascade")["id"], "rumor-cascade")
        self.client.vocabulary()
        self.assertEqual(self.client.validate({"computers": []}, society={"id": "rumor-cascade"})["people"], 16)
        self.assertEqual(self.api.requests[-1]["body"], {"definition": {"computers": []}, "society": {"id": "rumor-cascade"}})


class SocietyAndForkTests(Base):
    def test_society_routes_live_under_the_simulation(self) -> None:
        simulation, _ = self.boot()
        p = "/v1/simulations/w_abc/society"
        self.api.routes[("GET", p)] = reply(200, {"spec_id": "rumor-cascade", "people": 16, "round": 0, "rounds": 8})
        self.api.routes[("POST", p + "/rounds")] = reply(200, {"round": 2})
        self.api.routes[("GET", p + "/journal")] = reply(200, b'{"key":"a","reply":"x"}\n{"key":"b","reply":"y"}\n')
        self.api.routes[("POST", p + "/journal")] = reply(200, {"entries": 1})
        self.api.routes[("GET", p + "/trace")] = reply(200, b'{"type":"boot"}\n')
        self.api.routes[("GET", p + "/summary")] = reply(200, {"arms": []})
        self.assertEqual(simulation.society.info()["people"], 16)
        simulation.society.run_rounds(2, ask_model=True)
        self.assertEqual(self.api.requests[-1]["body"], {"count": 2, "ask_model": True})
        self.assertEqual([e["key"] for e in simulation.society.journal()], ["a", "b"])
        simulation.society.add_journal([{"key": "c", "reply": "z"}])
        self.assertEqual(self.api.requests[-1]["body"], {"entries": [{"key": "c", "reply": "z"}]})
        self.assertEqual(simulation.society.trace(since=3), [{"type": "boot"}])
        self.assertEqual(self.api.requests[-1]["query"], {"since": "3"})
        simulation.society.summary()

    def test_a_fork_carries_the_agents_under_new_tokens(self) -> None:
        simulation, _ = self.boot()
        p = "/v1/simulations/w_abc"
        self.api.routes[("POST", p + "/fork")] = reply(201, dict(SIMULATION, id="w_fork", forked_from="w_abc", agents=[dict(GRANT, token="cwa_w_fork_new")]))
        self.api.routes[("GET", p)] = reply(200, dict(SIMULATION, forks=["w_fork"]))
        ops = [{"op": "add_rule", "rule": "r"}]
        fork = simulation.fork(name="arm b", society_ops=ops)
        self.assertEqual(self.api.requests[-1]["body"], {"name": "arm b", "society_ops": ops})
        self.assertEqual(fork.info["forked_from"], "w_abc")
        carried = fork.get_agent("agent_1")
        self.assertEqual((carried.token, carried.simulation_id), ("cwa_w_fork_new", "w_fork"))
        self.assertEqual(simulation.forks(), ["w_fork"])

    def test_places_history_snapshot_frames_and_agent_connections(self) -> None:
        simulation, _ = self.boot()
        p = "/v1/simulations/w_abc"
        place = {"id": "core", "kind": "do", "memory_mb": 128, "metered": False, "modules": [], "reason": "asked for"}
        refused = [{"place": "container", "code": "plan_required", "message": "no container-minutes"}]
        self.api.routes[("POST", "/v1/simulations")] = reply(201, dict(SIMULATION, place=place, refused=refused))
        placed = self.client.create_simulation("agent-desktop", place=("container", "do"))
        self.assertEqual(self.api.requests[-1]["body"], {"template": "agent-desktop", "seed": 1, "place": ["container", "do"]})
        self.assertEqual((placed.info["place"]["id"], placed.info["refused"][0]["code"]), ("core", "plan_required"))
        self.api.routes[("POST", "/v1/simulations/import")] = reply(201, dict(SIMULATION, id="w_imp", place=place))
        self.client.import_simulation({"v": 1}, "copy", place="do")
        self.assertEqual(self.api.requests[-1]["body"], {"snapshot": {"v": 1}, "name": "copy", "place": "do"})
        self.api.routes[("POST", p + "/fork")] = reply(201, dict(SIMULATION, id="w_fork", forked_from="w_abc", place=place))
        simulation.fork(snapshot={"id": "s_1"}, place="do")
        self.assertEqual(self.api.requests[-1]["body"], {"snapshot": "s_1", "place": "do"})

        s1 = {"id": "s_1", "label": "one", "state_hash": "h", "tick": 0, "parent": None, "author": "ada", "frames": ["workstation"]}
        self.api.routes[("GET", p + "/snapshots")] = reply(200, {"snapshots": [s1], "head": "s_1"})
        self.assertEqual(simulation.snapshots(), [s1])
        self.api.routes[("DELETE", p + "/snapshots/s_1")] = reply(200, {"snapshots": [], "head": None})
        self.assertEqual(simulation.drop_snapshot(s1), {"snapshots": [], "head": None})
        png = b"\x89PNG\r\n\x1a\nrest"
        self.api.routes[("GET", p + "/snapshots/s_1/frames/workstation")] = reply(200, png, {"Content-Type": "image/png"})
        frame = simulation.snapshot_frame("s_1", "workstation")
        self.assertEqual((bytes(frame), frame.format), (png, "png"))
        history = {"simulation": "w_abc", "simulations": [{"id": "w_abc", "parent": None, "origin": None, "head": "s_1", "place": place, "snapshots": [s1]}]}
        self.api.routes[("GET", p + "/history")] = reply(200, history)
        self.assertEqual(simulation.history()["simulations"][0]["head"], "s_1")

        m = p + "/agents/agent_1/machines/workstation"
        listed = {k: v for k, v in GRANT.items() if k != "token"}
        self.api.routes[("PUT", m)] = reply(200, listed)
        self.api.routes[("DELETE", m)] = reply(200, listed)
        self.assertEqual(simulation.connect_agent("agent_1", "workstation")["id"], "agent_1")
        self.assertEqual(self.api.requests[-1]["method"], "PUT")
        self.assertEqual(simulation.disconnect_agent("agent_1", "workstation")["id"], "agent_1")
        self.assertEqual(self.api.requests[-1]["method"], "DELETE")


if __name__ == "__main__":
    unittest.main()
