import argparse
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from faster_whisper import WhisperModel
from tqdm import tqdm

from .log import CLI_DEFAULT, setup_logging
from .summary_types import TYPES

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
DEFAULT_MODEL_DIR = "faster-whisper-large-v3-turbo"
# CTranslate2 (the faster-whisper backend) has no Metal support, so "cpu" is the only
# sensible device on a Mac; int8 is noticeably faster than float32 with little quality
# loss for this model size.
DEVICE, COMPUTE_TYPE = "cpu", "int8"

# Metadata only (timings, sizes, language) — never the recognized text. See log.py.
log = logging.getLogger(__name__)


def fmt_time(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def get_duration(path: str) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, check=True,
        ).stdout
        return float(out.strip())
    except (subprocess.CalledProcessError, ValueError):
        return None


def default_model() -> str:
    """WHISPER_MODEL from .env: a model directory, relative to models/ or absolute
    (default models/faster-whisper-large-v3-turbo). See transcriber.models for download."""
    load_dotenv()
    return str(MODELS_DIR / (os.environ.get("WHISPER_MODEL", "").strip() or DEFAULT_MODEL_DIR))


def default_language() -> str | None:
    """WHISPER_LANGUAGE from .env: an ISO code (default "ru"), or "auto" to
    autodetect (None — faster-whisper's own convention for "detect the language")."""
    load_dotenv()
    lang = os.environ.get("WHISPER_LANGUAGE", "ru").strip().lower()
    return None if lang == "auto" else lang


def load_model(path: str) -> WhisperModel:
    """Load a Whisper model (a couple of seconds, ~2 GB of memory for large-v3-turbo)."""
    started = time.monotonic()
    try:
        model = WhisperModel(path, device=DEVICE, compute_type=COMPUTE_TYPE)
    except Exception as e:
        log.error("Whisper model failed to load: path=%s: %s: %s", path, type(e).__name__,
                  str(e)[:300])
        raise
    log.info("Whisper model loaded: path=%s device=%s compute_type=%s elapsed=%.1fs",
             path, DEVICE, COMPUTE_TYPE, time.monotonic() - started)
    return model


def transcribe(audio_path: str, model: str | WhisperModel, language: str | None = "ru"):
    """Yield (start_seconds, text) for each recognized phrase, interleaved with
    processed seconds of audio (float) for progress reporting.

    `model` is a model directory/name or an already loaded WhisperModel (loading takes
    a couple of seconds, so long-running callers should load it once and reuse it).
    `language` is an ISO code, or None to autodetect. Silence and non-speech are
    skipped via Silero VAD (`vad_filter`) rather than sent to the model.
    """
    if isinstance(model, str):
        model = load_model(model)

    started, phrases, audio_sec, processed, outcome = time.monotonic(), 0, 0.0, 0.0, "stopped"
    try:
        # Lazy: VAD and language detection run here, decoding runs while iterating.
        segments, info = model.transcribe(audio_path, language=language, vad_filter=True)
        audio_sec = info.duration
        log.info("Whisper: language=%s (%s, p=%.2f) audio=%.1fs speech_after_vad=%.1fs",
                 info.language, "given" if language else "detected",
                 info.language_probability, info.duration, info.duration_after_vad)
        for segment in segments:
            text = segment.text.strip()
            if text:
                phrases += 1
                yield segment.start, text
            processed = segment.end
            yield segment.end
        outcome, processed = "done", audio_sec
    except Exception as e:  # noqa: BLE001 — e.g. ffmpeg couldn't decode the file
        outcome = "failed"
        log.error("Whisper transcription failed: %s: %s", type(e).__name__, str(e)[:300])
        raise RuntimeError(f"Не удалось распознать файл: {e}") from e
    finally:
        # "stopped": the caller closed the generator early (a cancelled server job).
        if outcome != "failed":
            elapsed = time.monotonic() - started
            log.info("Whisper %s: phrases=%d audio=%.1fs elapsed=%.1fs speed=%.1fx realtime",
                     outcome, phrases, processed, elapsed, processed / elapsed if elapsed else 0)


def main():
    parser = argparse.ArgumentParser(description="Транскрибация аудио/видео через faster-whisper")
    parser.add_argument("audio", help="путь к файлу (любой формат, который понимает ffmpeg)")
    parser.add_argument("-m", "--model", default=None,
                        help="папка или имя модели Whisper (по умолчанию — WHISPER_MODEL из .env, "
                             "иначе models/faster-whisper-large-v3-turbo)")
    parser.add_argument("-o", "--output", help="куда сохранить текст (по умолчанию <файл>.txt)")
    parser.add_argument("--language", default=None,
                        help="код языка (по умолчанию — WHISPER_LANGUAGE из .env, иначе ru); "
                             "auto — определять автоматически")
    parser.add_argument("--no-summary", action="store_true", help="не делать summary")
    parser.add_argument("-p", "--provider", choices=("auto", "deepseek", "ollama", "yandex"),
                        default="auto",
                        help="чем делать summary: auto (локально, если влезает в контекст, "
                             "иначе DeepSeek), deepseek (API), ollama (локальная модель) или "
                             "yandex (YandexGPT в Yandex Cloud)")
    parser.add_argument("-t", "--type", default="auto", dest="summary_type",
                        choices=("auto", *TYPES),
                        help="тип записи для summary; auto — определить по расшифровке")
    args = parser.parse_args()
    setup_logging(CLI_DEFAULT)

    args.model = args.model or default_model()
    language = default_language() if args.language is None else \
        (None if args.language.strip().lower() == "auto" else args.language)
    out_path = Path(args.output) if args.output else Path(args.audio).with_suffix(".txt")
    summary_path = out_path.with_suffix(".summary.md")
    duration = get_duration(args.audio)

    print(f"Загрузка модели {args.model}...", file=sys.stderr)
    started = time.monotonic()
    phrases: list[tuple[float, str]] = []

    bar = tqdm(
        total=round(duration) if duration else None,
        unit="s", desc="Транскрибация", dynamic_ncols=True,
        bar_format="{desc}: {percentage:3.0f}%|{bar}| {n_fmt}/{total_fmt} с аудио "
                   "[{elapsed}<{remaining}]{postfix}",
    )

    try:
        with out_path.open("w", encoding="utf-8") as out, bar:
            for item in transcribe(args.audio, args.model, language):
                if isinstance(item, float):
                    bar.update(round(item) - bar.n)
                    continue
                start, text = item
                out.write(f"[{fmt_time(start)}] {text}\n")
                out.flush()
                phrases.append(item)
                bar.set_postfix_str(f"фраз: {len(phrases)}", refresh=False)
    except RuntimeError as e:
        sys.exit(str(e))

    transcript = "".join(f"[{fmt_time(start)}] {text}\n" for start, text in phrases)
    print(f"Распознано за {fmt_time(time.monotonic() - started)}. Текст: {out_path}",
          file=sys.stderr)

    if not args.no_summary and transcript:
        from .summary import save_summary, summarize

        print(f"Генерация summary ({args.provider})...", file=sys.stderr)
        try:
            save_summary(summarize(transcript, args.provider, summary_type=args.summary_type),
                         transcript, summary_path)
            print(f"Summary: {summary_path} (+ .json, .docx)", file=sys.stderr)
        except Exception as e:
            print(f"Summary не получилось: {e}\n"
                  f"Повторить отдельно: uv run summarize {out_path} -p {args.provider} "
                  f"-t {args.summary_type}",
                  file=sys.stderr)

    print(f"Всё готово за {fmt_time(time.monotonic() - started)}", file=sys.stderr)


if __name__ == "__main__":
    main()
