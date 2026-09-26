"""Whisper model download: the `download-model` command, also run by the Docker `models`
service before the server starts (the server itself runs with HF_HUB_OFFLINE=1).

Idempotent and atomic: a model counts as present when its directory has model.bin, and it
is downloaded into a hidden `.<name>.partial` sibling that is renamed only when complete,
so an interrupted download never leaves a broken model behind (and is resumed next time).
"""

import argparse
import fnmatch
import os
import shutil
import sys
import threading
import time
from pathlib import Path

from .cli import default_model

PREFIX = "faster-whisper-"
# The same files faster_whisper.download_model fetches.
ALLOW_PATTERNS = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json",
                  "vocabulary.*"]


def is_complete(path: Path) -> bool:
    return (path / "model.bin").is_file() and (path / "config.json").is_file()


def repo_for(path: Path) -> str | None:
    """Hugging Face repo of a model directory named faster-whisper-<size>, e.g.
    faster-whisper-large-v3-turbo → mobiuslabsgmbh/faster-whisper-large-v3-turbo."""
    from faster_whisper.utils import _MODELS

    if not path.name.startswith(PREFIX):
        return None
    return _MODELS.get(path.name.removeprefix(PREFIX))


def _size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _expected_size(repo: str) -> int | None:
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo, files_metadata=True)
        return sum(s.size or 0 for s in info.siblings
                   if any(fnmatch.fnmatch(s.rfilename, p) for p in ALLOW_PATTERNS))
    except Exception:  # noqa: BLE001 — only used for the progress message
        return None


def download(path: Path) -> None:
    # Plain HTTP instead of Xet: partial files stay in .partial/.cache (resumable from the
    # bind mount, measurable for progress) rather than in a chunk cache under HOME.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from faster_whisper.utils import disabled_tqdm
    from huggingface_hub import snapshot_download

    repo = repo_for(path)
    if repo is None:
        sys.exit(f"Модели нет в {path}, и непонятно, откуда её скачать: ожидается папка "
                 f"{PREFIX}<размер> (например {PREFIX}large-v3-turbo) или готовая модель "
                 "с model.bin")
    if path.exists() and any(path.iterdir()):
        sys.exit(f"В {path} что-то есть, но нет model.bin — удалите папку или положите "
                 "модель целиком, скачивание не будет её перезаписывать")

    partial = path.with_name(f".{path.name}.partial")
    total = _expected_size(repo)
    print(f"Скачивание модели {repo} в {path}"
          + (f" ({total / 2**30:.1f} ГБ)" if total else "") + "...", flush=True)
    started = time.monotonic()
    done = threading.Event()

    def report():
        while not done.wait(15):
            size = _size(partial) if partial.exists() else 0
            size = min(size, total) if total else size  # stale .incomplete after a restart
            pct = f" из {total / 2**20:.0f} ({size / total:.0%})" if total else ""
            print(f"  {size / 2**20:.0f} МБ{pct}, {time.monotonic() - started:.0f} с", flush=True)

    threading.Thread(target=report, daemon=True).start()
    try:
        snapshot_download(repo, local_dir=partial, allow_patterns=ALLOW_PATTERNS,
                          tqdm_class=disabled_tqdm)  # own progress lines suit docker logs
    except Exception as e:  # noqa: BLE001 — network, proxy, disk space
        sys.exit(f"Не удалось скачать модель: {e}\nЧастично скачанное осталось в {partial}, "
                 "следующий запуск продолжит скачивание")
    finally:
        done.set()
    if not is_complete(partial):
        sys.exit(f"Скачивание завершилось, но в {partial} нет model.bin")
    shutil.rmtree(partial / ".cache", ignore_errors=True)  # huggingface_hub resume metadata
    if path.exists():
        path.rmdir()  # empty (checked above)
    partial.rename(path)
    print(f"Модель скачана за {time.monotonic() - started:.0f} с: {path}", flush=True)


def _prepare_dirs(owner: str, dirs: list[Path]) -> None:
    """Docker: bind-mount sources that Docker Engine created itself are owned by root on
    Linux, so the unprivileged server couldn't write there. Hand such directories over to
    the server's UID:GID, then drop root for the download."""
    uid, gid = (int(x) for x in owner.split(":"))
    if os.geteuid() != 0:
        return
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
        if d.stat().st_uid == 0 and uid != 0:  # only fresh, root-owned ones: never user data
            os.chown(d, uid, gid)
    if uid != 0:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
        # HOME is still /root; huggingface_hub keeps its token and locks under it.
        try:
            import pwd

            os.environ["HOME"] = pwd.getpwuid(uid).pw_dir
        except KeyError:  # a UID with no user in the image
            os.environ["HOME"] = "/tmp"


def main():
    parser = argparse.ArgumentParser(
        description="Скачать модель распознавания, если её ещё нет (WHISPER_MODEL из .env, "
                    "по умолчанию models/faster-whisper-large-v3-turbo)")
    parser.add_argument("model", nargs="?", default=None,
                        help="папка модели (по умолчанию — WHISPER_MODEL)")
    parser.add_argument("--owner", metavar="UID:GID",
                        help="для Docker: запущено от root — отдать свежие папки --prepare "
                             "этому пользователю и качать от его имени")
    parser.add_argument("--prepare", nargs="*", type=Path, default=[], metavar="DIR",
                        help="для Docker: папки, которые должны быть доступны на запись")
    args = parser.parse_args()

    path = Path(args.model or default_model())
    if args.owner:
        _prepare_dirs(args.owner, [path.parent, *args.prepare])
    if is_complete(path):
        print(f"Модель уже на месте: {path}", flush=True)
        return
    download(path)


if __name__ == "__main__":
    main()
