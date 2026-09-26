"""Internal team meeting: status updates, blockers and risks."""

from pydantic import BaseModel, Field

from .base import Items, SummaryType, bullets, section


class MeetingDetails(BaseModel):
    status_updates: Items = Field(description="Статусы по проектам и задачам: что сделано, "
                                              "что в работе")
    blockers: Items = Field(description="Что блокирует работу и чья помощь нужна")
    risks: Items = Field(description="Риски для сроков, качества, бюджета")


def render(d: MeetingDetails, timestamps: bool = True) -> list[str]:
    return (section("Статус", bullets(d.status_updates))
            + section("Блокеры и риски", bullets(d.blockers + d.risks)))


TYPE = SummaryType(
    id="meeting",
    label="Совещание",
    description="внутренняя встреча команды: статусы, планирование, обсуждение решений, "
                "распределение задач",
    details=MeetingDetails,
    render_details=render,
)
