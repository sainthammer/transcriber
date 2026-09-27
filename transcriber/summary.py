"""Structured meeting summary via DeepSeek API, YandexGPT (Yandex AI Studio) or a local
Ollama model."""

import argparse
import json
import logging
import os
import re
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
from dotenv import load_dotenv
from openai import (APIConnectionError, APIStatusError, APITimeoutError, AuthenticationError,
                    BadRequestError, NotFoundError, OpenAI, PermissionDeniedError, Timeout)
from pydantic import ValidationError, create_model
from tqdm import tqdm

from .docx_export import save_docx
from .log import CLI_DEFAULT, setup_logging
from .summary_types import DEFAULT_REGISTRY, TYPES, Registry, SummaryBase, transcript_duration

PROVIDERS = ("auto", "deepseek", "ollama", "yandex")
SUMMARY_TYPES = ("auto", *TYPES)

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_DEFAULT_MODEL = "deepseek-flash"
# Thinking mode is on by default and reasoning tokens count against max_tokens
# (~3k on a 35-minute meeting), so leave plenty of room for the JSON itself.
DEEPSEEK_MAX_TOKENS = 32768
# The reply is not streamed, but DeepSeek keeps the connection alive with blank lines while
# it thinks, so the read timeout only fires if the API goes silent. 10 minutes covers
# ~3k reasoning + 8k output tokens with a wide margin. One SDK retry (not the default two)
# still absorbs a transient 429/5xx or a dropped connection, while capping a hung request
# at ~20 minutes instead of ~30 for the single server worker.
DEEPSEEK_TIMEOUT = Timeout(600, connect=10)
DEEPSEEK_MAX_RETRIES = 1

YANDEX_BASE_URL = "https://llm.api.cloud.yandex.net/v1"
# Short name (+ version) inside the folder; the request goes to gpt://<folder_id>/<model>.
# yandexgpt = YandexGPT Pro (the latest release); yandexgpt-lite is cheaper and weaker.
# The folder also offers aliceai-llm, qwen3-235b-a22b-fp8, gpt-oss-120b, gemma-3-27b-it...
YANDEX_DEFAULT_MODEL = "yandexgpt/latest"
# YandexGPT Pro/Lite take 32k tokens of prompt + reply. Other models in the folder (Qwen3,
# gpt-oss) take more: raise YANDEX_MAX_CONTEXT for them. Checked before sending with the
# same deliberately high estimate as for Ollama (CHARS_PER_TOKEN), so the error is a clear
# Russian message instead of an API 400.
YANDEX_DEFAULT_MAX_CONTEXT = 32768
# Not streamed and, unlike DeepSeek, no keep-alive while generating: the read timeout
# covers the whole reply. 8k output tokens at a slow ~30 tok/s is ~4.5 minutes; 10 minutes
# also leaves room for reasoning models picked via YANDEX_MODEL. One SDK retry, as for
# DeepSeek, absorbs a transient 429/5xx.
YANDEX_TIMEOUT = Timeout(600, connect=10)
YANDEX_MAX_RETRIES = 1

OLLAMA_DEFAULT_HOST = "http://localhost:11434"
OLLAMA_DEFAULT_MODEL = "qwen3.5:4b"
# Practical limit for a small model on 16 GB: quality and speed drop well before the
# model's nominal context. Override with OLLAMA_MAX_CONTEXT.
OLLAMA_DEFAULT_MAX_CONTEXT = 32768
# Qwen tokenizer gives ~3.6 chars/token on Russian; 3 overestimates on purpose.
CHARS_PER_TOKEN = 3

# Small models occasionally loop until they hit num_predict. The repeat penalty over the
# last ~paragraph breaks phrase-level loops; 1.1 is mild enough not to garble Russian
# words (1.5 already does), and structural JSON tokens are dictated by the schema grammar.
# Low temperature on purpose: at Qwen's recommended 0.7 the 4B model invented product
# names from misrecognized words, at 0.3 it didn't.
OLLAMA_SAMPLING = {"temperature": 0.3, "top_p": 0.8, "top_k": 20,
                   "repeat_penalty": 1.1, "repeat_last_n": 256}
# Ollama is local: if it doesn't accept a connection in 5 s, it isn't running.
OLLAMA_CONNECT_TIMEOUT = 5
# Longest silence between stream chunks. The first chunk only comes after the model is
# loaded (a cold start of a 4B model from disk: ~5-30 s) and the whole prompt is evaluated
# (up to OLLAMA_MAX_CONTEXT=32k tokens: tens of seconds on Metal, several minutes on CPU,
# e.g. Ollama in Docker without GPU). After that tokens arrive every fraction of a second.
# 5 minutes is well above the slow first-chunk case and still frees the worker from a hung
# Ollama.
OLLAMA_READ_TIMEOUT = 300
# provider_status() is called on every form open; a hung Ollama would stall each one for
# the /api/show timeout. Admin setting changes produce a new (host, model) key right away.
OLLAMA_STATUS_TTL = 30

