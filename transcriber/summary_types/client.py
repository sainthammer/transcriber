"""Client meeting: needs, pains, objections, budget, decision process, deal risks."""

from pydantic import BaseModel, Field

from .base import Items, SummaryType, bullets, section


class ClientDetails(BaseModel):
    needs: Items = Field(description="Что хочет получить клиент, какую задачу решает")
    pains: Items = Field(description="Текущие проблемы и ограничения клиента")
    objections: Items = Field(description="Сомнения, возражения, опасения клиента")
    budget_and_timeline: Items = Field(description="Бюджет, стоимость, сроки, если обсуждались")
    decision_process: Items = Field(description="Кто и как принимает решение, этапы согласования")
    deal_risks: Items = Field(description="Что может помешать сделке или проекту")


def render(d: ClientDetails, timestamps: bool = True) -> list[str]:
    lines = ["## Клиент", ""]
    for title, items in [
        ("Потребности", d.needs),
        ("Текущие проблемы", d.pains),
        ("Возражения и опасения", d.objections),
        ("Бюджет и сроки", d.budget_and_timeline),
        ("Процесс принятия решения", d.decision_process),
        ("Риски сделки", d.deal_risks),
    ]:
        lines += section(title, bullets(items), level=3)
    return lines


TYPE = SummaryType(
    id="client",
    label="Встреча с клиентом",
    description="встреча с внешним клиентом, заказчиком или партнёром: потребности, "
                "предложение, условия, цена, договор",
    details=ClientDetails,
    render_details=render,
    sides=("наша сторона", "клиент"),
)
