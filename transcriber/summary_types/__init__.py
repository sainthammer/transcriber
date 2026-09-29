"""Summary types ("skills"): shared schema and rules plus one module and prompt per type.

Adding a built-in type: create <id>.py with a SummaryType named TYPE and <id>.md with its
rules, then register it in TYPES below. Admins can also define types without code
(custom.py) and override prompts; the web server builds a Registry with those, the CLI
uses DEFAULT_REGISTRY.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import client, freeform, highlights, interview, meeting, one_on_one
from .base import NONE, SummaryBase, SummaryType, bullets, cell, section, transcript_duration

TYPES: dict[str, SummaryType] = {
    t.id: t for t in (client.TYPE, meeting.TYPE, interview.TYPE, one_on_one.TYPE, highlights.TYPE,
                     freeform.TYPE)
}
BASE_PROMPT = (Path(__file__).parent / "base.md").read_text(encoding="utf-8")
# highlights is the catch-all type (no strict structure), so it's also the fallback
# when classification fails or returns something unknown.
FALLBACK_TYPE = "highlights"

__all__ = ["BASE_PROMPT", "DEFAULT_REGISTRY", "Registry", "SummaryBase", "SummaryType", "TYPES",
           "parse_summary", "render_digest", "render_markdown", "strip_empty_sections",
           "transcript_duration"]


@dataclass(frozen=True)
class Registry:
    """The summary types available for a request and the shared rules prepended to each prompt.

    `types` includes disabled ones: stored summaries of a disabled type must still parse
    and render; `enabled` is what's offered for new summaries and to the classifier.
    """

    types: dict[str, SummaryType]
    base_prompt: str = BASE_PROMPT
    disabled: frozenset[str] = field(default_factory=frozenset)

    @property
    def enabled(self) -> dict[str, SummaryType]:
        return {k: t for k, t in self.types.items() if k not in self.disabled}

    @property
    def fallback(self) -> str:
        """Type used when classification fails."""
        enabled = self.enabled
        return FALLBACK_TYPE if FALLBACK_TYPE in enabled else next(iter(enabled))

    def get(self, type_id: str) -> SummaryType:
        try:
            return self.types[type_id]
        except KeyError:
            raise ValueError(f"Неизвестный тип summary: {type_id}") from None

    def system_prompt(self, type_id: str) -> str:
        return f"{self.base_prompt}\n{self.get(type_id).prompt}"

    def parse(self, data: dict | str) -> SummaryBase:
        """Validate a stored summary of any type (dispatches on meeting_type)."""
        if isinstance(data, str):
            data = json.loads(data)
        return self.get(data.get("meeting_type", "")).model.model_validate(data)

    def render_markdown(self, s: SummaryBase, duration: str | None = None,
                        timestamps: bool = True) -> str:
        """`timestamps=False` drops every `[ЧЧ:ММ:СС]` for a print-friendly export
        (docx download) — the web UI still gets them from the structured summary."""
        t = self.get(s.meeting_type)
        meta = [f"**Тип:** {t.label}"]
        if duration:
            meta.append(f"**Длительность:** {duration}")
        lines = [f"# {s.title}", "", " · ".join(meta), ""]

        lines += section("Кратко", [s.tldr])
        if t.render_lead:
            lines += t.render_lead(s.details)

        participants = []
        for p in s.participants:
            line = f"- **{p.name}** — {p.role}" if p.name else f"- {p.role[:1].upper()}{p.role[1:]}"
            side = getattr(p, "side", "не определено")
            participants.append(line + (f" _({side})_" if side != "не определено" else ""))
        lines += section("Участники", participants or [NONE])

        if s.key_figures:
            table = ["| Показатель | Значение |", "|---|---|"]
            table += [f"| {cell(f.context)} | {cell(f.value)} |" for f in s.key_figures]
            lines += section("Ключевые цифры", table)

        lines += t.render_details(s.details, timestamps)

        ts = (lambda v: f" `{v}`") if timestamps else (lambda v: "")
        lines += section("Решения", [f"- {d.text}{ts(d.timestamp)}" for d in s.decisions] or [NONE])

        if s.action_items:
            table = ["| # | Задача | Ответственный | Срок |", "|---|---|---|---|"]
            table += [
                f"| {n} | {cell(a.task)}{ts(a.timestamp)} | {cell(a.owner)} | {cell(a.due)} |"
                for n, a in enumerate(s.action_items, 1)
            ]
            lines += section("Задачи", table)
        else:
            lines += section("Задачи", [NONE])

        lines += section("Открытые вопросы", bullets(s.open_questions))

        if s.topics:
            lines += ["---", "", "## Ход обсуждения", ""]
            for topic in s.topics:
                title = f"`{topic.timestamp}` {topic.title}" if timestamps else topic.title
                lines += section(title, bullets(topic.points), level=3)

        return "\n".join(lines).rstrip() + "\n"

    def render_digest(self, s: SummaryBase, duration: str | None = None) -> str:
        """Condensed print/share version: тезисы, решения и задачи only — no timestamps,
        no chronological discussion, no type-specific deep dive. Meant for a one-page
        handout, not a replacement for the full summary."""
        t = self.get(s.meeting_type)
        meta = [f"**Тип:** {t.label}"]
        if duration:
            meta.append(f"**Длительность:** {duration}")
        lines = [f"# {s.title}", "", " · ".join(meta), ""]

        lines += section("Кратко", [s.tldr])
        lines += section("Решения", bullets([d.text for d in s.decisions]))

        if s.action_items:
            lines += section("Задачи", [
                "- " + a.task
                + (f" — {a.owner}" if a.owner else "")
                + (f" _(срок: {a.due})_" if a.due else "")
                for a in s.action_items
            ])
        else:
            lines += section("Задачи", [NONE])

        if s.key_figures:
            lines += section("Ключевые цифры",
                             [f"- **{f.value}** — {f.context}" for f in s.key_figures])

        return "\n".join(lines).rstrip() + "\n"


_HEADING = re.compile(r"^(#{1,3}) ")


def strip_empty_sections(md: str) -> str:
    """Drop a heading (any level, `#`-`###`) whose body is empty or just the `NONE`
    placeholder — deepest headings first, so a section left with nothing after its own
    empty subsections were dropped is dropped in turn (e.g. all of a client meeting's
    subsections empty removes the "Клиент" heading too).

    For print/share docx downloads: a page full of "Не зафиксировано" reads as noise,
    not as reassurance that the model checked. The stored .md/.json and the web UI keep
    the placeholders — they're not going on paper.
    """
    lines = md.split("\n")
    for level in (3, 2, 1):
        out: list[str] = []
        i = 0
        while i < len(lines):
            heading = _HEADING.match(lines[i])
            if heading and len(heading[1]) == level:
                j = i + 1
                while j < len(lines):
                    below = _HEADING.match(lines[j])
                    if below and len(below[1]) <= level:
                        break
                    j += 1
                # A trailing `---` (the break before "Ход обсуждения") belongs to the
                # next section: it neither fills this one nor goes away with it.
                end = j
                while end > i + 1 and lines[end - 1].strip() in ("", "---"):
                    end -= 1
                body = [line for line in lines[i + 1:end] if line.strip()]
                if not body or body == [NONE]:
                    i = end
                    continue
            out.append(lines[i])
            i += 1
        lines = out
    return "\n".join(lines)


DEFAULT_REGISTRY = Registry(TYPES)


def parse_summary(data: dict | str) -> SummaryBase:
    return DEFAULT_REGISTRY.parse(data)


def render_markdown(s: SummaryBase, duration: str | None = None, timestamps: bool = True) -> str:
    return DEFAULT_REGISTRY.render_markdown(s, duration, timestamps)


def render_digest(s: SummaryBase, duration: str | None = None) -> str:
    return DEFAULT_REGISTRY.render_digest(s, duration)
