"""Structured meeting summary via DeepSeek API or a local Ollama model."""

import argparse
import json
import os
import re
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv
from openai import OpenAI
from pydantic import ValidationError
from tqdm import tqdm

from meeting_summary import MeetingSummary, render_markdown, system_prompt, transcript_duration

PROVIDERS = ("auto", "deepseek", "ollama")

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_DEFAULT_MODEL = "deepseek-flash"
# Thinking mode is on by default and reasoning tokens count against max_tokens
# (~3k on a 35-minute meeting), so leave plenty of room for the JSON itself.
DEEPSEEK_MAX_TOKENS = 32768

OLLAMA_DEFAULT_HOST = "http://localhost:11434"
OLLAMA_DEFAULT_MODEL = "qwen3.5:4b"
# Practical limit for a small model on 16 GB: quality and speed drop well before the
# model's nominal context. Override with OLLAMA_MAX_CONTEXT.
OLLAMA_DEFAULT_MAX_CONTEXT = 32768
# Qwen tokenizer gives ~3.6 chars/token on Russian; 3 overestimates on purpose.
CHARS_PER_TOKEN = 3

MAX_OUTPUT_TOKENS = 8192
TEMPERATURE = 0.3
MAX_ATTEMPTS = 2


def _messages(transcript: str) -> list[dict]:
    schema = json.dumps(MeetingSummary.model_json_schema(), ensure_ascii=False)
    system = f"{system_prompt()}\n## JSON-схема ответа\n\n```json\n{schema}\n```\n"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"Расшифровка:\n\n{transcript}"},
    ]


def _estimate_tokens(messages: list[dict]) -> int:
    """Upper-bound estimate of prompt + response tokens for a local model."""
    return sum(len(m["content"]) for m in messages) // CHARS_PER_TOKEN + MAX_OUTPUT_TOKENS


def _chat_deepseek(messages: list[dict], model: str | None) -> str:
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY не задан (добавьте его в .env)")

    client = OpenAI(api_key=api_key, base_url=DEEPSEEK_BASE_URL, timeout=600)
    response = client.chat.completions.create(
        model=model or os.getenv("DEEPSEEK_MODEL", DEEPSEEK_DEFAULT_MODEL),
        messages=messages,
        response_format={"type": "json_object"},
        max_tokens=DEEPSEEK_MAX_TOKENS,
        temperature=TEMPERATURE,
    )
    choice = response.choices[0]
    if choice.finish_reason == "length":
        raise RuntimeError(f"ответ DeepSeek обрезан на {DEEPSEEK_MAX_TOKENS} токенах")
    return choice.message.content or ""


def _ollama_host() -> str:
    host = os.getenv("OLLAMA_HOST", OLLAMA_DEFAULT_HOST)
    return host if host.startswith("http") else f"http://{host}"


def _ollama_client() -> httpx.Client:
    # trust_env=False: httpx picks up macOS system proxy settings and would route
    # even localhost through them.
    return httpx.Client(trust_env=False, timeout=None)


def _ollama_context_limit(model: str) -> int:
    """Usable context: the model's own limit capped by OLLAMA_MAX_CONTEXT."""
    limit = int(os.getenv("OLLAMA_MAX_CONTEXT", OLLAMA_DEFAULT_MAX_CONTEXT))
    try:
        with _ollama_client() as client:
            resp = client.post(f"{_ollama_host()}/api/show", json={"model": model}, timeout=10)
    except httpx.TransportError:
        raise RuntimeError(f"Ollama не отвечает на {_ollama_host()}") from None
    if resp.status_code != 200:
        raise RuntimeError(f"в Ollama нет модели {model}")
    info = resp.json().get("model_info", {})
    model_ctx = next((v for k, v in info.items() if k.endswith(".context_length")), limit)
    return min(limit, model_ctx)


