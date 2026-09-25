import pytest
from pydantic import ValidationError

from transcriber.cli import fmt_time
from transcriber.meeting_summary import MeetingSummary, render_markdown, transcript_duration
from transcriber.summary import _parse


def make_summary(**overrides) -> MeetingSummary:
    data = {
        "meeting_type": "client",
        "title": "Пилот ИИ-аналитики",
        "tldr": "Договорились о тестовом прототипе.",
        "participants": [
            {"name": "Максим", "role": "ведущий специалист", "side": "наша сторона"},
            {"name": None, "role": "представитель клиента", "side": "клиент"},
        ],
        "key_figures": [{"value": "1,5 млн руб.", "context": "сервер | оборудование"}],
        "topics": [{"timestamp": "00:01:04", "title": "Требования", "points": ["Закрытый контур"]}],
        "decisions": [{"timestamp": "00:07:57", "text": "Начать с прототипа"}],
        "action_items": [
            {"timestamp": "00:09:39", "task": "Подготовить вопросы", "owner": None, "due": "среда"},
        ],
        "open_questions": [],
        "client": {
            "needs": ["Анализ заявок"], "pains": [], "objections": [],
            "budget_and_timeline": [], "decision_process": [], "deal_risks": [],
        },
        "internal": {"status_updates": ["x"], "blockers": [], "risks": []},
    }
    data.update(overrides)
    return MeetingSummary.model_validate(data)


def test_fmt_time():
    assert fmt_time(0) == "00:00:00"
    assert fmt_time(3661.9) == "01:01:01"


@pytest.mark.parametrize("transcript, expected", [
    ("[00:00:00] привет\n[00:34:49] пока\n", "~35 мин"),
    ("[01:04:30] конец\n", "~1 ч 4 мин"),
    ("без таймкодов", None),
])
def test_transcript_duration(transcript, expected):
    assert transcript_duration(transcript) == expected


def test_client_meeting_drops_internal_block():
    s = make_summary()
    assert s.client is not None
    assert s.internal is None


def test_internal_meeting_drops_client_block():
    s = make_summary(meeting_type="internal")
    assert s.client is None
    assert s.internal is not None


def test_invalid_timestamp_rejected():
    with pytest.raises(ValidationError):
        make_summary(decisions=[{"timestamp": "7:57", "text": "x"}])


def test_render_client_meeting():
    md = render_markdown(make_summary(), duration="~35 мин")

    sections = ["## Кратко", "## Участники", "## Ключевые цифры", "## Клиент",
                "## Решения", "## Задачи", "## Открытые вопросы", "## Ход обсуждения"]
    positions = [md.index(s) for s in sections]
    assert positions == sorted(positions), "sections are out of order"

    assert "**Тип:** Встреча с клиентом · **Длительность:** ~35 мин" in md
    assert "- **Максим** — ведущий специалист _(наша сторона)_" in md
    assert "- Представитель клиента _(клиент)_" in md
    assert "сервер \\| оборудование" in md  # pipes escaped inside table cells
    assert "| 1 | Подготовить вопросы `00:09:39` | — | среда |" in md
    assert "### `00:01:04` Требования" in md
    assert "## Статус" not in md


def test_render_internal_meeting_and_empty_sections():
    md = render_markdown(make_summary(meeting_type="internal", decisions=[], action_items=[]))

    assert "**Тип:** Внутренний созвон" in md
    assert "## Клиент" not in md
    assert "## Статус\n\n- x" in md
    assert "## Решения\n\n_Не зафиксировано_" in md
    assert "## Задачи\n\n_Не зафиксировано_" in md
    assert "_(наша сторона)_" not in md  # sides are shown only for client meetings


def test_parse_strips_code_fences():
    raw = "```json\n" + make_summary().model_dump_json() + "\n```"
    assert _parse(raw).title == "Пилот ИИ-аналитики"


def test_parse_rejects_truncated_json():
    with pytest.raises(ValidationError):
        _parse(make_summary().model_dump_json()[:100])