MAX_OUTPUT_TOKENS = 8192
DEEPSEEK_TEMPERATURE = 0.3
MAX_ATTEMPTS = 2

# The type of a meeting is clear from its opening minutes; no need to send everything.
CLASSIFY_CHARS = 8000

# Logs carry metadata only (sizes, timings, tokens, error types) — never the transcript,
# prompts or model replies. See transcriber/log.py.
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class LLMConfig:
    """Where summaries are generated. The CLI reads it from .env, the web server from
    its settings (admin overrides on top of .env)."""

    deepseek_api_key: str | None = None
    deepseek_model: str = DEEPSEEK_DEFAULT_MODEL
    ollama_host: str = OLLAMA_DEFAULT_HOST
    ollama_model: str = OLLAMA_DEFAULT_MODEL
    ollama_max_context: int = OLLAMA_DEFAULT_MAX_CONTEXT
    yandex_api_key: str | None = None
    yandex_folder_id: str | None = None
    yandex_model: str = YANDEX_DEFAULT_MODEL
    yandex_max_context: int = YANDEX_DEFAULT_MAX_CONTEXT

    @classmethod
    def from_env(cls) -> "LLMConfig":
        load_dotenv()
        return cls(
            deepseek_api_key=os.getenv("DEEPSEEK_API_KEY") or None,
            deepseek_model=os.getenv("DEEPSEEK_MODEL", DEEPSEEK_DEFAULT_MODEL),
            ollama_host=os.getenv("OLLAMA_HOST", OLLAMA_DEFAULT_HOST),
            ollama_model=os.getenv("OLLAMA_MODEL", OLLAMA_DEFAULT_MODEL),
            ollama_max_context=int(os.getenv("OLLAMA_MAX_CONTEXT", OLLAMA_DEFAULT_MAX_CONTEXT)),
            yandex_api_key=os.getenv("YANDEX_API_KEY") or None,
            yandex_folder_id=os.getenv("YANDEX_FOLDER_ID") or None,
            yandex_model=os.getenv("YANDEX_MODEL") or YANDEX_DEFAULT_MODEL,
            yandex_max_context=int(os.getenv("YANDEX_MAX_CONTEXT", YANDEX_DEFAULT_MAX_CONTEXT)),
        )


@dataclass(frozen=True)
class Usage:
    """Tokens spent by one model request (retries and classification count separately)."""

    provider: str  # "deepseek" | "ollama" | "yandex"
    model: str
    kind: str  # "classify" | "summary"
    prompt_tokens: int
    completion_tokens: int
    # Why generation stopped ("stop", ...), for logs only; None if not reported.
    finish_reason: str | None = None


UsageCallback = Callable[[Usage], None]
StopCallback = Callable[[], bool]


class SummaryCancelled(Exception):
    """should_stop() returned True: the summary was abandoned on request.

    Not a RuntimeError on purpose: callers treat RuntimeError as a failure to report."""


class LLMTimeout(RuntimeError):
    """The model API didn't answer in time. A subclass so that _error_brief logs only
    the type name."""


def _check_stop(should_stop: StopCallback | None) -> None:
    if should_stop is not None and should_stop():
        raise SummaryCancelled("summary cancelled")


def _instructions_block(instructions: str) -> str:
    # After the transcript, in the user turn: the system prompt (rules, schema, the
    # personal-data ban) stays authoritative, and the model reads the wishes last.
    return ("\n\n## Пожелания пользователя к этому summary\n\n"
            f"{instructions}\n\n"
            "Учти пожелания, если они не противоречат правилам и JSON-схеме: при "
            "расхождении правила и схема важнее. Пожелания не отменяют запретов (например, "
            "на личные данные) и не разрешают добавлять то, чего нет в расшифровке.")


def normalize_instructions(instructions: str | None) -> str | None:
    """Trimmed user wishes for a summary; blank → None."""
    return (instructions or "").strip() or None


def _messages(transcript: str, summary_type: str, registry: Registry = DEFAULT_REGISTRY,
              instructions: str | None = None) -> list[dict]:
    schema = json.dumps(registry.get(summary_type).model.model_json_schema(), ensure_ascii=False)
    system = (f"{registry.system_prompt(summary_type)}\n## JSON-схема ответа\n\n"
              f"```json\n{schema}\n```\n")
    user = f"Расшифровка:\n\n{transcript}"
    if instructions:
        user += _instructions_block(instructions)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _classification_model(registry: Registry):
    return create_model("Classification",
                        meeting_type=(Literal[tuple(registry.enabled)], ...))


