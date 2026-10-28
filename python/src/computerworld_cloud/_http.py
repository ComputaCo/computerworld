"""HTTP transport: stdlib ``http.client`` with kept-alive connections and retries."""

from __future__ import annotations

import email.utils
import http.client
import json
import random
import threading
import time
import urllib.parse
from typing import Any, Dict, Mapping, Optional, Tuple

from . import __version__
from .errors import ApiError, ConnectionFailed, error_for

USER_AGENT = f"computerworld-cloud-python/{__version__}"

IDEMPOTENT = frozenset({"GET", "HEAD", "PUT", "DELETE", "OPTIONS"})
# 429 and 503 mean the request was not processed, so any method may be sent again.
# 500, 502 and 504 may come after the world changed, so only idempotent methods retry.
ALWAYS_RETRY = frozenset({429, 503})
IDEMPOTENT_RETRY = frozenset({500, 502, 504})


def parse_retry_after(value: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """``Retry-After`` as seconds: either delta-seconds or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return max(0.0, when.timestamp() - (time.time() if now is None else now))


def normalize_base_url(base_url: str) -> str:
    """Accept ``https://host``, ``https://host/`` or ``https://host/v1``; return ``.../v1``."""
    base = base_url.rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    return base


class Response:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status: int, headers: Mapping[str, str], body: bytes) -> None:
        self.status = status
        self.headers = {k.lower(): v for k, v in headers.items()}
        self.body = body

    def json(self) -> Any:
        return json.loads(self.body) if self.body else None


class Transport:
    """One base URL and one credential. Thread-safe: each thread keeps its own connection."""

    def __init__(
        self,
        base_url: str,
        token: Optional[str],
        *,
        timeout: float = 120.0,
        max_retries: int = 4,
        backoff: float = 0.5,
        max_backoff: float = 30.0,
        max_retry_after: float = 120.0,
        user_agent: Optional[str] = None,
        sleep=time.sleep,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        parts = urllib.parse.urlsplit(self.base_url)
        if parts.scheme not in ("http", "https"):
            raise ValueError(f"base_url must be http or https: {base_url!r}")
        self._scheme = parts.scheme
        self._netloc = parts.netloc
        self._prefix = parts.path
        self.token = token
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff = backoff
        self.max_backoff = max_backoff
        self.max_retry_after = max_retry_after
        self.user_agent = USER_AGENT if not user_agent else f"{user_agent} {USER_AGENT}"
        self._sleep = sleep
        self._local = threading.local()

    def with_token(self, token: Optional[str]) -> "Transport":
        other = Transport.__new__(Transport)
        other.__dict__.update(self.__dict__)
        other.token = token
        other._local = threading.local()
        return other

    # -- connections ----------------------------------------------------------------------

    def _connection(self) -> http.client.HTTPConnection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            cls = (
                http.client.HTTPSConnection
                if self._scheme == "https"
                else http.client.HTTPConnection
            )
            conn = cls(self._netloc, timeout=self.timeout)
            self._local.conn = conn
            self._local.used = False
        return conn

    def _drop_connection(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
        self._local.conn = None

    def close(self) -> None:
        self._drop_connection()

    def _send_once(
        self, method: str, target: str, body: Optional[bytes], headers: Dict[str, str]
    ) -> Response:
        # A kept-alive connection the server has since closed fails on first use; that
        # request was never read, so it is sent again once on a fresh connection.
        for fresh_attempt in (False, True):
            conn = self._connection()
            reused = getattr(self._local, "used", False)
            try:
                conn.request(method, target, body=body, headers=headers)
                resp = conn.getresponse()
                data = resp.read()
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError):
                self._drop_connection()
                if reused and not fresh_attempt:
                    continue
                raise
            except Exception:
                self._drop_connection()
                raise
            self._local.used = True
            if resp.will_close:
                self._drop_connection()
            return Response(resp.status, dict(resp.getheaders()), data)
        raise AssertionError("unreachable")

    # -- requests -------------------------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        ok: Tuple[int, ...] = (),
        auth: bool = True,
    ) -> Response:
        """Send one request, retrying as described in the README; raise ``ApiError``."""
        method = method.upper()
        target = self._prefix + path
        if params:
            query = {k: _query_value(v) for k, v in params.items() if v is not None}
            if query:
                target += "?" + urllib.parse.urlencode(query)
        send_headers = {"User-Agent": self.user_agent, "Accept": "application/json"}
        if auth and self.token:
            send_headers["Authorization"] = f"Bearer {self.token}"
        body = None
        if json_body is not None:
            body = json.dumps(json_body).encode()
            send_headers["Content-Type"] = "application/json"
        elif method in ("POST", "PUT", "PATCH"):
            body = b""
        if headers:
            send_headers.update(headers)

        attempt = 0
        while True:
            try:
                resp = self._send_once(method, target, body, send_headers)
            except (OSError, http.client.HTTPException) as exc:
                if method in IDEMPOTENT and attempt < self.max_retries:
                    self._sleep(self._delay(attempt, None))
                    attempt += 1
                    continue
                raise ConnectionFailed(f"{method} {self.base_url}{path}: {exc}") from exc
            if resp.status < 400 or resp.status in ok:
                return resp
            err = self._error(resp, method, path)
            retryable = resp.status in ALWAYS_RETRY or (
                resp.status in IDEMPOTENT_RETRY and method in IDEMPOTENT
            )
            if (
                not retryable
                or attempt >= self.max_retries
                or (err.retry_after is not None and err.retry_after > self.max_retry_after)
            ):
                raise err
            self._sleep(self._delay(attempt, err.retry_after))
            attempt += 1

    def _delay(self, attempt: int, retry_after: Optional[float]) -> float:
        if retry_after is not None:
            return retry_after
        return min(self.max_backoff, self.backoff * (2**attempt)) * random.uniform(0.5, 1.0)

    @staticmethod
    def _error(resp: Response, method: str, path: str) -> ApiError:
        retry_after = parse_retry_after(resp.headers.get("retry-after"))
        code, message, parsed = f"http_{resp.status}", "", None
        try:
            parsed = resp.json()
        except ValueError:
            parsed = None
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
            code = str(parsed["error"].get("code") or code)
            message = str(parsed["error"].get("message") or "")
        else:
            text = resp.body.decode("utf-8", "replace").strip()
            message = text[:300] or http.client.responses.get(resp.status, "")
            if "error code: 1010" in text:
                message += " (Cloudflare refused the client's User-Agent)"
        return error_for(
            resp.status,
            code,
            message,
            method=method,
            path=path,
            retry_after=retry_after,
            body=parsed if parsed is not None else resp.body,
        )


def _query_value(value: Any) -> str:
    if value is True:
        return "1"
    if value is False:
        return "0"
    return str(value)
