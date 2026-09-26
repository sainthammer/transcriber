"""Model-run logs: metadata is there, content (transcripts, replies) never is."""

import json
import logging
from types import SimpleNamespace

import pytest

from transcriber import cli, log, summary
from test_summary_types import DETAILS, make_data

# Marker planted in the transcript and in model replies; must never reach the logs.
SECRET = "Секретная-фраза-4217"


@pytest.fixture
def logs(caplog):
    caplog.set_level(logging.DEBUG, logger="transcriber")
    return caplog


def assert_no_secret(caplog):
    assert caplog.records
    for record in caplog.records:
        assert SECRET not in record.getMessage()
        assert SECRET not in str(record.args)
    assert SECRET not in caplog.text


def test_request_logged_with_kind_and_tokens(monkeypatch, logs):
    replies = iter(['{"meeting_type": "meeting"}',
                    json.dumps(make_data("meeting"), ensure_ascii=False)])

    def fake_chat(messages, model, schema, config):
        return next(replies), summary.Usage("ollama", "qwen3.5:4b", "", 1234, 56, "stop")

    monkeypatch.setattr(summary, "_chat_ollama", fake_chat)
    summary.summarize("[00:00:00] Привет", "ollama", config=summary.LLMConfig())

    requests = [r.getMessage() for r in logs.records if r.getMessage().startswith("LLM request")]
    done = [r.getMessage() for r in logs.records if r.getMessage().startswith("LLM done")]
    assert len(requests) == 2 and len(done) == 2
    assert "kind=classify" in requests[0] and "kind=summary" in requests[1]
    assert "model=qwen3.5:4b" in requests[1] and "num_ctx=" in requests[1]
    assert "prompt_chars=" in requests[1] and "attempt=1" in requests[1]
    assert "kind=summary" in done[1]
    assert "prompt_tokens=1234" in done[1] and "completion_tokens=56" in done[1]
    assert "finish=stop" in done[1]
    assert any(r.getMessage() == "classify: type=meeting" for r in logs.records)


def test_content_never_logged(monkeypatch, logs):
    transcript = f"[00:00:00] {SECRET} — кандидату 34 года"
    bad = make_data("interview", title=SECRET)
    bad["topics"][0]["timestamp"] = SECRET  # fails validation; pydantic quotes the input
    good = make_data("interview", title=SECRET, tldr=SECRET)
    good["details"] = {**DETAILS["interview"], "concerns": [f"Беременность {SECRET}"]}
    replies = iter([f'{{"meeting_type": "{SECRET}"}}',  # invalid → fallback type
                    json.dumps(bad, ensure_ascii=False),
                    json.dumps(good, ensure_ascii=False)])

    def fake_chat(messages, model, schema, config):
        return next(replies), summary.Usage("deepseek", "deepseek-flash", "", 10, 5, "stop")

    monkeypatch.setattr(summary, "_chat_deepseek", fake_chat)
    # Fallback is the first enabled type once highlights is off.
    registry = summary.Registry(summary.TYPES, disabled=frozenset({"highlights", "meeting",
                                                                   "client"}))
    result = summary.summarize(transcript, "deepseek", config=summary.LLMConfig(),
                               registry=registry)

    assert result.details.concerns == []  # sanitize ran
    messages = [r.getMessage() for r in logs.records]
    assert any("retrying" in m and "topics.0.timestamp" in m for m in messages)
    assert any(m.startswith("sanitize: removed 1") for m in messages)
    assert any("fallback type=interview" in m for m in messages)
    assert_no_secret(logs)


def test_failed_request_logged_without_message_content(monkeypatch, logs):
    def fake_chat(messages, model, schema, config):
        raise ValueError(f"unexpected reply: {SECRET}")

    monkeypatch.setattr(summary, "_chat_deepseek", fake_chat)
    with pytest.raises(ValueError):
        summary.summarize(f"[00:00:00] {SECRET}", "deepseek", summary_type="meeting",
                          config=summary.LLMConfig())
    failed = [r for r in logs.records if r.getMessage().startswith("LLM request failed")]
    assert failed and failed[0].levelno == logging.WARNING
    assert failed[0].getMessage().endswith(": ValueError")
    assert_no_secret(logs)