def _chat_ollama(messages: list[dict], model: str | None) -> str:
    host = _ollama_host()
    # Ollama's default context window is small and silently truncates long prompts,
    # so size it to the request.
    num_ctx = -(-_estimate_tokens(messages) // 4096) * 4096

    payload = {
        "model": model or os.getenv("OLLAMA_MODEL", OLLAMA_DEFAULT_MODEL),
        "messages": messages,
        "stream": True,
        "think": False,
        # Constrains generation to the schema, so the output is always parseable JSON.
        "format": MeetingSummary.model_json_schema(),
        "options": {"num_ctx": num_ctx, "num_predict": MAX_OUTPUT_TOKENS,
                    "temperature": TEMPERATURE},
    }

    parts = []
    bar = tqdm(desc="Генерация", unit=" ток", dynamic_ncols=True, file=sys.stderr)
    client = _ollama_client()
    try:
        with bar, client.stream("POST", f"{host}/api/chat", json=payload) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"Ollama: HTTP {resp.status_code}: {resp.read().decode()}")
            for line in resp.iter_lines():
                chunk = json.loads(line)
                if "error" in chunk:
                    raise RuntimeError(f"Ollama: {chunk['error']}")
                parts.append(chunk.get("message", {}).get("content", ""))
                bar.update(1)
                if chunk.get("done") and chunk.get("done_reason") == "length":
                    raise RuntimeError(f"ответ обрезан на {MAX_OUTPUT_TOKENS} токенах")
    except httpx.ConnectError:
        raise RuntimeError(f"Ollama не отвечает на {host} (запустите `ollama serve`)") from None
    finally:
        client.close()
    return "".join(parts)


def _choose_provider(messages: list[dict]) -> str:
    model = os.getenv("OLLAMA_MODEL", OLLAMA_DEFAULT_MODEL)
    needed = _estimate_tokens(messages)
    try:
        limit = _ollama_context_limit(model)
    except RuntimeError as e:
        print(f"Локальная модель недоступна ({e}) → DeepSeek", file=sys.stderr)
        return "deepseek"
    if needed <= limit:
        print(f"~{needed} токенов ≤ {limit} → локально ({model})", file=sys.stderr)
        return "ollama"
    print(f"~{needed} токенов > {limit} (лимит {model}) → DeepSeek", file=sys.stderr)
    return "deepseek"


def _parse(raw: str) -> MeetingSummary:
    # Some models wrap JSON in ```json fences despite JSON mode.
    raw = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw)
    return MeetingSummary.model_validate_json(raw)


def summarize(transcript: str, provider: str = "auto", model: str | None = None) -> MeetingSummary:
    """provider: "auto" runs locally if the transcript fits the local model, else DeepSeek."""
    load_dotenv()
    messages = _messages(transcript)
    if provider == "auto":
        provider = _choose_provider(messages)
    chat = _chat_ollama if provider == "ollama" else _chat_deepseek

    for attempt in range(1, MAX_ATTEMPTS + 1):
        raw = chat(messages, model)
        try:
            return _parse(raw)
        except ValidationError as e:
            error = str(e)[:2000]
            if attempt == MAX_ATTEMPTS:
                raise RuntimeError(f"ответ модели не соответствует схеме:\n{error}") from None
            print("Ответ не прошёл проверку, повторная попытка...", file=sys.stderr)
            messages = messages + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": "Ответ не прошёл проверку по JSON-схеме:\n"
                                            f"{error}\n\nВерни исправленный JSON целиком."},
            ]
    raise AssertionError("unreachable")


def save_summary(summary: MeetingSummary, transcript: str, md_path: Path) -> None:
    """Write <name>.summary.md and <name>.summary.json side by side."""
    md_path.write_text(render_markdown(summary, transcript_duration(transcript)),
                       encoding="utf-8")
    md_path.with_suffix(".json").write_text(
        summary.model_dump_json(indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Summary готовой расшифровки")
    parser.add_argument("transcript", help="путь к .txt с расшифровкой")
    parser.add_argument("-o", "--output", help="куда сохранить (по умолчанию <файл>.summary.md)")
    parser.add_argument("-p", "--provider", choices=PROVIDERS, default="auto",
                        help="auto (локально, если влезает в контекст, иначе DeepSeek), "
                             "deepseek (API) или ollama (локальная модель)")
    parser.add_argument("--model", help=f"модель для -p deepseek/ollama (по умолчанию "
                                         f"{DEEPSEEK_DEFAULT_MODEL} / {OLLAMA_DEFAULT_MODEL})")
    args = parser.parse_args()
    if args.model and args.provider == "auto":
        parser.error("--model задаётся вместе с -p deepseek или -p ollama "
                     "(для auto используйте DEEPSEEK_MODEL / OLLAMA_MODEL в .env)")

    src = Path(args.transcript)
    out_path = Path(args.output) if args.output else src.with_suffix(".summary.md")
    transcript = src.read_text(encoding="utf-8")
    print(f"Генерация summary ({args.provider})...", file=sys.stderr)
    save_summary(summarize(transcript, args.provider, args.model), transcript, out_path)
    print(f"Summary: {out_path} (+ {out_path.with_suffix('.json').name})", file=sys.stderr)


if __name__ == "__main__":
    main()
