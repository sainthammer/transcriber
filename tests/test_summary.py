"""LLM calls: timeouts, cancellation, provider status cache. No network: httpx goes
through MockTransport, the OpenAI client is replaced."""

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import httpx
import openai
import pytest
from test_summary_types import make_data

from transcriber import summary

SCHEMA = {"type": "object"}
MESSAGES = [{"role": "user", "content": "Привет"}]


@pytest.fixture(autouse=True)
def clean_status_cache():
    summary._ollama_status_cache.clear()
    yield
    summary._ollama_status_cache.clear()


def mock_ollama(monkeypatch, handler):
    monkeypatch.setattr(summary, "_ollama_client",
                        lambda: httpx.Client(transport=httpx.MockTransport(handler)))


def ndjson(chunks):
    return [json.dumps(c).encode() + b"\n" for c in chunks]


STREAM = [{"message": {"content": '{"a":'}}, {"message": {"content": " 1}"}},
          {"message": {"content": ""}, "done": True, "done_reason": "stop",
           "prompt_eval_count": 10, "eval_count": 2}]


# --- timeouts ---------------------------------------------------------------------------

def test_ollama_client_has_finite_timeouts():
    with summary._ollama_client() as client:
        assert client.timeout.connect == summary.OLLAMA_CONNECT_TIMEOUT
        assert client.timeout.read == summary.OLLAMA_READ_TIMEOUT
        assert None not in (client.timeout.write, client.timeout.pool)


def test_short_ollama_requests_keep_own_timeouts(monkeypatch):
    seen = {}

    def handler(request):
        seen[request.url.path] = request.extensions["timeout"]["read"]
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": []})
        return httpx.Response(200, json={"model_info": {}})

    mock_ollama(monkeypatch, handler)
    summary.ollama_models(summary.LLMConfig())
    summary._ollama_context_limit(summary.LLMConfig())
    assert seen == {"/api/tags": 5, "/api/show": 10}


def test_ollama_stream_ok(monkeypatch):
    mock_ollama(monkeypatch, lambda request: httpx.Response(200, content=ndjson(STREAM)))
    raw, usage = summary._chat_ollama(MESSAGES, None, SCHEMA, summary.LLMConfig())
    assert raw == '{"a": 1}'
    assert (usage.prompt_tokens, usage.completion_tokens) == (10, 2)


@pytest.mark.parametrize("exc, expected", [
    (httpx.ReadTimeout, summary.LLMTimeout),
    (httpx.WriteTimeout, summary.LLMTimeout),
    (httpx.ConnectTimeout, RuntimeError),
    (httpx.ConnectError, RuntimeError),
])
def test_ollama_transport_errors_become_russian_errors(monkeypatch, caplog, exc, expected):
    caplog.set_level(logging.DEBUG, logger="transcriber")

    def handler(request):
        raise exc("boom-secret", request=request)

    mock_ollama(monkeypatch, handler)
    with pytest.raises(expected) as info:
        summary._chat("ollama", "summary", None, MESSAGES, None, SCHEMA,
                      summary.LLMConfig())
    assert type(info.value) is expected
    assert "Ollama" in str(info.value)
    assert "boom-secret" not in caplog.text


def test_ollama_timeout_logs_type_only(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="transcriber")

    def handler(request):
        raise httpx.ReadTimeout("boom-secret", request=request)

    mock_ollama(monkeypatch, handler)
    with pytest.raises(summary.LLMTimeout):
        summary._chat("ollama", "summary", None, MESSAGES, None, SCHEMA, summary.LLMConfig())
    failed = [r.getMessage() for r in caplog.records if "failed" in r.getMessage()]
    assert failed and failed[0].endswith(": LLMTimeout")
    assert any(r.getMessage() == "Ollama timeout: ReadTimeout" for r in caplog.records)


class FakeOpenAI:
    """Stands in for openai.OpenAI; `create` decides what a completion request does."""
    kwargs: dict = {}
    create = None

    def __init__(self, **kwargs):
        FakeOpenAI.kwargs = kwargs
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=FakeOpenAI.create))


def completion(content):
    return SimpleNamespace(
        choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content=content))],
        usage=SimpleNamespace(prompt_tokens=5, completion_tokens=3))


def test_deepseek_explicit_timeout_and_retries(monkeypatch):
    monkeypatch.setattr(FakeOpenAI, "create", staticmethod(lambda **kw: completion("{}")))
    monkeypatch.setattr(summary, "OpenAI", FakeOpenAI)
    summary._chat_deepseek(MESSAGES, None, SCHEMA, summary.LLMConfig(deepseek_api_key="k"))
    assert FakeOpenAI.kwargs["max_retries"] == summary.DEEPSEEK_MAX_RETRIES == 1
    timeout = FakeOpenAI.kwargs["timeout"]
    assert (timeout.connect, timeout.read) == (10, 600)


@pytest.mark.parametrize("exc, expected", [
    (openai.APITimeoutError, summary.LLMTimeout),
    (openai.APIConnectionError, RuntimeError),
])
def test_deepseek_transport_errors_become_russian_errors(monkeypatch, caplog, exc, expected):
    caplog.set_level(logging.DEBUG, logger="transcriber")

    def create(**kw):
        request = httpx.Request("POST", "https://api.deepseek.com/chat/completions")
        raise exc(request=request)

    monkeypatch.setattr(FakeOpenAI, "create", staticmethod(create))
    monkeypatch.setattr(summary, "OpenAI", FakeOpenAI)
    with pytest.raises(expected) as info:
        summary._chat("deepseek", "summary", None, MESSAGES, None, SCHEMA,
                      summary.LLMConfig(deepseek_api_key="k"))
    assert type(info.value) is expected
    assert "DeepSeek" in str(info.value)


