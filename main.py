import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from tqdm import tqdm
from vosk import KaldiRecognizer, Model, SetLogLevel

DEFAULT_MODEL = "models/vosk-model-ru-0.42"
SAMPLE_RATE = 16000
CHUNK_BYTES = 8000  # 0.25 s of 16-bit mono audio


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


def transcribe(audio_path: str, model_path: str):
    """Yield (start_seconds, text) for each recognized phrase."""
    rec = KaldiRecognizer(Model(model_path), SAMPLE_RATE)
    rec.SetWords(True)

    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-i", audio_path,
         "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"],
        stdout=subprocess.PIPE,
    )

    def phrase(result_json: str):
        res = json.loads(result_json)
        if res.get("text"):
            start = res["result"][0]["start"] if res.get("result") else 0.0
            return start, res["text"]
        return None

    processed = 0
    while data := ffmpeg.stdout.read(CHUNK_BYTES):
        processed += len(data)
        if rec.AcceptWaveform(data):
            if p := phrase(rec.Result()):
                yield p
        yield processed / (SAMPLE_RATE * 2)  # progress in seconds of audio

    if p := phrase(rec.FinalResult()):
        yield p

    if ffmpeg.wait() != 0:
        sys.exit("ffmpeg не смог декодировать файл")


def main():
    parser = argparse.ArgumentParser(description="Транскрибация аудио/видео через Vosk")
    parser.add_argument("audio", help="путь к файлу (любой формат, который понимает ffmpeg)")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help="папка с моделью Vosk")
    parser.add_argument("-o", "--output", help="куда сохранить текст (по умолчанию <файл>.txt)")
    parser.add_argument("--no-punct", action="store_true", help="не расставлять пунктуацию")
    parser.add_argument("--no-summary", action="store_true", help="не делать summary")
    parser.add_argument("-p", "--provider", choices=("auto", "deepseek", "ollama"),
                        default="auto",
                        help="чем делать summary: auto (локально, если влезает в контекст, "
                             "иначе DeepSeek), deepseek (API) или ollama (локальная модель)")
    args = parser.parse_args()

    SetLogLevel(-1)
    out_path = Path(args.output) if args.output else Path(args.audio).with_suffix(".txt")
    raw_path = out_path.with_suffix(".raw.txt")
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

    with raw_path.open("w", encoding="utf-8") as raw, bar:
        for item in transcribe(args.audio, args.model):
            if isinstance(item, float):
                bar.update(round(item) - bar.n)
                continue
            start, text = item
            raw.write(f"[{fmt_time(start)}] {text}\n")
            raw.flush()
            phrases.append(item)
            bar.set_postfix_str(f"фраз: {len(phrases)}", refresh=False)

    print(f"Распознано за {fmt_time(time.monotonic() - started)}. Сырой текст: {raw_path}",
          file=sys.stderr)

    texts = [text for _, text in phrases]
    if not args.no_punct and texts:
        print("Расстановка пунктуации...", file=sys.stderr)
        from punctuation import Punctuator

        texts = Punctuator().punctuate(texts)

    transcript = "".join(f"[{fmt_time(start)}] {text}\n"
                         for (start, _), text in zip(phrases, texts))
    out_path.write_text(transcript, encoding="utf-8")
    print(f"Текст: {out_path}", file=sys.stderr)

    if not args.no_summary and transcript:
        from summary import save_summary, summarize

        print(f"Генерация summary ({args.provider})...", file=sys.stderr)
        try:
            save_summary(summarize(transcript, args.provider), transcript, summary_path)
            print(f"Summary: {summary_path} (+ {summary_path.with_suffix('.json').name})",
                  file=sys.stderr)
        except Exception as e:
            print(f"Summary не получилось: {e}\n"
                  f"Повторить отдельно: uv run summary.py {out_path} -p {args.provider}",
                  file=sys.stderr)

    print(f"Всё готово за {fmt_time(time.monotonic() - started)}", file=sys.stderr)


if __name__ == "__main__":
    main()
