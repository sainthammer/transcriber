"""Summary types defined by an admin: a prompt plus a list of free-form sections.

Each section becomes a list-of-strings field in `details` and a Markdown section with
its title, so no code is needed for a new type.
"""

import re
from dataclasses import dataclass

from pydantic import BaseModel, Field, create_model

from .base import Items, SummaryType, bullets, section

TYPE_ID = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
SECTION_KEY = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_SECTIONS = 12


@dataclass(frozen=True)
class Section:
    key: str
    title: str
    description: str = ""


def custom_type(type_id: str, label: str, description: str, prompt: str,
                sections: list[Section]) -> SummaryType:
    fields = {
        s.key: (Items, Field(description=f"{s.title}. {s.description}".strip(" .") + "."))
        for s in sections
    }
    details: type[BaseModel] = create_model(f"{type_id.title().replace('_', '')}Details", **fields)

    def render(d: BaseModel, timestamps: bool = True) -> list[str]:
        lines = []
        for s in sections:
            lines += section(s.title, bullets(getattr(d, s.key)))
        return lines

    return SummaryType(id=type_id, label=label, description=description, details=details,
                       render_details=render, builtin=False, prompt_text=prompt)
