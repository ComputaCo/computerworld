"""A client for the hosted ComputerWorld API (https://computaco.ai/v1).

    from computerworld_cloud import Client

    client = Client()                      # COMPUTERWORLD_API_KEY, COMPUTERWORLD_API_BASE
    with client.create_world("agent-desktop", seed=1) as world:
        env = world.environment()
        env.click(interaction="shell:launch:editor")
        env.render().save("screen.png")
"""

__version__ = "0.1.0"

from .client import (  # noqa: E402
    DEFAULT_BASE_URL,
    ActionFailed,
    Client,
    Environment,
    Frame,
    Swarm,
    World,
)
from .errors import (  # noqa: E402
    ApiError,
    AuthenticationError,
    ComputerWorldError,
    ConflictError,
    ConnectionFailed,
    ElementNotFound,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    ServerError,
)
from .scene import center, find_element, find_elements  # noqa: E402

__all__ = [
    "DEFAULT_BASE_URL",
    "ActionFailed",
    "ApiError",
    "AuthenticationError",
    "Client",
    "ComputerWorldError",
    "ConflictError",
    "ConnectionFailed",
    "ElementNotFound",
    "Environment",
    "Frame",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "ServerError",
    "Swarm",
    "World",
    "center",
    "find_element",
    "find_elements",
]
