"""A client for the hosted ComputerWorld API (https://computaco.ai/v1).

    from computerworld_cloud import Client

    client = Client()                      # COMPUTERWORLD_API_KEY, COMPUTERWORLD_API_BASE
    with client.create_simulation("agent-desktop", seed=1) as simulation:
        agent = simulation.agent()
        agent.click(interaction="shell:launch:editor")
        agent.render().save("screen.png")
"""

__version__ = "0.3.0"

from .client import (  # noqa: E402
    DEFAULT_BASE_URL,
    ActionFailed,
    Agent,
    Browser,
    BrowserSession,
    Client,
    Simulation,
    Frame,
    Screenshot,
    Society,
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
    "Agent",
    "ApiError",
    "AuthenticationError",
    "Browser",
    "BrowserSession",
    "Client",
    "ComputerWorldError",
    "ConflictError",
    "ConnectionFailed",
    "ElementNotFound",
    "Simulation",
    "Frame",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "Screenshot",
    "ServerError",
    "Society",
    "center",
    "find_element",
    "find_elements",
]
