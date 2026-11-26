"""Live smoke test against the hosted API. Runs only with COMPUTERWORLD_API_KEY set.

    COMPUTERWORLD_API_KEY=cw_live_... python -m unittest tests/test_live.py -v

It boots agent-desktop, clicks the editor's launcher, types, renders a PNG, runs the
legal-engagement procedure in a fork, and deletes every environment it made. Timings (client
side, milliseconds) are printed at the end.
"""

from __future__ import annotations

import os
import struct
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from computerworld_cloud import Client, NotFoundError  # noqa: E402

TIMINGS: dict = {}


class timed:
    def __init__(self, name: str) -> None:
        self.name = name

    def __enter__(self) -> None:
        self.t = time.perf_counter()

    def __exit__(self, *exc) -> None:
        TIMINGS[self.name] = round((time.perf_counter() - self.t) * 1000, 1)


@unittest.skipUnless(os.environ.get("COMPUTERWORLD_API_KEY"), "COMPUTERWORLD_API_KEY is not set")
class LiveSmoke(unittest.TestCase):
    def test_agent_desktop_journey(self) -> None:
        client = Client()
        made = []
        try:
            with timed("health"):
                self.assertTrue(client.health()["ok"])
            with timed("boot agent-desktop"):
                environment = client.create_environment("agent-desktop", seed=1, name="sdk-smoke-python")
            made.append(environment)
            with timed("grant agent"):
                agent = environment.agent(label="smoke")
            self.assertTrue(agent.token.startswith("cwa_"))

            with timed("scene (elements)"):
                launcher = agent.find(interaction="shell:launch:editor")
            with timed("step (click)"):
                clicked = agent.click(element=launcher)
            self.assertIn("window.opened", clicked["outcomes"][0]["effect"]["changed"])
            text = agent.find(role="textbox", label="Document text")
            agent.click(element=text)
            with timed("step (type)"):
                agent.type_text("Hello from computerworld-cloud-python")

            with timed("render 1280x800 png"):
                frame = agent.render()
            self.assertEqual(frame[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", frame[16:24]), (1280, 800))
            self.assertEqual(frame.state_hash, environment.state_hash())
            with timed("render 304"):
                self.assertIsNone(agent.render(if_none_match=frame.etag))

            before = environment.state_hash()
            with timed("fork"):
                fork = environment.fork()
            made.append(fork)
            self.assertEqual(fork.state_hash(), before)
            self.assertEqual(fork.info.get("forked_from"), environment.id)
            self.assertTrue(fork.get_agent(agent.id).token not in (None, agent.token))

            with timed("procedure run legal-engagement"):
                run = fork.run("agent-desktop/legal-engagement", seed=1)
            self.assertTrue(run["verification"]["passed"], run["verification"])
            TIMINGS["legal-engagement GUI actions"] = run["demonstration"].get("counts", {}).get("actions") or len(
                run["demonstration"].get("steps") or []
            )
            self.assertNotEqual(fork.state_hash(), environment.state_hash())
        finally:
            with timed("delete"):
                for e in reversed(made):
                    try:
                        e.delete()
                    except NotFoundError:
                        pass
        left = {e["id"] for e in client.list_environments()}
        self.assertFalse(left & {e.id for e in made})
        agent.close()
        client.close()

    @classmethod
    def tearDownClass(cls) -> None:
        if TIMINGS:
            width = max(map(len, TIMINGS))
            print("\nlive smoke (python), client-side ms:", file=sys.stderr)
            for name, ms in TIMINGS.items():
                print(f"  {name:<{width}}  {ms}", file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
