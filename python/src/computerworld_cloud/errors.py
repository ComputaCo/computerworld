"""Errors the client raises."""

from __future__ import annotations

from typing import Any, Optional


class ComputerWorldError(Exception):
    """Base class of everything this package raises."""


class ApiError(ComputerWorldError):
    """The API answered with an error.

    ``code`` is the API's error code (``not_found``, ``rate_limited``, ``invalid_world``, ...),
    or ``http_<status>`` when the answer was not the API's JSON error (for instance a
    Cloudflare page in front of it). ``retry_after`` is the ``Retry-After`` header in
    seconds, when one was sent.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        method: str = "",
        path: str = "",
        retry_after: Optional[float] = None,
        body: Any = None,
    ) -> None:
        self.status = status
        self.code = code
        self.message = message
        self.method = method
        self.path = path
        self.retry_after = retry_after
        self.body = body
        where = f" ({method} {path})" if method else ""
        super().__init__(f"{status} {code}: {message}{where}")


class AuthenticationError(ApiError):
    """401: no credential, or one that is not valid."""


class PermissionDeniedError(ApiError):
    """403: the credential may not do this (an actor token outside its environment)."""


class NotFoundError(ApiError):
    """404: no such route or resource (another account's world is also a 404)."""


class ConflictError(ApiError):
    """409."""


class RateLimitError(ApiError):
    """429: ``rate_limited`` or ``quota_exceeded``; see ``retry_after``."""


class ServerError(ApiError):
    """5xx."""


class ConnectionFailed(ComputerWorldError):
    """The request never got an answer (DNS, TCP, TLS or a timeout)."""


class ElementNotFound(ComputerWorldError, LookupError):
    """No element of the scene matched a ``find``."""


_BY_STATUS = {
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    429: RateLimitError,
}


def error_for(status: int, *args: Any, **kwargs: Any) -> ApiError:
    cls = _BY_STATUS.get(status) or (ServerError if status >= 500 else ApiError)
    return cls(status, *args, **kwargs)