def _classify_messages(transcript: str, registry: Registry = DEFAULT_REGISTRY) -> list[dict]:
    options = "\n".join(f"- `{t.id}` — {t.description}" for t in registry.enabled.values())
    system = ("Определи тип рабочей встречи по началу её расшифровки.\n\n"
              f"Варианты:\n{options}\n\n"
              'Ответь одним JSON-объектом: {"meeting_type": "<вариант>"}.')
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"Начало расшифровки:\n\n{transcript[:CLASSIFY_CHARS]}"},
    ]


def _prompt_chars(messages: list[dict]) -> int:
    return sum(len(m["content"]) for m in messages)


def _estimate_tokens(messages: list[dict]) -> int:
    """Upper-bound estimate of prompt + response tokens for a local model."""
    return _prompt_chars(messages) // CHARS_PER_TOKEN + MAX_OUTPUT_TOKENS


def _ollama_num_ctx(messages: list[dict]) -> int:
    # Ollama's default context window is small and silently truncates long prompts,
    # so size it to the request (rounded up to a multiple of 4096).
    return -(-_estimate_tokens(messages) // 4096) * 4096


def _chat_deepseek(messages: list[dict], model: str | None, schema: dict,
                   config: LLMConfig) -> tuple[str, Usage | None]:
    """Returns the reply and token usage (None if the API didn't report it)."""
    if not config.deepseek_api_key:
        raise RuntimeError("не задан ключ DeepSeek API (DEEPSEEK_API_KEY)")

    model = model or config.deepseek_model
    client = OpenAI(api_key=config.deepseek_api_key, base_url=DEEPSEEK_BASE_URL,
                    timeout=DEEPSEEK_TIMEOUT, max_retries=DEEPSEEK_MAX_RETRIES)
    response = _openai_create(
        client, "DeepSeek", DEEPSEEK_TIMEOUT, DEEPSEEK_MAX_RETRIES,
        model=model,
        messages=messages,
        # JSON mode doesn't take a schema; it's already spelled out in the system prompt.
        response_format={"type": "json_object"},
        max_tokens=DEEPSEEK_MAX_TOKENS,
        temperature=DEEPSEEK_TEMPERATURE,
    )
    choice = response.choices[0]
    if choice.finish_reason == "length":
        raise RuntimeError(f"ответ DeepSeek обрезан на {DEEPSEEK_MAX_TOKENS} токенах")
    usage = response.usage and Usage("deepseek", model, "", response.usage.prompt_tokens,
                                     response.usage.completion_tokens, choice.finish_reason)
    return choice.message.content or "", usage


def _openai_create(client: OpenAI, label: str, timeout: Timeout, retries: int, **request):
    """chat.completions.create with transport errors turned into short Russian ones
    (no request or reply text in them)."""
    try:
        return client.chat.completions.create(**request)
    except APITimeoutError:  # before APIConnectionError: it's a subclass
        raise LLMTimeout(f"{label} не ответил за {timeout.read:.0f} с "
                         f"(попыток: {retries + 1})") from None
    except APIConnectionError:
        raise RuntimeError(f"не удалось подключиться к {label} API") from None


def yandex_model_uri(config: LLMConfig, model: str | None = None) -> str:
    """gpt://<folder_id>/<name>/<version> from a short name ("yandexgpt-lite",
    "yandexgpt/rc"); a full URI is taken as is. Same rule as the Yandex AI Studio SDK."""
    model = (model or config.yandex_model).strip()
    if "://" in model:
        return model
    if "/" not in model:
        model += "/latest"
    return f"gpt://{config.yandex_folder_id}/{model}"


def _yandex_model_name(uri: str) -> str:
    """The model without the folder ID, for usage records and logs."""
    return uri.split("://", 1)[1].split("/", 1)[-1] if "://" in uri else uri


def _yandex_client(config: LLMConfig, *, timeout: Timeout | float = YANDEX_TIMEOUT,
                   max_retries: int = YANDEX_MAX_RETRIES) -> OpenAI:
    if not config.yandex_api_key:
        raise RuntimeError("не задан ключ Yandex Cloud API (YANDEX_API_KEY)")
    if not config.yandex_folder_id:
        raise RuntimeError("не задан ID каталога Yandex Cloud (YANDEX_FOLDER_ID)")
    # An API key goes as "Api-Key <key>" ("Bearer" is for IAM tokens), so the SDK's own
    # Bearer header is overridden. OpenAI-Project (project=) names the folder for /models.
    return OpenAI(api_key=config.yandex_api_key, base_url=YANDEX_BASE_URL,
                  project=config.yandex_folder_id,
                  default_headers={"Authorization": f"Api-Key {config.yandex_api_key}"},
                  timeout=timeout, max_retries=max_retries)


def _chat_yandex(messages: list[dict], model: str | None, schema: dict,
                 config: LLMConfig) -> tuple[str, Usage | None]:
    """Yandex AI Studio through its OpenAI-compatible API. Returns the reply and usage."""
    client = _yandex_client(config)
    uri = yandex_model_uri(config, model)
    name = _yandex_model_name(uri)
    needed, limit = _estimate_tokens(messages), config.yandex_max_context
    if needed > limit:
        raise RuntimeError(f"запись слишком длинная для {name}: ~{needed} токенов вместе с "
                           f"ответом при лимите {limit} (YANDEX_MAX_CONTEXT). Выберите DeepSeek "
                           f"или модель Yandex с большим контекстом")
    request = dict(model=uri, messages=messages, max_tokens=MAX_OUTPUT_TOKENS,
                   temperature=DEEPSEEK_TEMPERATURE)
    # Structured output: the API takes an OpenAI json_schema (a name is required). Not
    # every model or schema construct is supported, so a 400 falls back to plain JSON mode;
    # the schema is in the system prompt anyway and the reply is validated by pydantic.
    formats = [{"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}},
               {"type": "json_object"}]
    label = "Yandex AI Studio"
    for response_format in formats:
        try:
            response = _openai_create(client, label, YANDEX_TIMEOUT, YANDEX_MAX_RETRIES,
                                      response_format=response_format, **request)
            break
        except BadRequestError:
            if response_format["type"] != "json_schema":
                raise
            log.warning("Yandex: json_schema rejected (HTTP 400) for model=%s, "
                        "retrying in json_object mode", name)
        except AuthenticationError:
            raise RuntimeError(f"{label}: ключ API не подошёл (HTTP 401)") from None
        except PermissionDeniedError:
            raise RuntimeError(f"{label}: нет доступа к {name} (HTTP 403) — проверьте ID "
                               f"каталога и роль ai.languageModels.user у сервисного "
                               f"аккаунта ключа") from None
        except NotFoundError:
            raise RuntimeError(f"{label}: модель {name} не найдена (HTTP 404)") from None
    choice = response.choices[0]
    if choice.finish_reason == "length":
        raise RuntimeError(f"ответ {label} обрезан на {MAX_OUTPUT_TOKENS} токенах")
    if choice.finish_reason == "content_filter":
        raise RuntimeError(f"{label} отказался отвечать: сработал фильтр содержимого. "
                           f"Попробуйте DeepSeek или локальную модель")
    usage = response.usage and Usage("yandex", name, "", response.usage.prompt_tokens,
                                     response.usage.completion_tokens, choice.finish_reason)
    return choice.message.content or "", usage


def check_yandex(config: LLMConfig) -> str:
    """Validate the key and folder with a free request (the folder's model list)."""
    client = _yandex_client(config, timeout=15, max_retries=0)
    uri = yandex_model_uri(config)
    try:
        models = [m.id for m in client.models.list()]
    except AuthenticationError:
        raise RuntimeError("ключ API не подошёл") from None
    except PermissionDeniedError:
        raise RuntimeError("нет доступа к каталогу — проверьте ID каталога и роль "
                           "ai.languageModels.user у сервисного аккаунта") from None
    name = _yandex_model_name(uri)
    if uri not in models:
        available = sorted(_yandex_model_name(m) for m in models if m.startswith("gpt://"))
        return f"Ключ работает, но модели {name} нет. Доступны: {', '.join(available)}"
    return f"Ключ работает, модель {name} доступна"


def _ollama_host(config: LLMConfig) -> str:
    host = config.ollama_host
    return host if host.startswith("http") else f"http://{host}"


def _ollama_client() -> httpx.Client:
    # trust_env=False: httpx picks up macOS system proxy settings and would route
    # even localhost through them. Short requests (/api/show, /api/tags) pass their own
    # timeout; this default is for the /api/chat stream.
    return httpx.Client(trust_env=False,
                        timeout=httpx.Timeout(OLLAMA_READ_TIMEOUT, connect=OLLAMA_CONNECT_TIMEOUT))


class OllamaUnavailable(RuntimeError):
    def __init__(self, message: str, reason: str):
        super().__init__(message)
        self.reason = reason  # "not_running" | "model_missing"


def _ollama_context_limit(config: LLMConfig) -> int:
    """Usable context: the model's own limit capped by OLLAMA_MAX_CONTEXT."""
    limit, model, host = config.ollama_max_context, config.ollama_model, _ollama_host(config)
    try:
        with _ollama_client() as client:
            resp = client.post(f"{host}/api/show", json={"model": model}, timeout=10)
    except httpx.TransportError:
        raise OllamaUnavailable(f"Ollama не отвечает на {host}", "not_running") from None
    if resp.status_code != 200:
        raise OllamaUnavailable(f"в Ollama нет модели {model}", "model_missing")
    info = resp.json().get("model_info", {})
    model_ctx = next((v for k, v in info.items() if k.endswith(".context_length")), limit)
    return min(limit, model_ctx)


def ollama_models(config: LLMConfig) -> list[dict]:
    """Models installed in Ollama: [{name, size_bytes}]. Raises OllamaUnavailable."""
    host = _ollama_host(config)
    try:
        with _ollama_client() as client:
            resp = client.get(f"{host}/api/tags", timeout=5)
            resp.raise_for_status()
    except httpx.HTTPError:
        raise OllamaUnavailable(f"Ollama не отвечает на {host}", "not_running") from None
    return [{"name": m["name"], "size_bytes": m.get("size", 0)}
            for m in resp.json().get("models", [])]


def check_deepseek(config: LLMConfig) -> str:
    """Validate the API key with a free request; returns a short status, raises on failure."""
    if not config.deepseek_api_key:
        raise RuntimeError("ключ не задан")
    client = OpenAI(api_key=config.deepseek_api_key, base_url=DEEPSEEK_BASE_URL, timeout=15)
    models = [m.id for m in client.models.list()]
    if config.deepseek_model not in models:
        return (f"Ключ работает, но модели {config.deepseek_model} нет. "
                f"Доступны: {', '.join(models)}")
    return f"Ключ работает, модель {config.deepseek_model} доступна"


def _chat_ollama(messages: list[dict], model: str | None, schema: dict,
                 config: LLMConfig, *,
                 should_stop: StopCallback | None = None) -> tuple[str, Usage | None]:
    """should_stop is polled per chunk; on True the stream is closed (Ollama then stops
    generating) and SummaryCancelled is raised. It can't interrupt the wait for the first
    chunk (model load and prompt eval)."""
    host = _ollama_host(config)
    model = model or config.ollama_model
    num_ctx = _ollama_num_ctx(messages)

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "think": False,
        # Constrains generation to the schema, so the output is always parseable JSON.
        "format": schema,
        "options": {"num_ctx": num_ctx, "num_predict": MAX_OUTPUT_TOKENS, **OLLAMA_SAMPLING},
    }

    parts, usage = [], None
    # disable=None: show only in an interactive terminal, not in server logs.
    bar = tqdm(desc="Генерация", unit=" ток", dynamic_ncols=True, file=sys.stderr, disable=None)
    client = _ollama_client()
    try:
        with bar, client.stream("POST", f"{host}/api/chat", json=payload) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"Ollama: HTTP {resp.status_code}: {resp.read().decode()}")
            for line in resp.iter_lines():
                # Leaving the `with` closes the stream, so Ollama drops the request.
                _check_stop(should_stop)
                chunk = json.loads(line)
                if "error" in chunk:
                    raise RuntimeError(f"Ollama: {chunk['error']}")
                parts.append(chunk.get("message", {}).get("content", ""))
                bar.update(1)
                if chunk.get("done"):
                    # Ollama reports durations in nanoseconds; load > 0 means a cold start.
                    log.debug("Ollama timings: load=%.1fs prompt_eval=%.1fs eval=%.1fs",
                              *(chunk.get(k, 0) / 1e9 for k in
                                ("load_duration", "prompt_eval_duration", "eval_duration")))
                    if chunk.get("done_reason") == "length":
                        raise RuntimeError(f"ответ обрезан на {MAX_OUTPUT_TOKENS} токенах")
                    usage = Usage("ollama", model, "", chunk.get("prompt_eval_count", 0),
                                  chunk.get("eval_count", 0), chunk.get("done_reason"))
    except (httpx.ConnectError, httpx.ConnectTimeout):
        raise RuntimeError(f"Ollama не отвечает на {host} (запустите `ollama serve`)") from None
    except httpx.TimeoutException as e:
        log.warning("Ollama timeout: %s", type(e).__name__)
        raise LLMTimeout(f"Ollama не присылала ответ дольше {OLLAMA_READ_TIMEOUT} с "
                         f"(модель {model} зависла или слишком медленная)") from None
    finally:
        client.close()
    return "".join(parts), usage


