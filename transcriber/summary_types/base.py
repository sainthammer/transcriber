"""Shared summary schema, the SummaryType definition and Markdown helpers."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, Field, create_model

# [0-9] rather than \d: Ollama's schema-to-grammar converter doesn't support \d and
# silently drops the whole pattern, leaving timestamps unconstrained during generation.
Timestamp = Annotated[str, Field(pattern=r"^[0-9]{2}:[0-9]{2}:[0-9]{2}$",
                                 description="Таймкод ЧЧ:ММ:СС из расшифровки")]
Items = Annotated[list[str], Field(description="Пункты; пустой список, если нечего сказать")]


class Participant(BaseModel):
    name: str | None = Field(description="Имя, только если прозвучало в записи дословно, "
                                         "иначе null — не выводи из обращения на «вы»/«ты»")
    role: str = Field(description="Точная должность, если прозвучала целиком, иначе — роль "
                                  "по смыслу реплик; не выдумывай должность, которой не было")


class Figure(BaseModel):
    value: str = Field(description="Значение с единицами: «1,5 млн руб.», «100 заявок в день»")
    context: str = Field(description="К чему относится")


class Topic(BaseModel):
    timestamp: Timestamp
    title: str = Field(description="Название темы, 2–6 слов")
    points: list[str] = Field(description="2–5 пунктов по сути обсуждения")


class Decision(BaseModel):
    timestamp: Timestamp
    text: str


class ActionItem(BaseModel):
    timestamp: Timestamp
    task: str = Field(description="Действие с глагола в инфинитиве")
    owner: str | None = Field(description="Ответственный, если прозвучал, иначе null")
    due: str | None = Field(description="Срок, если прозвучал, иначе null")


class SummaryBase(BaseModel):
    """Fields every summary type has; each type adds `details` and narrows `meeting_type`."""

    meeting_type: str
    title: str = Field(description="Название встречи по сути, до 10 слов")
    tldr: str = Field(description="2–4 предложения: о чём встреча, главный итог, что дальше")
    participants: list[Participant]
    key_figures: list[Figure]
    topics: list[Topic] = Field(description="4–10 тем в хронологическом порядке")
    decisions: list[Decision]
    action_items: list[ActionItem]
    open_questions: Items


@dataclass(frozen=True)
class SummaryType:
    """A summary "skill": prompt (<id>.md next to the module), details schema and rendering."""

    id: str
    label: str
    description: str  # what the recording is; shown in the UI and used by the classifier
    details: type[BaseModel]
    # `timestamps=False` for print-friendly exports (docx digest/full-without-timings);
    # most types ignore it, only interview's competency table embeds a timestamp.
    render_details: Callable[[BaseModel, bool], list[str]]
    sides: tuple[str, ...] = ()  # participant sides, e.g. ("интервьюер", "кандидат")
    render_lead: Callable[[BaseModel], list[str]] | None = None  # right after «Кратко»
    # Deterministic post-processing of a validated summary (e.g. dropping content the
    # prompt forbids but a small model may still produce). Returns the cleaned summary
    # and the number of removed fragments.
    sanitize: Callable[[SummaryBase], tuple[SummaryBase, int]] | None = None
    builtin: bool = True  # False for types defined by an admin (see custom.py)
    prompt_text: str | None = None  # overrides the <id>.md prompt of a built-in type

    @property
    def default_prompt(self) -> str | None:
        if not self.builtin:
            return None
        return (Path(__file__).parent / f"{self.id}.md").read_text(encoding="utf-8")

    @property
    def prompt(self) -> str:
        return self.prompt_text if self.prompt_text is not None else self.default_prompt or ""

    @cached_property
    def model(self) -> type[SummaryBase]:
        participant = Participant
        if self.sides:
            participant = create_model(
                f"{self.id.title().replace('_', '')}Participant", __base__=Participant,
                side=(Literal[(*self.sides, "не определено")], Field(description="Сторона")))
        return create_model(
            f"{self.id.title().replace('_', '')}Summary", __base__=SummaryBase,
            meeting_type=(Literal[self.id], ...),
            participants=(list[participant], ...),
            details=(self.details, ...),
        )


def transcript_duration(transcript: str) -> str | None:
    stamps = re.findall(r"^\[(\d{2}):(\d{2}):(\d{2})\]", transcript, re.MULTILINE)
    if not stamps:
        return None
    h, m, s = map(int, stamps[-1])
    minutes = round((h * 3600 + m * 60 + s) / 60)
    return f"~{minutes // 60} ч {minutes % 60} мин" if minutes >= 60 else f"~{minutes} мин"


# --- Markdown helpers ---

NONE = "_Не зафиксировано_"


def bullets(items: list[str]) -> list[str]:
    return [f"- {item}" for item in items] or [NONE]


def cell(text: str | None) -> str:
    return (text or "—").replace("|", "\\|").replace("\n", " ")


def section(title: str, body: list[str], level: int = 2) -> list[str]:
    return [f"{'#' * level} {title}", "", *body, ""]
