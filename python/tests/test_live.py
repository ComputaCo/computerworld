"""Live smoke test against the hosted API. Runs only with COMPUTERWORLD_API_KEY set.

    COMPUTERWORLD_API_KEY=cw_live_... python -m unittest tests/test_live.py -v

It boots agent-desktop, clicks the editor's launcher, types, renders a PNG, runs the
legal-engagement procedure in a fork, and deletes everything it made. Timings (client
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
                world = client.create_world("agent-desktop", seed=1, name="sdk-smoke-python")
            made.append(world)
            with timed("grant environment"):
                env = world.environment(label="smoke")
            self.assertTrue(env.token.startswith("cwa_"))

            with timed("scene (elements)"):
                launcher = env.find(interaction="shell:launch:editor")
            with timed("step (click)"):
                clicked = env.click(element=launcher)
            self.assertIn("window.opened", clicked["outcomes"][0]["effect"]["changed"])
            text = env.find(role="textbox", label="Document text")
            env.click(element=text)
            with timed("step (type)"):
                env.type_text("Hello from computerworld-cloud-python")

            with timed("render 1280x800 png"):
                frame = env.render()
            self.assertEqual(frame[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", frame[16:24]), (1280, 800))
            self.assertEqual(frame.state_hash, world.state_hash())
            with timed("render 304"):
                self.assertIsNone(env.render(if_none_match=frame.etag))

            with timed("snapshot"):
                snap = world.snapshot("after-typing")
            with timed("fork"):
                fork = world.fork(snap)
            made.append(fork)
            self.assertEqual(fork.state_hash(), snap["state_hash"])
            self.assertTrue(fork.session(env.id).token not in (None, env.token))

            with timed("procedure run legal-engagement"):
                run = fork.run("agent-desktop/legal-engagement", seed=1)
            self.assertTrue(run["verification"]["passed"], run["verification"])
            TIMINGS["legal-engagement GUI actions"] = run["demonstration"].get("counts", {}).get("actions") or len(
                run["demonstration"].get("steps") or []
            )
            self.assertNotEqual(fork.state_hash(), world.state_hash())
        finally:
            with timed("delete"):
                for w in reversed(made):
                    try:
                        w.delete()
                    except NotFoundError:
                        pass
        left = {w["id"] for w in client.list_worlds()}
        self.assertFalse(left & {w.id for w in made})
        env.close()
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