def test_truncated_reply_logged_as_warning(monkeypatch, logs):
    def fake_chat(messages, model, schema, config):
        raise RuntimeError(f"ответ обрезан на {summary.MAX_OUTPUT_TOKENS} токенах")

    monkeypatch.setattr(summary, "_chat_ollama", fake_chat)
    with pytest.raises(RuntimeError):
        summary.summarize("[00:00:00] Привет", "ollama", summary_type="meeting",
                          config=summary.LLMConfig())
    failed = [r for r in logs.records if r.levelno == logging.WARNING]
    assert "обрезан" in failed[0].getMessage() and "kind=summary" in failed[0].getMessage()


class FakeWhisper:
    def transcribe(self, audio_path, language, vad_filter):
        segments = [SimpleNamespace(start=0.0, end=4.0, text=f" {SECRET} "),
                    SimpleNamespace(start=4.0, end=9.5, text="Вторая фраза")]
        info = SimpleNamespace(language="ru", language_probability=0.98, duration=10.0,
                               duration_after_vad=9.5)
        return iter(segments), info


def test_whisper_logs_metadata_only(logs):
    items = list(cli.transcribe("clip.mp3", FakeWhisper(), None))
    assert [i for i in items if isinstance(i, tuple)][0][1] == SECRET
    messages = [r.getMessage() for r in logs.records]
    assert any("language=ru (detected, p=0.98) audio=10.0s" in m for m in messages)
    assert any(m.startswith("Whisper done: phrases=2 audio=10.0s") and "realtime" in m
               for m in messages)
    assert_no_secret(logs)


@pytest.fixture
def clean_logger():
    logger = logging.getLogger(log.LOGGER_NAME)
    saved = logger.level, logger.propagate, list(logger.handlers)
    yield logger
    logger.setLevel(saved[0])
    logger.propagate = saved[1]
    logger.handlers[:] = saved[2]


def test_setup_logging_level_and_job_prefix(monkeypatch, clean_logger, capsys):
    monkeypatch.setenv("LOG_LEVEL", "debug")
    log.setup_logging(log.CLI_DEFAULT)
    log.setup_logging(log.CLI_DEFAULT)  # idempotent: one handler
    assert clean_logger.level == logging.DEBUG
    assert len(clean_logger.handlers) == 1

    token = log.job_id.set("20260926-120000-abcd")
    try:
        logging.getLogger("transcriber.summary").info("LLM done")
    finally:
        log.job_id.reset(token)
    err = capsys.readouterr().err
    assert "transcriber.summary: [job 20260926-120000-abcd] LLM done" in err


def test_cli_default_is_silent(monkeypatch, clean_logger):
    monkeypatch.setenv("LOG_LEVEL", "")
    log.setup_logging(log.CLI_DEFAULT)
    assert not clean_logger.isEnabledFor(logging.ERROR)
    log.setup_logging(log.SERVER_DEFAULT)
    assert clean_logger.isEnabledFor(logging.INFO)


def test_instructions_sent_after_transcript_but_not_logged(monkeypatch, logs):
    sent = []

    def fake_chat(messages, model, schema, config):
        sent.append(messages)
        return (json.dumps(make_data("meeting"), ensure_ascii=False),
                summary.Usage("ollama", "qwen3.5:4b", "", 10, 5, "stop"))

    monkeypatch.setattr(summary, "_chat_ollama", fake_chat)
    wishes = f"  {SECRET}: подробнее про задачи  "
    summary.summarize("[00:00:00] Привет", "ollama", summary_type="meeting",
                      config=summary.LLMConfig(), instructions=wishes)

    system, user = sent[0]
    assert SECRET not in system["content"]  # rules and schema stay untouched
    assert user["content"].startswith("Расшифровка:\n\n[00:00:00] Привет")
    assert f"{SECRET}: подробнее про задачи\n\n" in user["content"]
    assert "правила и схема важнее" in user["content"]
    plain = summary._messages("[00:00:00] Привет", "meeting")
    assert summary._estimate_tokens(sent[0]) > summary._estimate_tokens(plain)  # num_ctx
    assert any(r.getMessage() == f"summary: user instructions_chars={len(wishes.strip())}"
               for r in logs.records)
    assert_no_secret(logs)