def _choose_provider(messages: list[dict], config: LLMConfig) -> str:
    model = config.ollama_model
    needed = _estimate_tokens(messages)
    try:
        limit = _ollama_context_limit(config)
    except RuntimeError as e:
        log.warning("auto provider: deepseek (ollama unavailable: %s)",
                    getattr(e, "reason", type(e).__name__))
        print(f"Локальная модель недоступна ({e}) → DeepSeek", file=sys.stderr)
        return "deepseek"
    if needed <= limit:
        log.info("auto provider: ollama (est_tokens=%d <= limit=%d, model=%s)",
                 needed, limit, model)
        print(f"~{needed} токенов ≤ {limit} → локально ({model})", file=sys.stderr)
        return "ollama"
    log.info("auto provider: deepseek (est_tokens=%d > limit=%d of %s)", needed, limit, model)
    print(f"~{needed} токенов > {limit} (лимит {model}) → DeepSeek", file=sys.stderr)
    return "deepseek"


# (host, model) -> (monotonic time of the check, reason or None if available).
_ollama_status_cache: dict[tuple[str, str], tuple[float, str | None]] = {}
_ollama_status_lock = threading.Lock()


def _ollama_status(config: LLMConfig) -> str | None:
    """Unavailability reason of Ollama (None if it's fine), cached for OLLAMA_STATUS_TTL.

    The lock only guards the dict, not the request: concurrent misses may both check, which
    is harmless, while one slow check doesn't block other keys."""
    key = (_ollama_host(config), config.ollama_model)
    now = time.monotonic()
    with _ollama_status_lock:
        cached = _ollama_status_cache.get(key)
    if cached and now - cached[0] < OLLAMA_STATUS_TTL:
        return cached[1]
    try:
        _ollama_context_limit(config)
        reason = None
    except OllamaUnavailable as e:
        reason = e.reason
    with _ollama_status_lock:
        _ollama_status_cache[key] = (time.monotonic(), reason)
    return reason


