"""Job interview: experience, competencies, a preliminary assessment; no personal data."""

import re
from typing import Literal

from pydantic import BaseModel, Field

from .base import NONE, Items, SummaryBase, SummaryType, Timestamp, bullets, cell, section

NO_PERSONAL = " Без возраста, семьи, здоровья и других личных данных."


class Competency(BaseModel):
    name: str = Field(description="Навык или качество: «Python», «Проектирование API», "
                                  "«Работа с конфликтами»")
    assessment: Literal["сильная сторона", "достаточно", "есть сомнения", "не проверялось"]
    evidence: list[str] = Field(description="Факты из ответов кандидата, на которых "
                                            "основана оценка")
    timestamp: Timestamp


class Assessment(BaseModel):
    verdict: Literal["рекомендовать", "скорее да", "скорее нет", "не рекомендовать",
                     "недостаточно данных"]
    rationale: str = Field(description="1–2 предложения: на каких компетенциях "
                                       "и фактах основана оценка")


class InterviewDetails(BaseModel):
    position: str | None = Field(description="Вакансия, если прозвучала, иначе null")
    experience: Items = Field(description="Опыт кандидата по его словам: компании, роли, "
                                          "проекты, технологии, сроки." + NO_PERSONAL)
    competencies: list[Competency] = Field(description="3–8 компетенций, которые "
                                                       "проверялись в разговоре")
    strengths: Items = Field(description="Сильные стороны с опорой на ответы")
    concerns: Items = Field(description="Только профессиональные сомнения: пробелы в опыте, "
                                        "противоречия, слабые ответы." + NO_PERSONAL)
    motivation: Items = Field(description="Почему ищет работу, что важно в новом месте")
    expectations: Items = Field(description="Ожидания: зарплата, формат, сроки выхода, "
                                            "если прозвучали." + NO_PERSONAL)
    candidate_questions: Items = Field(description="Что спрашивал кандидат")
    # Last on purpose: the model generates fields in schema order, so the verdict is
    # written after the evidence it should be based on.
    assessment: Assessment


# Hiring decisions must not depend on these (and in Russia it's illegal: ТК РФ ст. 3, 64).
# The prompt forbids them, but the 4B local model still wrote down age and pregnancy
# plans — even listed pregnancy as a concern — so this is enforced in code as well.
PERSONAL = re.compile(
    r"возраст|\bлет от роду|беремен|декрет|ребён|ребен|\bдет(и|ей|ям|ьми|ях|ский)\b|"
    r"рожден|родин|\bмуж(а|у|ем|ом)?\b|\bжен(а|ы|у|ой)\b|семейн|\bсемь(я|и|ю|ёй|ей)\b|"
    r"здоровь|болезн|инвалид|национальн|вероисповед|религи|внешност",
    re.IGNORECASE,
)


def _clean_text(text: str) -> tuple[str, int]:
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    kept = [s for s in sentences if not PERSONAL.search(s)]
    return " ".join(kept), len(sentences) - len(kept)


def _clean(value) -> tuple[object, int]:
    """Recursively drop list items and sentences that mention personal characteristics."""
    if isinstance(value, str):
        return _clean_text(value)
    if isinstance(value, list):
        kept, removed = [], 0
        for item in value:
            if isinstance(item, str) and PERSONAL.search(item):
                removed += 1
                continue
            cleaned, n = _clean(item)
            kept.append(cleaned)
            removed += n
        return kept, removed
    if isinstance(value, dict):
        out, removed = {}, 0
        for key, item in value.items():
            out[key], n = _clean(item)
            removed += n
        return out, removed
    return value, 0


def sanitize(s: SummaryBase) -> tuple[SummaryBase, int]:
    data, removed = _clean(s.model_dump())
    return type(s).model_validate(data), removed


def render_lead(d: InterviewDetails) -> list[str]:
    a = d.assessment
    return section("Предварительная оценка", [
        f"**{a.verdict[:1].upper()}{a.verdict[1:]}.** {a.rationale}",
        "",
        "_Оценка составлена моделью по расшифровке и не заменяет решение интервьюера._",
    ])


def _join(evidence: list[str]) -> str:
    return "; ".join(e.rstrip(" .;") for e in evidence)


def render(d: InterviewDetails, timestamps: bool = True) -> list[str]:
    candidate = [f"**Вакансия:** {d.position}", ""] if d.position else []
    lines = section("Кандидат", candidate + bullets(d.experience))

    if d.competencies:
        table = ["| Компетенция | Оценка | Подтверждение |", "|---|---|---|"]
        table += [
            f"| {cell(c.name)} | {c.assessment} | {cell(_join(c.evidence))}"
            f"{f' `{c.timestamp}`' if timestamps else ''} |"
            for c in d.competencies
        ]
        lines += section("Компетенции", table)
    else:
        lines += section("Компетенции", [NONE])

    for title, items in [
        ("Сильные стороны", d.strengths),
        ("Сомнения", d.concerns),
        ("Мотивация", d.motivation),
        ("Ожидания и условия", d.expectations),
        ("Вопросы кандидата", d.candidate_questions),
    ]:
        lines += section(title, bullets(items))
    return lines


TYPE = SummaryType(
    id="interview",
    label="Собеседование",
    description="собеседование с кандидатом на вакансию: опыт, навыки, мотивация, условия",
    details=InterviewDetails,
    render_details=render,
    render_lead=render_lead,
    sanitize=sanitize,
    sides=("интервьюер", "кандидат"),
)