# --- cancellation -----------------------------------------------------------------------

def test_ollama_stream_stops_between_chunks(monkeypatch):
    sent = []

    def body():
        for i in range(1000):
            sent.append(i)
            yield json.dumps({"message": {"content": "x"}}).encode() + b"\n"

    mock_ollama(monkeypatch, lambda request: httpx.Response(200, content=body()))
    stop = {"flag": False}

    def should_stop():
        if len(sent) >= 3:
            stop["flag"] = True
        return stop["flag"]

    with pytest.raises(summary.SummaryCancelled):
        summary._chat_ollama(MESSAGES, None, SCHEMA, summary.LLMConfig(),
                             should_stop=should_stop)
    assert len(sent) < 10


def test_cancelled_before_start_makes_no_requests(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("no request expected")

    monkeypatch.setattr(summary, "_chat_deepseek", fail)
    monkeypatch.setattr(summary, "_ollama_context_limit", fail)
    with pytest.raises(summary.SummaryCancelled):
        summary.summarize("[00:00:00] Привет", "auto", config=summary.LLMConfig(),
                          should_stop=lambda: True)


def test_deepseek_cancelled_between_classify_and_summary(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="transcriber")
    calls = []

    def fake_chat(messages, model, schema, config):
        calls.append(schema)
        return '{"meeting_type": "meeting"}', None

    monkeypatch.setattr(summary, "_chat_deepseek", fake_chat)
    with pytest.raises(summary.SummaryCancelled):
        summary.summarize("[00:00:00] Привет", "deepseek", config=summary.LLMConfig(),
                          should_stop=lambda: len(calls) >= 1)
    assert len(calls) == 1  # classification only
    assert not any(r.levelno >= logging.WARNING for r in caplog.records)


def test_deepseek_cancelled_before_retry(monkeypatch):
    calls = []

    def fake_chat(messages, model, schema, config):
        calls.append(1)
        return "{}", None  # fails validation → would retry

    monkeypatch.setattr(summary, "_chat_deepseek", fake_chat)
    flag = iter([False, False, True])  # start, before attempt 1, after attempt 1
    with pytest.raises(summary.SummaryCancelled):
        summary.summarize("[00:00:00] Привет", "deepseek", summary_type="meeting",
                          config=summary.LLMConfig(), should_stop=lambda: next(flag, True))
    assert len(calls) == 1


def test_ollama_summarize_passes_should_stop(monkeypatch):
    seen = []

    def fake_chat(messages, model, schema, config, *, should_stop=None):
        seen.append(should_stop)
        return json.dumps(make_data("meeting"), ensure_ascii=False), None

    monkeypatch.setattr(summary, "_chat_ollama", fake_chat)

    def never():
        return False

    result = summary.summarize("[00:00:00] Привет", "ollama", summary_type="meeting",
                               config=summary.LLMConfig(), should_stop=never)
    assert result.meeting_type == "meeting"
    assert seen == [never]


def test_cancelled_is_not_runtime_error():
    assert not issubclass(summary.SummaryCancelled, RuntimeError)


# --- provider status cache --------------------------------------------------------------

def counting_limit(monkeypatch, fail=False):
    calls = []

    def fake(config):
        calls.append((config.ollama_host, config.ollama_model))
        if fail:
            raise summary.OllamaUnavailable("нет", "not_running")
        return 4096

    monkeypatch.setattr(summary, "_ollama_context_limit", fake)
    return calls


def test_provider_status_cached_per_host_and_model(monkeypatch):
    calls = counting_limit(monkeypatch)
    config = summary.LLMConfig()
    assert summary.provider_status(config)["ollama"]["available"]
    summary.provider_status(config)
    assert len(calls) == 1
    summary.provider_status(summary.LLMConfig(ollama_model="other"))
    summary.provider_status(summary.LLMConfig(ollama_host="http://gpu:11434"))
    assert len(calls) == 3


def test_provider_status_caches_failures_and_expires(monkeypatch):
    calls = counting_limit(monkeypatch, fail=True)
    config = summary.LLMConfig()
    assert summary.provider_status(config)["ollama"]["reason"] == "not_running"
    assert summary.provider_status(config)["ollama"]["reason"] == "not_running"
    assert len(calls) == 1
    key = next(iter(summary._ollama_status_cache))
    checked, reason = summary._ollama_status_cache[key]
    summary._ollama_status_cache[key] = (checked - summary.OLLAMA_STATUS_TTL - 1, reason)
    summary.provider_status(config)
    assert len(calls) == 2


def test_provider_status_threads(monkeypatch):
    counting_limit(monkeypatch)
    configs = [summary.LLMConfig(ollama_model=f"m{i % 4}") for i in range(64)]
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(summary.provider_status, configs))
    assert all(r["ollama"]["available"] for r in results)
    assert len(summary._ollama_status_cache) == 4


def test_resolve_provider_bypasses_cache(monkeypatch):
    calls = counting_limit(monkeypatch)
    config = summary.LLMConfig()
    summary.provider_status(config)
    summary.resolve_provider("[00:00:00] Привет", "auto", config)
    summary.resolve_provider("[00:00:00] Привет", "auto", config)
    assert len(calls) == 3
