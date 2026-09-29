"""Free-form summary: the model picks its own sections (titles and content) for the recording.

Freedom is in the content, not the format: details is still a fixed schema (a list of
sections with paragraphs and points), so constrained generation works in Ollama and the
Markdown stays within what docx_export understands (`##`, plain paragraphs, `- `).
"""

import re

from pydantic import BaseModel, Field, field_validator, model_validator

from .base import SummaryType, section

# Markdown a model tends to put inside strings despite the prompt: headings, list markers,
# numbering, quotes. Left in place they'd turn into stray headings/tables in the docx.
_MARKER = re.compile(r"^(?:#{1,6}\s+|[-*•–]\s+|\d{1,2}[.)]\s+|>\s*|\|\s*)+")
_BULLET = re.compile(r"^\s*(?:[-*•–]|\d{1,2}[.)])\s+")


def _clean(text: str) -> str:
    text = _MARKER.sub("", text.strip()).strip()
    return "" if set(text) <= set("-*_=|") else text  # a bare "---" / "***" rule


class FreeformSection(BaseModel):
    title: str = Field(description="Заголовок раздела по его содержанию, 2–6 слов")
    paragraphs: list[str] = Field(description="Связный текст раздела: абзацы по 2–4 "
                                              "предложения, без разметки; пустой список, "
                                              "если в разделе только пункты")
    points: list[str] = Field(description="Пункты списка, каждый — одна мысль, без "
                                          "маркеров и нумерации; пустой список, если "
                                          "в разделе только текст")

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        return _clean(" ".join(v.split())).strip("*_: ")

    @model_validator(mode="after")
    def _normalize(self) -> "FreeformSection":
        # One string per paragraph/point: a paragraph with embedded "\n- …" lines becomes
        # a paragraph plus points, so the Markdown never carries model-made list syntax.
        paragraphs, moved = [], []
        for text in self.paragraphs:
            for line in text.splitlines():
                target = moved if _BULLET.match(line) else paragraphs
                if cleaned := _clean(line):
                    target.append(cleaned)
        points = [c for text in self.points for line in text.splitlines() if (c := _clean(line))]
        self.paragraphs, self.points = paragraphs, moved + points
        return self


class FreeformDetails(BaseModel):
    sections: list[FreeformSection] = Field(description="Разделы, выбранные по содержанию "
                                                        "записи, в порядке от главного "
                                                        "или по логике изложения")

    @field_validator("sections")
    @classmethod
    def _drop_empty(cls, v: list[FreeformSection]) -> list[FreeformSection]:
        return [s for s in v if s.paragraphs or s.points]


def render(d: FreeformDetails, timestamps: bool = True) -> list[str]:
    lines = []
    for s in d.sections:
        body = [line for p in s.paragraphs for line in (p, "")]
        body += [f"- {p}" for p in s.points]
        lines += section(s.title or "Без названия", body[:-1] if not s.points else body)
    return lines


TYPE = SummaryType(
    id="freeform",
    label="Свободный формат",
    description="запись со своей логикой содержания, которую не описать заранее "
                "заданными разделами: лекция, вебинар, подкаст, разбор темы, консультация, "
                "свободный разговор",
    details=FreeformDetails,
    render_details=render,
)
