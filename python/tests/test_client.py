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
    ApiError,
    Client,
    ConnectionFailed,
    ElementNotFound,
    Environment,
    NotFoundError,
    RateLimitError,
    ServerError,
    __version__,
)
from computerworld_cloud._http import Transport, normalize_base_url, parse_retry_after  # noqa: E402
from mock_server import MockApi, error, reply  # noqa: E402

WORLD = {"id": "w_abc", "source": "builtin:agent-desktop", "state_hash": "h0", "tick": 0, "machines": ["workstation"]}
GRANT = {
    "id": "env_1",
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


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.api = MockApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.sleeps = []
        self.transport = Transport(self.api.url, "cw_live_test", sleep=self.sleeps.append)
        self.client = Client(_transport=self.transport)
        self.addCleanup(self.client.close)

    def boot(self):
        self.api.routes[("POST", "/v1/worlds")] = reply(201, WORLD)
        self.api.routes[("POST", "/v1/worlds/w_abc/environments")] = reply(201, GRANT)
        world = self.client.create_world("agent-desktop", seed=1)
        return world, world.environment()


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

    def test_error_carries_code_message_and_status(self) -> None:
        self.api.routes[("GET", "/v1/worlds/w_x")] = error(404, "not_found", "no such world")
        with self.assertRaises(NotFoundError) as cm:
            self.client.get_world("w_x")
        e = cm.exception
        self.assertEqual((e.status, e.code, e.message), (404, "not_found", "no such world"))
        self.assertIn("GET /worlds/w_x", str(e))
        self.assertEqual(len(self.api.requests), 1)

    def test_non_json_error_names_cloudflare_1010(self) -> None:
        self.api.routes[("GET", "/v1/me")] = reply(403, b"error code: 1010", {"Content-Type": "text/plain"})
        with self.assertRaises(ApiError) as cm:
            self.client.me()
        self.assertEqual(cm.exception.code, "http_403")
        self.assertIn("User-Agent", cm.exception.message)

    def test_429_retries_honoring_retry_after(self) -> None:
        self.api.routes[("POST", "/v1/worlds/w_abc/environments/env_1/step")] = [
            error(429, "rate_limited", "slow down", {"Retry-After": "2"}),
            error(429, "rate_limited", "slow down", {"Retry-After": "1"}),
            reply(200, STEP_OK),
        ]
        _, env = self.boot()
        self.assertEqual(env.step({"family": "keyboard.v1", "op": "type", "payload": {"text": "x"}})["state_hash"], "h1")
        self.assertEqual(self.sleeps, [2.0, 1.0])

    def test_429_gives_up_after_max_retries(self) -> None:
        self.api.routes[("GET", "/v1/worlds")] = error(429, "quota_exceeded", "", {"Retry-After": "0"})
        with self.assertRaises(RateLimitError) as cm:
            self.client.list_worlds()
        self.assertEqual(cm.exception.retry_after, 0.0)
        self.assertEqual(len(self.api.requests), 1 + self.transport.max_retries)

    def test_retry_after_too_long_is_not_waited(self) -> None:
        self.api.routes[("GET", "/v1/worlds")] = error(429, "quota_exceeded", "", {"Retry-After": "86400"})
        with self.assertRaises(RateLimitError):
            self.client.list_worlds()
        self.assertEqual(self.sleeps, [])

    def test_5xx_backoff_on_get_but_not_post(self) -> None:
        self.api.routes[("GET", "/v1/worlds")] = [error(502, "bad_gateway"), error(500, "engine_error"), reply(200, {"worlds": []})]
        self.assertEqual(self.client.list_worlds(), [])
        self.assertEqual(len(self.sleeps), 2)
        self.assertTrue(0.25 <= self.sleeps[0] <= 0.5 and 0.5 <= self.sleeps[1] <= 1.0, self.sleeps)
        self.api.routes[("POST", "/v1/worlds")] = error(500, "engine_error", "boom")
        with self.assertRaises(ServerError):
            self.client.create_world("agent-desktop")
        self.assertEqual(self.api.requests[-1]["method"], "POST")
        self.assertEqual(sum(r["method"] == "POST" for r in self.api.requests), 1)

    def test_503_retries_post(self) -> None:
        self.api.routes[("POST", "/v1/worlds")] = [error(503, "unavailable"), reply(201, WORLD)]
        self.assertEqual(self.client.create_world("agent-desktop").id, "w_abc")

    def test_connection_failure(self) -> None:
        t = Transport("http://127.0.0.1:9", "k", max_retries=1, sleep=lambda s: None, timeout=2)
        with self.assertRaises(ConnectionFailed):
            Client(_transport=t).me()

    def test_parse_retry_after_http_date(self) -> None:
        self.assertEqual(parse_retry_after("Wed, 21 Oct 2015 07:28:10 GMT", now=1445412480.0), 10.0)
        self.assertIsNone(parse_retry_after("soon"))


class WorldTests(Base):
    def test_create_world_body_and_handle(self) -> None:
        world, env = self.boot()
        self.assertEqual(self.api.requests[0]["body"], {"world": "agent-desktop", "seed": 1})
        self.assertEqual(world.id, "w_abc")
        self.assertEqual(env.token, "cwa_w_abc_secret")
        with self.assertRaises(ValueError):
            self.client.create_world("a", blueprint="bp_1")

    def test_actor_calls_use_the_actor_token(self) -> None:
        _, env = self.boot()
        self.api.routes[("GET", "/v1/worlds/w_abc/environments/env_1/observe")] = reply(200, {"channels": {}})
        env.observe()
        self.assertEqual(self.api.requests[-1]["headers"]["authorization"], "Bearer cwa_w_abc_secret")

    def test_connect_parses_world_from_token(self) -> None:
        env = Environment.connect("cwa_w_abc_secret", "env_1", base_url=self.api.url)
        self.assertEqual(env.world_id, "w_abc")

    def test_owner_routes(self) -> None:
        world, _ = self.boot()
        p = "/v1/worlds/w_abc"
        self.api.routes[("POST", p + "/advance")] = reply(200, {"state_hash": "h", "tick": 30_000_000})
        self.api.routes[("POST", p + "/snapshots")] = reply(201, {"id": "s_1"})
        self.api.routes[("POST", p + "/snapshots/s_1/restore")] = reply(200, {"state_hash": "h", "tick": 0})
        self.api.routes[("GET", p + "/inspect")] = reply(200, {"x": 1})
        self.api.routes[("POST", p + "/fork")] = reply(201, dict(WORLD, id="w_fork", environments=[dict(GRANT, token="cwa_w_fork_new")]))
        self.api.routes[("DELETE", p)] = reply(204)
        world.advance("30s")
        self.assertEqual(self.api.requests[-1]["body"], {"duration": "30s"})
        world.advance(ticks=5)
        self.assertEqual(self.api.requests[-1]["body"], {"ticks": 5})
        snap = world.snapshot("before")
        world.restore(snap)
        world.inspect("/state/services")
        self.assertEqual(self.api.requests[-1]["query"], {"pointer": "/state/services"})
        fork = world.fork(snap)
        self.assertEqual(self.api.requests[-1]["body"], {"snapshot": "s_1"})
        self.assertEqual(fork.session("env_1").token, "cwa_w_fork_new")
        world.delete()
        self.assertEqual(self.api.requests[-1]["method"], "DELETE")

    def test_world_context_manager_deletes(self) -> None:
        self.api.routes[("POST", "/v1/worlds")] = reply(201, WORLD)
        self.api.routes[("DELETE", "/v1/worlds/w_abc")] = reply(204)
        with self.client.create_world("agent-desktop"):
            pass
        self.assertEqual(self.api.requests[-1]["method"], "DELETE")

    def test_procedure_references(self) -> None:
        world, env = self.boot()
        self.api.routes[("POST", "/v1/procedures/instantiate")] = reply(200, {"seed": 2})
        self.api.routes[("POST", "/v1/worlds/w_abc/procedures/run")] = reply(200, {"verification": {"passed": True}})
        self.api.routes[("POST", "/v1/worlds/w_abc/procedures/project")] = reply(200, {"completed": True})
        self.client.instantiate("agent-desktop/legal-engagement", seed=2)
        self.assertEqual(self.api.requests[-1]["body"], {"ref": {"world": "agent-desktop", "id": "legal-engagement"}, "seed": 2})
        world.run({"world": "agent-desktop", "id": "legal-engagement"}, seed=3, fork=True)
        self.assertEqual(self.api.requests[-1]["body"], {"ref": {"world": "agent-desktop", "id": "legal-engagement"}, "seed": 3, "fork": True, "include_steps": False})
        world.project({"lawyer": env}, {"seed": 2})
        self.assertEqual(self.api.requests[-1]["body"]["environment"], {"lawyer": "env_1"})
        with self.assertRaises(ValueError):
            self.client.instantiate("legal-engagement")

    def test_update_me_distinguishes_none_from_left_out(self) -> None:
        self.api.routes[("PATCH", "/v1/me")] = reply(200, {"user": {}})
        self.client.update_me(email=None, name="Ada")
        self.assertEqual(self.api.requests[-1]["body"], {"email": None, "name": "Ada"})


class EnvironmentTests(Base):
    def setUp(self) -> None:
        super().setUp()
        self.world, self.env = self.boot()
        base = "/v1/worlds/w_abc/environments/env_1"
        self.api.routes[("GET", base + "/scene")] = reply(200, SCENE)
        self.api.routes[("POST", base + "/step")] = reply(200, STEP_OK)

    def test_find_by_label_role_interaction_and_regex(self) -> None:
        self.assertEqual(self.env.find(label="Text Editor")["center"], [34, 187])
        self.assertEqual(self.api.requests[-1]["query"], {"width": "1280", "height": "800", "elements": "1"})
        self.assertEqual(len(self.env.find_all(interaction=re.compile(r"^shell:launch"))), 3)
        self.assertEqual(self.env.find(role="button", label="Text Editor", index=1)["rect"]["x"], 600)

    def test_find_skips_disabled_and_explains_misses(self) -> None:
        with self.assertRaises(ElementNotFound) as cm:
            self.env.find(label="Save")
        self.assertIn("button:Text Editor", str(cm.exception))

    def test_click_by_interaction_sends_the_center(self) -> None:
        self.env.click(interaction="shell:launch:editor")
        action = self.api.requests[-1]["body"]["actions"][0]
        self.assertEqual(action, {"family": "pointer.v1", "op": "click", "payload": {"x": 34, "y": 187, "width": 1280, "height": 800}})

    def test_click_center_from_rect_and_double(self) -> None:
        self.env.click(label="Text Editor", index=1, double=True)
        action = self.api.requests[-1]["body"]["actions"][0]
        self.assertEqual((action["op"], action["payload"]["x"], action["payload"]["y"]), ("double_click", 605, 405))

    def test_unsuccessful_helper_raises(self) -> None:
        self.api.routes[("POST", "/v1/worlds/w_abc/environments/env_1/step")] = reply(200, {"outcomes": [{"success": False, "error": {"code": "denied"}}]})
        with self.assertRaises(ActionFailed):
            self.env.press("Ctrl+S")
        self.assertFalse(self.env.type_text("x", check=False)["outcomes"][0]["success"])

    def test_render_returns_frame_and_304(self) -> None:
        png = b"\x89PNG\r\n\x1a\nrest"
        route = ("GET", "/v1/worlds/w_abc/environments/env_1/render")
        self.api.routes[route] = reply(200, png, {"Content-Type": "image/png", "ETag": '"e1"', "X-State-Hash": "h1", "X-Tick": "7"})
        frame = self.env.render()
        self.assertEqual(bytes(frame), png)
        self.assertEqual((frame.etag, frame.state_hash, frame.tick), ('"e1"', "h1", 7))
        self.api.routes[route] = lambda req: reply(304) if req["headers"].get("if-none-match") == '"e1"' else reply(200, png)
        self.assertIsNone(self.env.render(if_none_match=frame.etag))

    def test_perform_goes_through_the_owner(self) -> None:
        self.api.routes[("POST", "/v1/worlds/w_abc/perform")] = reply(200, {"steps": []})
        self.env.perform({"do": "click", "target": {"label": "Post"}})
        req = self.api.requests[-1]
        self.assertEqual(req["headers"]["authorization"], "Bearer cw_live_test")
        self.assertEqual(req["body"]["environment"], "env_1")


class SwarmTests(Base):
    def test_swarm_routes(self) -> None:
        self.api.routes[("POST", "/v1/swarms")] = reply(201, {"id": "sw_1", "round": 0})
        self.api.routes[("POST", "/v1/swarms/sw_1/rounds")] = reply(200, {"round": 2, "done": False, "rounds": []})
        self.api.routes[("GET", "/v1/swarms/sw_1/journal")] = reply(200, b'{"key":"a","reply":"x"}\n{"key":"b","reply":"y"}\n')
        self.api.routes[("GET", "/v1/swarms/sw_1/trace")] = reply(200, b'{"type":"boot"}\n')
        swarm = self.client.create_swarm("company-2026/rumor-cascade", journal="builtin")
        self.assertEqual(self.api.requests[-1]["body"], {"ref": {"world": "company-2026", "id": "rumor-cascade"}, "journal": "builtin"})
        swarm.run_rounds(2)
        self.assertEqual(self.api.requests[-1]["body"], {"count": 2})
        self.assertEqual([e["key"] for e in swarm.journal()], ["a", "b"])
        swarm.trace(arm="prefix", since=3)
        self.assertEqual(self.api.requests[-1]["query"], {"arm": "prefix", "since": "3"})


if __name__ == "__main__":
    unittest.main()
