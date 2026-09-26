"""One-on-one between a manager and an employee: wins, challenges, feedback, growth."""

from pydantic import BaseModel, Field

from .base import Items, SummaryType, bullets, section


class OneOnOneDetails(BaseModel):
    wins: Items = Field(description="Что получилось у сотрудника с прошлой встречи")
    challenges: Items = Field(description="С чем сложно, где нужна помощь")
    workload: Items = Field(description="Нагрузка и самочувствие — только то, что сотрудник "
                                        "сказал о себе")
    feedback_to_employee: Items = Field(description="Обратная связь руководителя сотруднику")
    feedback_to_manager: Items = Field(description="Обратная связь сотрудника руководителю, "
                                                   "команде, процессам")
    growth: Items = Field(description="Развитие и карьера: цели, навыки, интересы")
    next_time: Items = Field(description="Темы и вопросы на следующую встречу")


def render(d: OneOnOneDetails, timestamps: bool = True) -> list[str]:
    lines = []
    for title, items in [
        ("Успехи", d.wins),
        ("Сложности", d.challenges),
        ("Нагрузка и самочувствие", d.workload),
        ("Обратная связь сотруднику", d.feedback_to_employee),
        ("Обратная связь руководителю", d.feedback_to_manager),
        ("Развитие", d.growth),
        ("На следующую встречу", d.next_time),
    ]:
        lines += section(title, bullets(items))
    return lines


TYPE = SummaryType(
    id="one_on_one",
    label="Один на один",
    description="регулярная встреча руководителя и сотрудника один на один: прогресс, "
                "сложности, обратная связь, нагрузка, развитие",
    details=OneOnOneDetails,
    render_details=render,
    sides=("руководитель", "сотрудник"),
)