def provider_status(config: LLMConfig | None = None) -> dict:
    """Availability of each provider with a machine-readable reason, for UIs.
    The Ollama check is cached for OLLAMA_STATUS_TTL seconds."""
    config = config or LLMConfig.from_env()
    ollama_reason = _ollama_status(config)
    yandex_reason = ("no_api_key" if not config.yandex_api_key
                     else "no_folder_id" if not config.yandex_folder_id else None)
    return {
        "deepseek": {
            "available": bool(config.deepseek_api_key),
            "reason": None if config.deepseek_api_key else "no_api_key",
            "model": config.deepseek_model,
        },
        "ollama": {"available": ollama_reason is None, "reason": ollama_reason,
                   "model": config.ollama_model},
        "yandex": {
            "available": yandex_reason is None,
            "reason": yandex_reason,
            "model": config.yandex_model,
        },
    }


def resolve_provider(transcript: str, provider: str = "auto", config: LLMConfig | None = None,
                     registry: Registry = DEFAULT_REGISTRY,
                     instructions: str | None = None) -> str:
    """Concrete provider for a request: "auto" picks by transcript size and availability.
    Always asks Ollama afresh (no provider_status cache): a stale "available" would send a
    job to a dead Ollama, and it's one request per job anyway."""
    if provider != "auto":
        return provider
    config = config or LLMConfig.from_env()
    instructions = normalize_instructions(instructions)
    # Size against the largest type's prompt: the type may not be known yet.
    largest = max((_messages(transcript, t, registry, instructions) for t in registry.enabled),
                  key=_estimate_tokens)
    return _choose_provider(largest, config)


