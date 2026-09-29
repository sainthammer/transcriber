import json

import pytest
from pydantic import ValidationError

from transcriber import summary
from transcriber.cli import fmt_time
from transcriber.summary_types import (
    TYPES, parse_summary, render_digest, render_markdown, strip_empty_sections, transcript_duration,
)

DETAILS = {
    "client": {"needs": ["Анализ заявок"], "pains": [], "objections": [],
               "budget_and_timeline": [], "decision_process": [], "deal_risks": []},
    "meeting": {"status_updates": ["Релиз: в работе"], "blockers": [], "risks": []},
    "interview": {
        "position": "Backend-разработчик", "experience": ["5 лет в финтехе"],
        "competencies": [{"name": "Python", "assessment": "сильная сторона",
                          "evidence": ["Спроектировал сервис платежей"],
                          "timestamp": "00:05:00"}],
        "strengths": [], "concerns": [], "motivation": [], "expectations": [],
        "candidate_questions": [],
        "assessment": {"verdict": "скорее да", "rationale": "Сильный Python."},
    },
    "one_on_one": {"wins": ["Запустил дашборд"], "challenges": [], "workload": [],
                   "feedback_to_employee": [], "feedback_to_manager": [], "growth": [],
                   "next_time": []},
    "highlights": {"theses": ["Переход на новую CRM снизит время обработки заявки"]},
    "freeform": {"sections": [{"title": "Почему пилот, а не внедрение",
                               "paragraphs": ["Данные клиента нельзя выносить из контура."],
                               "points": ["Сервер в офисе", "Доступ по VPN"]}]},
}
SIDES = {"client": "клиент", "interview": "кандидат", "one_on_one": "сотрудник"}


def make_data(summary_type: str = "client", **overrides) -> dict:
    participant = {"name": "Максим", "role": "ведущий специалист"}
    if summary_type in SIDES:
        participant["side"] = SIDES[summary_type]
    data = {
        "meeting_type": summary_type,
        "title": "Пилот ИИ-аналитики",
        "tldr": "Договорились о тестовом прототипе.",
        "participants": [participant, {"name": None, "role": "аналитик",
                                       **({"side": "не определено"} if summary_type in SIDES else {})}],
        "key_figures": [{"value": "1,5 млн руб.", "context": "сервер | оборудование"}],
        "topics": [{"timestamp": "00:01:04", "title": "Требования", "points": ["Закрытый контур"]}],
        "decisions": [{"timestamp": "00:07:57", "text": "Начать с прототипа"}],
        "action_items": [{"timestamp": "00:09:39", "task": "Подготовить вопросы",
                          "owner": None, "due": "среда"}],
        "open_questions": [],
        "details": DETAILS[summary_type],
    }
    data.update(overrides)
    return data


def make_summary(summary_type: str = "client", **overrides):
    return parse_summary(make_data(summary_type, **overrides))


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


@pytest.mark.parametrize("summary_type", list(TYPES))
def test_every_type_parses_and_renders(summary_type):
    s = make_summary(summary_type)
    md = render_markdown(s, duration="~35 мин")

    sections = ["## Кратко", "## Участники", "## Ключевые цифры", "## Решения",
                "## Задачи", "## Открытые вопросы", "## Ход обсуждения"]
    positions = [md.index(section) for section in sections]
    assert positions == sorted(positions), "sections are out of order"
    assert f"**Тип:** {TYPES[summary_type].label} · **Длительность:** ~35 мин" in md
    assert "| 1 | Подготовить вопросы `00:09:39` | — | среда |" in md
    assert "сервер \\| оборудование" in md  # pipes escaped inside table cells


def test_type_specific_sections():
    assert "## Клиент" in render_markdown(make_summary("client"))
    assert "## Статус\n\n- Релиз: в работе" in render_markdown(make_summary("meeting"))
    assert "## Успехи\n\n- Запустил дашборд" in render_markdown(make_summary("one_on_one"))
    assert ("## Тезисы\n\n- Переход на новую CRM снизит время обработки заявки"
            in render_markdown(make_summary("highlights")))
    assert ("## Почему пилот, а не внедрение\n\nДанные клиента нельзя выносить из контура."
            "\n\n- Сервер в офисе\n- Доступ по VPN" in render_markdown(make_summary("freeform")))

    md = render_markdown(make_summary("interview"))
    assert md.index("## Предварительная оценка") < md.index("## Участники")
    assert "**Скорее да.** Сильный Python." in md
    assert "не заменяет решение интервьюера" in md
    assert "**Вакансия:** Backend-разработчик" in md
    assert "| Python | сильная сторона | Спроектировал сервис платежей `00:05:00` |" in md


