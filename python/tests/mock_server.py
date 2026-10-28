"""A tiny local stand-in for the API: scripted answers, every request recorded."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

Reply = Tuple[int, Dict[str, str], bytes]


def reply(status: int = 200, body: Any = None, headers: Optional[Dict[str, str]] = None) -> Reply:
    h = dict(headers or {})
    if isinstance(body, (bytes, bytearray)):
        data = bytes(body)
    elif body is None:
        data = b""
    else:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    return status, h, data


def error(status: int, code: str, message: str = "", headers=None) -> Reply:
    return reply(status, {"error": {"code": code, "message": message}}, headers)


class MockApi:
    """``routes[(METHOD, path)]`` is a reply, a list of replies (served in turn, the last
    repeating), or a callable taking the request dict."""

    def __init__(self) -> None:
        self.routes: Dict[Tuple[str, str], Any] = {}
        self.requests: List[Dict[str, Any]] = []
        mock = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                url = urlsplit(self.path)
                req = {
                    "method": self.command,
                    "path": url.path,
                    "query": {k: v[0] for k, v in parse_qs(url.query).items()},
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": json.loads(raw) if raw else None,
                }
                mock.requests.append(req)
                status, headers, data = mock._answer(req)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.block_on_close = False
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.02,), daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def _answer(self, req: Dict[str, Any]) -> Reply:
        route = self.routes.get((req["method"], req["path"]))
        if route is None:
            return error(404, "not_found", "route not found")
        if isinstance(route, list):
            return route.pop(0) if len(route) > 1 else route[0]
        if isinstance(route, Callable):  # type: ignore[arg-type]
            return route(req)
        return route

    def __enter__(self) -> "MockApi":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