def _strip_fences(raw: str) -> str:
    # Some models wrap JSON in ```json fences despite JSON mode.
    return re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw)


def _parse(raw: str, summary_type: str, registry: Registry = DEFAULT_REGISTRY) -> SummaryBase:
    return registry.get(summary_type).model.model_validate_json(_strip_fences(raw))


def _error_brief(e: Exception) -> str:
    """An error description safe for logs. API error bodies may echo the request, so
    only their type and status go in; our own RuntimeErrors carry no content."""
    if isinstance(e, APIStatusError):
        return f"{type(e).__name__} (HTTP {e.status_code})"
    if type(e) in (RuntimeError, OllamaUnavailable):
        return f"{type(e).__name__}: {str(e)[:300]}"
    return type(e).__name__


def _validation_brief(e: ValidationError) -> str:
    """Field paths and error types only: pydantic messages quote the offending input."""
    errors = e.errors(include_url=False, include_context=False, include_input=False)
    brief = "; ".join(f"{'.'.join(map(str, err['loc'])) or '<root>'}: {err['type']}"
                      for err in errors[:5])
    return f"{len(errors)} error(s): {brief}" + ("; ..." if len(errors) > 5 else "")


def _chat(provider: str, kind: str, on_usage: UsageCallback | None, messages: list[dict],
          model: str | None, schema: dict, config: LLMConfig, *, attempt: int = 1,
          should_stop: StopCallback | None = None) -> str:
    _check_stop(should_stop)
    chat = {"ollama": _chat_ollama, "yandex": _chat_yandex}.get(provider, _chat_deepseek)
    # DeepSeek and Yandex aren't streamed, so they're only checked around the request. Passed
    # only when set, so _chat_* stubs with the plain (messages, model, schema, config)
    # signature work.
    stop_kw = {"should_stop": should_stop} if provider == "ollama" and should_stop else {}
    model_name = model or {"ollama": config.ollama_model,
                           "yandex": config.yandex_model}.get(provider, config.deepseek_model)
    chars = _prompt_chars(messages)
    extra = f" num_ctx={_ollama_num_ctx(messages)}" if provider == "ollama" else ""
    log.info("LLM request: provider=%s model=%s kind=%s attempt=%d prompt_chars=%d "
             "est_prompt_tokens=%d%s", provider, model_name, kind, attempt, chars,
             chars // CHARS_PER_TOKEN, extra)
    started = time.monotonic()
    try:
        raw, usage = chat(messages, model, schema, config, **stop_kw)
    except SummaryCancelled:
        log.info("LLM request cancelled: provider=%s kind=%s attempt=%d elapsed=%.1fs",
                 provider, kind, attempt, time.monotonic() - started)
        raise
    except Exception as e:
        log.warning("LLM request failed: provider=%s kind=%s attempt=%d elapsed=%.1fs: %s",
                    provider, kind, attempt, time.monotonic() - started, _error_brief(e))
        raise
    elapsed = time.monotonic() - started
    if usage:
        log.info("LLM done: provider=%s kind=%s attempt=%d elapsed=%.1fs prompt_tokens=%d "
                 "completion_tokens=%d finish=%s reply_chars=%d", provider, kind, attempt,
                 elapsed, usage.prompt_tokens, usage.completion_tokens, usage.finish_reason,
                 len(raw))
        if on_usage:
            on_usage(Usage(usage.provider, usage.model, kind, usage.prompt_tokens,
                           usage.completion_tokens, usage.finish_reason))
    else:
        log.info("LLM done: provider=%s kind=%s attempt=%d elapsed=%.1fs reply_chars=%d "
                 "(no usage reported)", provider, kind, attempt, elapsed, len(raw))
    return raw


def classify(transcript: str, provider: str, model: str | None = None, *,
             config: LLMConfig | None = None, registry: Registry = DEFAULT_REGISTRY,
             on_usage: UsageCallback | None = None,
             should_stop: StopCallback | None = None) -> str:
    """Detect the summary type from the opening of the transcript; falls back to "meeting".
    Raises SummaryCancelled if should_stop() turns True."""
    config = config or LLMConfig.from_env()
    classification = _classification_model(registry)
    raw = _chat(provider, "classify", on_usage, _classify_messages(transcript, registry), model,
                classification.model_json_schema(), config, should_stop=should_stop)
    try:
        meeting_type = classification.model_validate_json(_strip_fences(raw)).meeting_type
    except ValidationError as e:
        fallback = registry.fallback
        log.warning("classify: invalid answer (%s), fallback type=%s", _validation_brief(e),
                    fallback)
        print(f"Не удалось определить тип записи, используем «{registry.get(fallback).label}»",
              file=sys.stderr)
        return fallback
    log.info("classify: type=%s", meeting_type)
    return meeting_type


def summarize(transcript: str, provider: str = "auto", model: str | None = None,
              summary_type: str = "auto", *, config: LLMConfig | None = None,
              registry: Registry = DEFAULT_REGISTRY,
              on_usage: UsageCallback | None = None,
              instructions: str | None = None,
              should_stop: StopCallback | None = None) -> SummaryBase:
    """provider: "auto" runs locally if the transcript fits the local model, else DeepSeek;
    "yandex" is only used when chosen explicitly.
    summary_type: a registry type, or "auto" to detect it with a short extra request.
    on_usage is called with the tokens of every model request.
    instructions: the user's wishes for this summary, sent after the transcript and ranked
    below the rules and the schema; they don't affect classification.
    should_stop is polled before and after every request and between Ollama stream chunks;
    once it returns True, SummaryCancelled is raised."""
    _check_stop(should_stop)
    config = config or LLMConfig.from_env()
    instructions = normalize_instructions(instructions)
    provider = resolve_provider(transcript, provider, config, registry, instructions)
    if summary_type == "auto":
        summary_type = classify(transcript, provider, model, config=config, registry=registry,
                                on_usage=on_usage, should_stop=should_stop)
        print(f"Тип записи: {registry.get(summary_type).label}", file=sys.stderr)
    if instructions:
        # User input: only its size goes to the log.
        log.info("summary: user instructions_chars=%d", len(instructions))
    messages = _messages(transcript, summary_type, registry, instructions)
    schema = registry.get(summary_type).model.model_json_schema()

    for attempt in range(1, MAX_ATTEMPTS + 1):
        raw = _chat(provider, "summary", on_usage, messages, model, schema, config,
                    attempt=attempt, should_stop=should_stop)
        # A DeepSeek/Yandex request can't be interrupted: drop its result if cancelled meanwhile.
        _check_stop(should_stop)
        try:
            result = _parse(raw, summary_type, registry)
        except ValidationError as e:
            error = str(e)[:2000]
            if attempt == MAX_ATTEMPTS:
                log.error("summary: reply failed schema validation, giving up after %d "
                          "attempts (type=%s, %s)", attempt, summary_type, _validation_brief(e))
                raise RuntimeError(f"ответ модели не соответствует схеме:\n{error}") from None
            log.warning("summary: reply failed schema validation, retrying (attempt %d/%d, "
                        "type=%s, %s)", attempt, MAX_ATTEMPTS, summary_type, _validation_brief(e))
            print("Ответ не прошёл проверку, повторная попытка...", file=sys.stderr)
            messages = messages + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": "Ответ не прошёл проверку по JSON-схеме:\n"
                                            f"{error}\n\nВерни исправленный JSON целиком."},
            ]
            continue
        if sanitize := registry.get(summary_type).sanitize:
            result, removed = sanitize(result)
            if removed:
                log.info("sanitize: removed %d fragment(s) with personal data (type=%s)",
                         removed, summary_type)
                print(f"Удалено фрагментов с личными данными: {removed}", file=sys.stderr)
        return result
    raise AssertionError("unreachable")


