"""Finding elements in a scene (``GET .../scene?elements=1``)."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Pattern, Union

from .errors import ElementNotFound

Matcher = Union[str, Pattern[str], None]
Element = Dict[str, Any]


def _matches(value: Any, want: Matcher) -> bool:
    if want is None:
        return True
    if value is None:
        return False
    if isinstance(want, re.Pattern):
        return want.search(str(value)) is not None
    return str(value) == want


def find_elements(
    scene: Dict[str, Any],
    *,
    label: Matcher = None,
    role: Matcher = None,
    interaction: Matcher = None,
    value: Matcher = None,
    include_disabled: bool = False,
) -> List[Element]:
    """Every element matching all the given fields, front first, as the scene lists them.

    A string matches exactly; a compiled ``re`` pattern matches by ``search``. Disabled
    elements are left out unless ``include_disabled``.
    """
    elements = scene.get("elements")
    if elements is None:
        raise ValueError("the scene has no elements; ask for it with elements=True")
    return [
        e
        for e in elements
        if (include_disabled or not e.get("disabled"))
        and _matches(e.get("label"), label)
        and _matches(e.get("role"), role)
        and _matches(e.get("interaction"), interaction)
        and _matches(e.get("value"), value)
    ]


def find_element(
    scene: Dict[str, Any],
    *,
    label: Matcher = None,
    role: Matcher = None,
    interaction: Matcher = None,
    value: Matcher = None,
    index: int = 0,
    include_disabled: bool = False,
) -> Element:
    """The ``index``-th match of :func:`find_elements` (the frontmost by default)."""
    found = find_elements(
        scene,
        label=label,
        role=role,
        interaction=interaction,
        value=value,
        include_disabled=include_disabled,
    )
    if index < len(found):
        return found[index]
    want = {
        k: (v.pattern if isinstance(v, re.Pattern) else v)
        for k, v in (("label", label), ("role", role), ("interaction", interaction), ("value", value))
        if v is not None
    }
    seen = sorted(
        {f"{e.get('role')}:{e.get('label')}" for e in scene.get("elements") or []}
    )[:20]
    raise ElementNotFound(
        f"no element matches {want} (found {len(found)}, wanted index {index}); "
        f"on screen: {', '.join(seen) or 'nothing interactive'}"
    )


def center(element: Element) -> "tuple[int, int]":
    """The element's centre in screen pixels."""
    c: Optional[List[int]] = element.get("center")
    if c:
        return int(c[0]), int(c[1])
    r = element["rect"]
    return int(r["x"] + r["width"] // 2), int(r["y"] + r["height"] // 2)
