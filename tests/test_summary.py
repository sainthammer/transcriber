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


# --- Yandex AI Studio -------------------------------------------------------------------

YANDEX = summary.LLMConfig(yandex_api_key="AQVN-secret-key", yandex_folder_id="b1gfolder")


def mock_yandex(monkeypatch, handler):
    """The real OpenAI client over a MockTransport: headers and bodies are the real ones."""
    real = openai.OpenAI
    monkeypatch.setattr(summary, "OpenAI", lambda **kw: real(
        **kw, http_client=httpx.Client(transport=httpx.MockTransport(handler))))


def yandex_reply(content='{"a": 1}', finish_reason="stop"):
    return httpx.Response(200, json={
        "id": "1", "object": "chat.completion", "created": 0,
        "model": "gpt://b1gfolder/yandexgpt/latest",
        "choices": [{"index": 0, "finish_reason": finish_reason,
                     "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 25, "completion_tokens": 12, "total_tokens": 37}})


def test_yandex_request_and_usage(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        return yandex_reply()

    mock_yandex(monkeypatch, handler)
    raw, usage = summary._chat_yandex(MESSAGES, None, SCHEMA, YANDEX)
    assert raw == '{"a": 1}'
    assert usage == summary.Usage("yandex", "yandexgpt/latest", "", 25, 12, "stop")
    request = requests[0]
    assert str(request.url) == "https://llm.api.cloud.yandex.net/v1/chat/completions"
    assert request.headers["authorization"] == "Api-Key AQVN-secret-key"
    assert request.headers["openai-project"] == "b1gfolder"
    body = json.loads(request.content)
    assert body["model"] == "gpt://b1gfolder/yandexgpt/latest"
    assert body["response_format"] == {"type": "json_schema",
                                       "json_schema": {"name": "answer", "schema": SCHEMA}}
    assert body["max_tokens"] == summary.MAX_OUTPUT_TOKENS


@pytest.mark.parametrize("model, uri", [
    ("yandexgpt-lite", "gpt://b1gfolder/yandexgpt-lite/latest"),
    ("yandexgpt/rc", "gpt://b1gfolder/yandexgpt/rc"),
    ("gpt://b1gother/aliceai-llm/latest", "gpt://b1gother/aliceai-llm/latest"),
])
def test_yandex_model_uri(model, uri):
    assert summary.yandex_model_uri(YANDEX, model) == uri
    assert summary._yandex_model_name(uri) == uri.split("/", 3)[3]


def test_yandex_falls_back_to_json_mode(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="transcriber")
    formats = []

    def handler(request):
        formats.append(json.loads(request.content)["response_format"]["type"])
        if formats[-1] == "json_schema":
            return httpx.Response(400, json={"error": {"message": "schema is not supported"}})
        return yandex_reply()

    mock_yandex(monkeypatch, handler)
    raw = summary._chat("yandex", "summary", None, MESSAGES, None, SCHEMA, YANDEX)
    assert raw == '{"a": 1}'
    assert formats == ["json_schema", "json_object"]
    assert "schema is not supported" not in caplog.text


@pytest.mark.parametrize("status, expected", [
    (401, "ключ API не подошёл"), (403, "роль ai.languageModels.user"), (404, "не найдена")])
def test_yandex_auth_errors_are_russian_and_keyless(monkeypatch, caplog, status, expected):
    caplog.set_level(logging.DEBUG, logger="transcriber")
    mock_yandex(monkeypatch, lambda request: httpx.Response(
        status, json={"error": {"message": "echo AQVN-secret-key"}}))
    with pytest.raises(RuntimeError) as info:
        summary._chat("yandex", "summary", None, MESSAGES, None, SCHEMA, YANDEX)
    assert expected in str(info.value)
    assert "AQVN-secret-key" not in str(info.value) + caplog.text
    assert "b1gfolder" not in str(info.value) + caplog.text


@pytest.mark.parametrize("finish_reason, expected", [
    ("length", "обрезан"), ("content_filter", "фильтр содержимого")])
def test_yandex_bad_finish_reasons(monkeypatch, finish_reason, expected):
    mock_yandex(monkeypatch, lambda request: yandex_reply(finish_reason=finish_reason))
    with pytest.raises(RuntimeError, match=expected):
        summary._chat_yandex(MESSAGES, None, SCHEMA, YANDEX)


def test_yandex_too_long_fails_before_request(monkeypatch):
    mock_yandex(monkeypatch, lambda request: pytest.fail("no request expected"))
    long = [{"role": "user", "content": "а" * 100_000}]
    with pytest.raises(RuntimeError, match="YANDEX_MAX_CONTEXT"):
        summary._chat_yandex(long, None, SCHEMA, YANDEX)


@pytest.mark.parametrize("exc, expected", [
    (httpx.ReadTimeout, summary.LLMTimeout), (httpx.ConnectError, RuntimeError)])
def test_yandex_transport_errors(monkeypatch, exc, expected):
    def handler(request):
        raise exc("boom", request=request)

    mock_yandex(monkeypatch, handler)
    monkeypatch.setattr(summary, "YANDEX_MAX_RETRIES", 0)
    with pytest.raises(expected) as info:
        summary._chat_yandex(MESSAGES, None, SCHEMA, YANDEX)
    assert type(info.value) is expected and "Yandex" in str(info.value)


def test_yandex_needs_key_and_folder(monkeypatch):
    monkeypatch.setattr(summary, "_ollama_context_limit", lambda config: 32768)
    for config, reason, message in [
        (summary.LLMConfig(), "no_api_key", "YANDEX_API_KEY"),
        (summary.LLMConfig(yandex_api_key="k"), "no_folder_id", "YANDEX_FOLDER_ID"),
    ]:
        status = summary.provider_status(config)["yandex"]
        assert (status["available"], status["reason"]) == (False, reason)
        with pytest.raises(RuntimeError, match=message):
            summary._chat_yandex(MESSAGES, None, SCHEMA, config)
    assert summary.provider_status(YANDEX)["yandex"] == {
        "available": True, "reason": None, "model": "yandexgpt/latest"}


def test_yandex_not_in_auto(monkeypatch):
    monkeypatch.setattr(summary, "_ollama_context_limit", lambda config: 10)
    assert summary.resolve_provider("[00:00:00] Привет", "auto", YANDEX) == "deepseek"
    assert summary.resolve_provider("[00:00:00] Привет", "yandex", YANDEX) == "yandex"


def test_check_yandex(monkeypatch):
    def handler(request):
        assert request.url.path == "/v1/models"
        assert request.headers["openai-project"] == "b1gfolder"
        return httpx.Response(200, json={"object": "list", "data": [
            {"id": "gpt://b1gfolder/yandexgpt-lite/latest", "object": "model",
             "owned_by": "Yandex", "created": 0},
            {"id": "emb://b1gfolder/text-search-doc/latest", "object": "model",
             "owned_by": "Yandex", "created": 0}]})

    mock_yandex(monkeypatch, handler)
    assert "модели yandexgpt/latest нет. Доступны: yandexgpt-lite/latest" in \
        summary.check_yandex(YANDEX)
    lite = summary.LLMConfig(yandex_api_key="k", yandex_folder_id="b1gfolder",
                             yandex_model="yandexgpt-lite")
    assert summary.check_yandex(lite) == "Ключ работает, модель yandexgpt-lite/latest доступна"


def test_summarize_via_yandex_reports_usage(monkeypatch):
    replies = iter(['{"meeting_type": "meeting"}', json.dumps(make_data("meeting"))])
    seen = []

    def fake_chat(messages, model, schema, config):
        seen.append(schema.get("title"))
        return next(replies), summary.Usage("yandex", "yandexgpt/latest", "", 10, 5, "stop")

    monkeypatch.setattr(summary, "_chat_yandex", fake_chat)
    usages = []
    summary.summarize("[00:00:00] Привет", "yandex", config=YANDEX, on_usage=usages.append)
    assert [(u.provider, u.kind) for u in usages] == [("yandex", "classify"),
                                                      ("yandex", "summary")]
    assert len(seen) == 2