def save_summary(summary: SummaryBase, transcript: str, md_path: Path, docx: bool = True,
                 registry: Registry = DEFAULT_REGISTRY) -> None:
    """Write <name>.summary.md, .json and (unless docx=False) .docx side by side."""
    md = registry.render_markdown(summary, transcript_duration(transcript))
    md_path.write_text(md, encoding="utf-8")
    if docx:
        save_docx(md, md_path.with_suffix(".docx"))
    md_path.with_suffix(".json").write_text(
        summary.model_dump_json(indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Summary готовой расшифровки")
    parser.add_argument("transcript", help="путь к .txt с расшифровкой")
    parser.add_argument("-o", "--output", help="куда сохранить (по умолчанию <файл>.summary.md)")
    parser.add_argument("-p", "--provider", choices=PROVIDERS, default="auto",
                        help="auto (локально, если влезает в контекст, иначе DeepSeek), "
                             "deepseek (API), ollama (локальная модель) или yandex "
                             "(YandexGPT в Yandex Cloud)")
    parser.add_argument("--model", help=f"модель для -p deepseek/ollama/yandex (по умолчанию "
                                         f"{DEEPSEEK_DEFAULT_MODEL} / {OLLAMA_DEFAULT_MODEL} / "
                                         f"{YANDEX_DEFAULT_MODEL})")
    parser.add_argument("-t", "--type", choices=SUMMARY_TYPES, default="auto", dest="summary_type",
                        help="тип записи: "
                             + ", ".join(f"{t.id} — {t.label}" for t in TYPES.values())
                             + "; auto — определить по расшифровке")
    parser.add_argument("-i", "--instructions",
                        help="пожелания к summary, например «подробнее про задачи»; "
                             "правила типа и схема важнее")
    args = parser.parse_args()
    setup_logging(CLI_DEFAULT)
    if args.model and args.provider == "auto":
        parser.error("--model задаётся вместе с -p deepseek, -p ollama или -p yandex "
                     "(для auto используйте DEEPSEEK_MODEL / OLLAMA_MODEL в .env)")

    src = Path(args.transcript)
    out_path = Path(args.output) if args.output else src.with_suffix(".summary.md")
    transcript = src.read_text(encoding="utf-8")
    print(f"Генерация summary ({args.provider})...", file=sys.stderr)
    save_summary(summarize(transcript, args.provider, args.model, args.summary_type,
                           instructions=args.instructions),
                 transcript, out_path)
    print(f"Summary: {out_path} (+ .json, .docx)", file=sys.stderr)


if __name__ == "__main__":
    main()