@pytest.mark.parametrize("summary_type", list(TYPES))
def test_render_markdown_without_timestamps(summary_type):
    """Print-friendly export (docx download): no `[ЧЧ:ММ:СС]` anywhere, sections unchanged."""
    md = render_markdown(make_summary(summary_type), duration="~35 мин", timestamps=False)
    assert "`" not in md
    assert "Начать с прототипа" in md and "Подготовить вопросы" in md and "Требования" in md


def test_render_markdown_without_timestamps_keeps_interview_competencies():
    md = render_markdown(make_summary("interview"), timestamps=False)
    assert "| Python | сильная сторона | Спроектировал сервис платежей |" in md
    assert "`00:05:00`" not in md


def test_render_digest():
    md = render_digest(make_summary("meeting"), duration="~35 мин")
    assert "`" not in md  # no timestamps
    assert "**Тип:** Совещание · **Длительность:** ~35 мин" in md
    assert "## Кратко\n\nДоговорились о тестовом прототипе." in md
    assert "## Решения\n\n- Начать с прототипа" in md
    assert "## Задачи\n\n- Подготовить вопросы _(срок: среда)_" in md
    assert "## Ключевые цифры\n\n- **1,5 млн руб.** — сервер | оборудование" in md
    # Only the essentials: no participants, no discussion, no type-specific details.
    for absent in ("## Участники", "## Ход обсуждения", "## Открытые вопросы", "## Статус"):
        assert absent not in md


def test_render_digest_task_owner_without_due():
    md = render_digest(make_summary("meeting", action_items=[
        {"timestamp": "00:01:00", "task": "Выгрузить отчёт", "owner": "Оля", "due": None},
    ]))
    assert "## Задачи\n\n- Выгрузить отчёт — Оля" in md


def test_render_digest_no_decisions_or_tasks():
    md = render_digest(make_summary("meeting", decisions=[], action_items=[]))
    assert "## Решения\n\n_Не зафиксировано_" in md
    assert "## Задачи\n\n_Не зафиксировано_" in md


# --- strip_empty_sections: docx downloads drop "не зафиксировано" sections entirely ---

def test_strip_empty_sections_drops_placeholder_only_sections():
    md = strip_empty_sections(render_digest(make_summary("meeting", decisions=[], action_items=[])))
    assert "Решения" not in md and "Задачи" not in md
    assert "## Кратко" in md and "## Ключевые цифры" in md  # untouched, non-empty


def test_strip_empty_sections_drops_open_questions_and_discussion():
    md = strip_empty_sections(render_markdown(make_summary("meeting", topics=[])))
    assert "## Открытые вопросы" not in md  # empty in make_data()
    assert "## Ход обсуждения" not in md  # no topics at all — no dangling section either


def test_strip_empty_sections_before_discussion_keeps_the_rule():
    # The `---` before "Ход обсуждения" must not count as content of the empty
    # "Открытые вопросы" above it, nor disappear together with it.
    md = strip_empty_sections(render_markdown(make_summary("meeting")))
    assert "## Открытые вопросы" not in md
    assert "\n---\n\n## Ход обсуждения" in md


def test_strip_empty_sections_drops_empty_subsection_but_keeps_parent():
    md = strip_empty_sections(render_markdown(make_summary("client")))
    assert "## Клиент" in md and "### Потребности" in md  # needs is non-empty
    for empty in ("Текущие проблемы", "Возражения и опасения", "Бюджет и сроки",
                 "Процесс принятия решения", "Риски сделки"):
        assert empty not in md


def test_strip_empty_sections_drops_parent_when_all_subsections_empty():
    empty_client = {k: [] for k in DETAILS["client"]}
    md = strip_empty_sections(render_markdown(make_summary("client", details=empty_client)))
    assert "## Клиент" not in md


