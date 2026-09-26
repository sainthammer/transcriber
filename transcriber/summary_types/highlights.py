"""Catch-all type: key theses of a recording without a strict structure."""

from pydantic import BaseModel, Field

from .base import Items, SummaryType, bullets, section


class HighlightsDetails(BaseModel):
    theses: Items = Field(description="Главные самостоятельные мысли и выводы, каждая — "
                                      "небольшой абзац (2-4 предложения): вывод, "
                                      "обоснование или пример из записи, что это значит "
                                      "на практике. Не одна строка")


def render(d: HighlightsDetails, timestamps: bool = True) -> list[str]:
    return section("Тезисы", bullets(d.theses))


TYPE = SummaryType(
    id="highlights",
    label="Общие тезисы",
    description="запись, которая не подходит под другие типы: доклад, брифинг, звонок "
                "или обсуждение без строгой структуры участников и ролей",
    details=HighlightsDetails,
    render_details=render,
)
