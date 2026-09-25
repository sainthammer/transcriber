"""Meeting summary schema and deterministic Markdown rendering."""

import re
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

PROMPT_PATH = Path(__file__).parent / "prompts" / "meeting_summary.md"

# [0-9] rather than \d: Ollama's schema-to-grammar converter doesn't support \d and
# silently drops the whole pattern, leaving timestamps unconstrained during generation.
Timestamp = Annotated[str, Field(pattern=r"^[0-9]{2}:[0-9]{2}:[0-9]{2}$",
                                 description="Таймкод ЧЧ:ММ:СС из расшифровки")]
Items = Annotated[list[str], Field(description="Пункты; пустой список, если нечего сказать")]


class Participant(BaseModel):
    name: str | None = Field(description="Имя, если прозвучало, иначе null")
    role: str = Field(description="Роль или должность по смыслу реплик")
    side: Literal["наша сторона", "клиент", "не определено"] = Field(
        description="Для внутренних созвонов — «наша сторона»")


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


class ClientInsights(BaseModel):
    needs: Items = Field(description="Что хочет получить клиент, какую задачу решает")
    pains: Items = Field(description="Текущие проблемы и ограничения клиента")
    objections: Items = Field(description="Сомнения, возражения, опасения клиента")
    budget_and_timeline: Items = Field(description="Бюджет, стоимость, сроки, если обсуждались")
    decision_process: Items = Field(description="Кто и как принимает решение, этапы согласования")
    deal_risks: Items = Field(description="Что может помешать сделке или проекту")


class InternalInsights(BaseModel):
    status_updates: Items = Field(description="Статусы по проектам и задачам")
    blockers: Items = Field(description="Что блокирует работу, кому нужна помощь")
    risks: Items = Field(description="Риски для сроков, качества, бюджета")


class MeetingSummary(BaseModel):
    meeting_type: Literal["client", "internal"]
    title: str = Field(description="Название встречи по сути, до 10 слов")
    tldr: str = Field(description="2–4 предложения: о чём встреча, главный итог, что дальше")
    participants: list[Participant]
    key_figures: list[Figure]
    topics: list[Topic] = Field(description="4–10 тем в хронологическом порядке")
    decisions: list[Decision]
    action_items: list[ActionItem]
    open_questions: Items
    client: ClientInsights | None = Field(description="Только для meeting_type=client")
    internal: InternalInsights | None = Field(description="Только для meeting_type=internal")

    @model_validator(mode="after")
    def _drop_other_type_block(self):
        # Small models sometimes fill both blocks; keep only the one matching the type.
        if self.meeting_type == "client":
            self.internal = None
        else:
            self.client = None
        return self


def system_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def transcript_duration(transcript: str) -> str | None:
    stamps = re.findall(r"^\[(\d{2}):(\d{2}):(\d{2})\]", transcript, re.MULTILINE)
    if not stamps:
        return None
    h, m, s = map(int, stamps[-1])
    minutes = round((h * 3600 + m * 60 + s) / 60)
    return f"~{minutes // 60} ч {minutes % 60} мин" if minutes >= 60 else f"~{minutes} мин"


# --- Markdown rendering ---

MEETING_TYPES = {"client": "Встреча с клиентом", "internal": "Внутренний созвон"}
NONE = "_Не зафиксировано_"


def _bullets(items: list[str]) -> list[str]:
    return [f"- {item}" for item in items] or [NONE]


def _cell(text: str | None) -> str:
    return (text or "—").replace("|", "\\|").replace("\n", " ")


def _section(title: str, body: list[str], level: int = 2) -> list[str]:
    return [f"{'#' * level} {title}", "", *body, ""]


def render_markdown(s: MeetingSummary, duration: str | None = None) -> str:
    meta = [f"**Тип:** {MEETING_TYPES[s.meeting_type]}"]
    if duration:
        meta.append(f"**Длительность:** {duration}")
    lines = [f"# {s.title}", "", " · ".join(meta), ""]

    lines += _section("Кратко", [s.tldr])

    participants = [
        f"- **{p.name}** — {p.role}" if p.name else f"- {p.role[:1].upper()}{p.role[1:]}"
        for p in s.participants
    ]
    if s.meeting_type == "client":
        participants = [
            line + (f" _({p.side})_" if p.side != "не определено" else "")
            for line, p in zip(participants, s.participants)
        ]
    lines += _section("Участники", participants or [NONE])

    if s.key_figures:
        table = ["| Показатель | Значение |", "|---|---|"]
        table += [f"| {_cell(f.context)} | {_cell(f.value)} |" for f in s.key_figures]
        lines += _section("Ключевые цифры", table)

    if s.meeting_type == "client" and s.client:
        c = s.client
        lines += ["## Клиент", ""]
        for title, items in [
            ("Потребности", c.needs),
            ("Текущие проблемы", c.pains),
            ("Возражения и опасения", c.objections),
            ("Бюджет и сроки", c.budget_and_timeline),
            ("Процесс принятия решения", c.decision_process),
            ("Риски сделки", c.deal_risks),
        ]:
            lines += _section(title, _bullets(items), level=3)

    if s.meeting_type == "internal" and s.internal:
        i = s.internal
        lines += _section("Статус", _bullets(i.status_updates))
        lines += _section("Блокеры и риски", _bullets(i.blockers + i.risks))

    lines += _section("Решения", [f"- {d.text} `{d.timestamp}`" for d in s.decisions] or [NONE])

    if s.action_items:
        table = ["| # | Задача | Ответственный | Срок |", "|---|---|---|---|"]
        table += [
            f"| {n} | {_cell(a.task)} `{a.timestamp}` | {_cell(a.owner)} | {_cell(a.due)} |"
            for n, a in enumerate(s.action_items, 1)
        ]
        lines += _section("Задачи", table)
    else:
        lines += _section("Задачи", [NONE])

    lines += _section("Открытые вопросы", _bullets(s.open_questions))

    lines += ["---", "", "## Ход обсуждения", ""]
    for t in s.topics:
        lines += _section(f"`{t.timestamp}` {t.title}", _bullets(t.points), level=3)

    return "\n".join(lines).rstrip() + "\n"