def test_strip_empty_sections_keeps_fully_populated_output_unchanged():
    # highlights has a single, always-populated details field, so every section here
    # (base and type-specific) has real content — nothing should be dropped.
    md = render_markdown(make_summary("highlights", open_questions=["Нужно ли согласование?"]),
                         duration="~35 мин")
    assert strip_empty_sections(md) == md


def test_sides_shown_only_for_types_that_have_them():
    assert "- **Максим** — ведущий специалист _(клиент)_" in render_markdown(make_summary("client"))
    assert "- Аналитик\n" in render_markdown(make_summary("client"))  # "не определено" hidden
    assert "_(" not in render_markdown(make_summary("meeting"))


def test_side_must_match_type():
    data = make_data("interview")
    data["participants"][0]["side"] = "клиент"
    with pytest.raises(ValidationError):
        parse_summary(data)


def test_empty_sections():
    md = render_markdown(make_summary("meeting", decisions=[], action_items=[]))
    assert "## Решения\n\n_Не зафиксировано_" in md
    assert "## Задачи\n\n_Не зафиксировано_" in md


def test_invalid_timestamp_rejected():
    with pytest.raises(ValidationError):
        make_summary(decisions=[{"timestamp": "7:57", "text": "x"}])


def test_unknown_type_rejected():
    with pytest.raises(ValueError, match="Неизвестный тип"):
        parse_summary({**make_data(), "meeting_type": "lecture"})


def test_parse_strips_code_fences():
    raw = "```json\n" + json.dumps(make_data("meeting"), ensure_ascii=False) + "\n```"
    assert summary._parse(raw, "meeting").title == "Пилот ИИ-аналитики"


def test_parse_rejects_truncated_json():
    with pytest.raises(ValidationError):
        summary._parse(json.dumps(make_data())[:100], "client")


@pytest.mark.parametrize("answer, expected", [
    ('{"meeting_type": "interview"}', "interview"),
    ('```json\n{"meeting_type": "one_on_one"}\n```', "one_on_one"),
    ('{"meeting_type": "lecture"}', "highlights"),  # unknown → fallback
])
def test_classify(monkeypatch, answer, expected):
    monkeypatch.setattr(summary, "_chat_deepseek", lambda messages, model, schema, config: (answer, None))
    assert summary.classify("[00:00:00] Расскажите о себе", "deepseek") == expected


def test_summarize_uses_detected_type(monkeypatch):
    calls = []

    def fake_chat(messages, model, schema, config):
        calls.append(schema)
        if len(calls) == 1:
            return '{"meeting_type": "one_on_one"}', None
        return json.dumps(make_data("one_on_one"), ensure_ascii=False), None

    monkeypatch.setattr(summary, "_chat_ollama", fake_chat)
    result = summary.summarize("[00:00:00] Как дела с проектом?", "ollama")
    assert result.meeting_type == "one_on_one"
    assert calls[0]["properties"]["meeting_type"]["enum"] == list(TYPES)  # classifier schema
    assert "wins" in json.dumps(calls[1], ensure_ascii=False)  # one_on_one summary schema


def test_interview_sanitize_drops_personal_data_only():
    from transcriber.summary_types.interview import sanitize

    data = make_data("interview", tldr="Сильный бэкенд. Кандидат планирует рождение ребёнка.")
    data["details"] = {
        **DETAILS["interview"],
        "experience": ["5 лет разработки на Python", "Возраст — 34 года", "Команда из семи человек"],
        "concerns": ["Нет опыта с Kubernetes", "Планирование беременности, возможен декрет"],
        "expectations": ["От 300 тысяч на руки", "Семейные планы: ребёнок с мужем"],
    }
    data["topics"] = [{"timestamp": "00:00:18", "title": "Опыт",
                       "points": ["Возраст кандидата — 34 года", "Внешние сервисы: Kafka"]}]
    cleaned, removed = sanitize(parse_summary(data))

    assert removed == 5
    assert cleaned.tldr == "Сильный бэкенд."
    assert cleaned.details.experience == ["5 лет разработки на Python", "Команда из семи человек"]
    assert cleaned.details.concerns == ["Нет опыта с Kubernetes"]
    assert cleaned.details.expectations == ["От 300 тысяч на руки"]
    assert cleaned.topics[0].points == ["Внешние сервисы: Kafka"]


def test_sanitize_applied_in_summarize(monkeypatch):
    data = make_data("interview")
    data["details"] = {**DETAILS["interview"], "concerns": ["Упомянула беременность"]}
    monkeypatch.setattr(summary, "_chat_deepseek",
                        lambda messages, model, schema, config: (json.dumps(data, ensure_ascii=False), None))
    result = summary.summarize("[00:00:00] Расскажите о себе", "deepseek", summary_type="interview")
    assert result.details.concerns == []


def test_freeform_normalizes_model_markdown():
    # A small model puts headings, list markers and line breaks into strings; left as is
    # they'd become stray headings/tables in docx_export, which parses the Markdown.
    s = make_summary("freeform", details={"sections": [
        {"title": "## **Итоги:**", "paragraphs": ["Первый абзац.\n\nВторой абзац.\n- вывод\n2) шаг"],
         "points": ["1. один\n* два", "---", "| таблица"]},
        {"title": "Пустой", "paragraphs": ["  "], "points": ["-"]},
        {"title": "Только текст", "paragraphs": ["Абзац про 1,5 млн руб."], "points": []},
    ]})
    first, only_text = s.details.sections
    assert first.title == "Итоги"
    assert first.paragraphs == ["Первый абзац.", "Второй абзац."]
    assert first.points == ["вывод", "шаг", "один", "два", "таблица"]

    md = render_markdown(s)
    assert "## Итоги\n\nПервый абзац.\n\nВторой абзац.\n\n- вывод\n- шаг\n" in md
    assert "## Только текст\n\nАбзац про 1,5 млн руб.\n\n## Решения" in md
    assert "Пустой" not in md


def test_custom_type_schema_and_render():
    from transcriber.summary_types import Registry
    from transcriber.summary_types.custom import Section, custom_type

    retro = custom_type("retro", "Ретроспектива", "ретро спринта", "Правила ретро.",
                        [Section("went_well", "Что получилось", "успехи"),
                         Section("to_improve", "Что улучшить")])
    registry = Registry({**TYPES, "retro": retro})
    schema = retro.model.model_json_schema()
    assert "went_well" in json.dumps(schema) and "Что получилось. успехи." in json.dumps(schema,
                                                                                         ensure_ascii=False)
    s = registry.parse(make_data("meeting", meeting_type="retro",
                                 details={"went_well": ["Релиз вовремя"], "to_improve": []}))
    md = registry.render_markdown(s)
    assert "**Тип:** Ретроспектива" in md
    assert "## Что получилось\n\n- Релиз вовремя" in md
    assert "## Что улучшить\n\n_Не зафиксировано_" in md
    assert registry.system_prompt("retro").endswith("Правила ретро.")


def test_disabled_types_not_offered_to_classifier(monkeypatch):
    from transcriber.summary_types import Registry

    # Also disable the designated fallback (highlights) to exercise the "first enabled"
    # path rather than the normal fallback-type path.
    registry = Registry(TYPES, disabled=frozenset({"meeting", "client", "highlights", "freeform"}))
    schemas = []

    def fake_chat(messages, model, schema, config):
        schemas.append(schema)
        return '{"meeting_type": "lecture"}', None

    monkeypatch.setattr(summary, "_chat_ollama", fake_chat)
    assert summary.classify("[00:00:00] Привет", "ollama", config=summary.LLMConfig(),
                            registry=registry) == "interview"  # fallback: first enabled
    assert schemas[0]["properties"]["meeting_type"]["enum"] == ["interview", "one_on_one"]
    assert registry.parse(make_data("meeting")).meeting_type == "meeting"  # still readable


def test_usage_reported_for_each_request(monkeypatch):
    replies = iter(['{"meeting_type": "meeting"}', "{not json",
                    json.dumps(make_data("meeting"), ensure_ascii=False)])

    def fake_chat(messages, model, schema, config):
        return next(replies), summary.Usage("deepseek", "deepseek-flash", "", 100, 10)

    monkeypatch.setattr(summary, "_chat_deepseek", fake_chat)
    usages = []
    summary.summarize("[00:00:00] Привет", "deepseek", config=summary.LLMConfig(),
                      on_usage=usages.append)
    assert [u.kind for u in usages] == ["classify", "summary", "summary"]  # incl. the retry
    assert usages[0].prompt_tokens == 100 and usages[0].model == "deepseek-flash"
