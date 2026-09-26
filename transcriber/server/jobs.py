"""Recordings: the processing pipeline, the job queue and its persistence."""

import json
import secrets
import shutil
import subprocess
import threading
from contextlib import closing
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from .. import summary as summary_mod
from ..cli import COMPUTE_TYPE, DEVICE, default_model, fmt_time, get_duration, transcribe
from ..summary import LLMConfig, Usage
from ..summary_types import Registry, SummaryBase
from .db import JobRecord, UsageRecord, iso

STAGES = ("transcribing", "summarizing")
# Formats every major browser can play; anything else gets an AAC copy for the player.
BROWSER_AUDIO = {".mp3", ".m4a", ".aac", ".wav"}
PLAYBACK_FILE = "audio.m4a"
WHISPER_MODEL_NAME = "whisper-large-v3-turbo"


class Cancelled(Exception):
    pass


class Pipeline:
    """The real processing steps. The model loads on first use and stays in memory."""

    def __init__(self):
        self._model = None

    def duration(self, path: str) -> float | None:
        return get_duration(path)

    def transcribe(self, path: str, language: str | None):
        if self._model is None:
            from faster_whisper import WhisperModel

            self._model = WhisperModel(default_model(), device=DEVICE, compute_type=COMPUTE_TYPE)
        return transcribe(path, self._model, language)

    def resolve_provider(self, transcript: str, provider: str, config: LLMConfig,
                         registry: Registry) -> str:
        return summary_mod.resolve_provider(transcript, provider, config, registry)

    def summarize(self, transcript: str, provider: str, summary_type: str, *,
                  config: LLMConfig, registry: Registry, on_usage) -> SummaryBase:
        return summary_mod.summarize(transcript, provider, summary_type=summary_type,
                                     config=config, registry=registry, on_usage=on_usage)

    def provider_status(self, config: LLMConfig) -> dict:
        return summary_mod.provider_status(config)


def _stages() -> dict:
    return {s: {"status": "pending", "started_at": None, "finished_at": None} for s in STAGES}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


@dataclass
class Job:
    id: str
    user_id: int
    filename: str
    source: str  # file name inside the job directory
    created_at: str
    duration_sec: float | None
    options: dict
    status: str = "queued"  # queued | running | done | error
    stage: str | None = None
    stages: dict = field(default_factory=_stages)
    processed_sec: float = 0.0
    error: str | None = None
    summary_error: str | None = None
    provider_used: str | None = None
    transcript: list[dict] = field(default_factory=list)  # [{start_sec, text}]
    summary: dict | None = None
    cancelled: bool = False  # runtime only, not persisted

    def transcript_text(self) -> str:
        return "".join(f"[{fmt_time(p['start_sec'])}] {p['text']}\n" for p in self.transcript)

    def progress_pct(self) -> int:
        if self.status == "done":
            return 100
        if self.status != "running" or self.stage is None:
            return 0
        lo, hi = {"transcribing": (0, 95), "summarizing": (95, 100)}[self.stage]
        frac = 0.0
        if self.stage == "transcribing" and self.duration_sec:
            frac = min(self.processed_sec / self.duration_sec, 1.0)
        return round(lo + (hi - lo) * frac)

    @classmethod
    def from_record(cls, r: JobRecord) -> "Job":
        return cls(id=r.id, user_id=r.user_id, filename=r.filename, source=r.source,
                   created_at=iso(r.created_at), duration_sec=r.duration_sec, options=r.options,
                   status=r.status, stage=r.stage, stages=r.stages, processed_sec=r.processed_sec,
                   error=r.error, summary_error=r.summary_error, provider_used=r.provider_used,
                   transcript=r.transcript, summary=r.summary)

    def to_record_values(self) -> dict:
        data = {k: v for k, v in asdict(self).items() if k != "cancelled"}
        data["created_at"] = datetime.fromisoformat(self.created_at)
        data["summary_type"] = self.summary["meeting_type"] if self.summary else None
        return data


class JobManager:
    """Jobs of all users; one worker processes them in order.

    `settings` provides LLMConfig and the recognition language, `types` the summary type
    Registry — both read at processing time, so admin changes apply to the next job.
    """

    def __init__(self, jobs_dir: Path, pipeline, sessions: sessionmaker, settings, types):
        self.jobs_dir = jobs_dir
        self.pipeline = pipeline
        self.sessions = sessions
        self.settings = settings
        self.types = types
        self.jobs: dict[str, Job] = {}
        self.queue: list[tuple[str, str]] = []  # (job_id, "full" | "summary")
        self.cond = threading.Condition()
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._load()

    # --- persistence ---

    def dir(self, job: Job) -> Path:
        return self.jobs_dir / job.id

    def _save(self, job: Job) -> None:
        if job.cancelled:
            return
        with self.sessions.begin() as db:
            db.merge(JobRecord(**job.to_record_values()))

    def _load(self) -> None:
        with self.sessions() as db:
            records = db.scalars(select(JobRecord).order_by(JobRecord.created_at)).all()
        for record in records:
            job = Job.from_record(record)
            if job.status == "running":
                # Work in progress can't be resumed mid-stage.
                job.status, job.error = "error", "Обработка прервана: сервер был перезапущен"
                for s in job.stages.values():
                    if s["status"] == "running":
                        s["status"] = "error"
                job.stage = None
                self._save(job)
            self.jobs[job.id] = job
            if job.status == "queued":
                self.queue.append((job.id, "summary" if job.transcript else "full"))
            self._ensure_playback(job)

    def import_legacy(self, owner_id: int) -> int:
        """Jobs from before accounts (recordings/jobs/<id>/job.json) → the given user.
        The job.json files are left in place; already imported ids are skipped."""
        imported = 0
        for path in sorted(self.jobs_dir.glob("*/job.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if data.get("id") in self.jobs:
                continue
            data.pop("user_id", None)
            known = {f for f in Job.__dataclass_fields__ if f != "cancelled"}
            job = Job(user_id=owner_id, **{k: v for k, v in data.items() if k in known})
            job.options.pop("punctuation", None)
            job.stages = {s: job.stages.get(s, _stages()[s]) for s in STAGES}
            if job.status in ("queued", "running"):
                job.status, job.stage = "error", None
                job.error = "Обработка прервана: сервер был перезапущен"
            self._save(job)
            with self.cond:
                self.jobs[job.id] = job
            imported += 1
        return imported

    def _record_usage(self, job: Job, **values) -> None:
        with self.sessions.begin() as db:
            db.add(UsageRecord(user_id=job.user_id, job_id=job.id, **values))

    # --- public API ---

    def for_user(self, user_id: int) -> list[Job]:
        return [j for j in self.jobs.values() if j.user_id == user_id]

    def create(self, user_id: int, upload_name: str, fileobj, options: dict) -> Job:
        job_id = datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
        suffix = Path(upload_name).suffix.lower()
        job_dir = self.jobs_dir / job_id
        job_dir.mkdir(parents=True)
        source = f"source{suffix}"
        with open(job_dir / source, "wb") as f:
            shutil.copyfileobj(fileobj, f)

        duration = self.pipeline.duration(str(job_dir / source))
        if duration is None:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise ValueError("Не удалось прочитать файл — это аудио или видео?")

        job = Job(id=job_id, user_id=user_id, filename=upload_name, source=source,
                  created_at=_now(), duration_sec=round(duration, 1), options=options)
        if not options["summary"]:
            job.stages["summarizing"]["status"] = "skipped"
        self._save(job)
        with self.cond:
            self.jobs[job.id] = job
            self.queue.append((job.id, "full"))
            self.cond.notify()
        self._ensure_playback(job)
        return job

    def retry_summary(self, job: Job, provider: str, summary_type: str) -> None:
        with self.cond:
            if job.status in ("queued", "running"):
                raise ValueError("Запись ещё обрабатывается")
            if not job.transcript:
                raise ValueError("Нет расшифровки для summary")
            job.status, job.stage, job.error, job.summary_error = "queued", None, None, None
            job.options = {**job.options, "summary": True, "provider": provider,
                           "summary_type": summary_type}
            job.stages["summarizing"] = _stages()["summarizing"]
            self._save(job)
            self.queue.append((job.id, "summary"))
            self.cond.notify()

    def delete(self, job_id: str) -> None:
        with self.cond:
            job = self.jobs.pop(job_id)
            self.queue = [(j, k) for j, k in self.queue if j != job_id]
            running = job.status == "running"
            job.cancelled = True
        with self.sessions.begin() as db:
            if record := db.get(JobRecord, job_id):
                db.delete(record)
        if not running:  # a running job is cleaned up by the worker once it notices
            shutil.rmtree(self.dir(job), ignore_errors=True)

    def queue_position(self, job: Job) -> int | None:
        ids = [j for j, _ in self.queue]
        return ids.index(job.id) + 1 if job.id in ids else None

    def playback_path(self, job: Job) -> Path | None:
        converted = self.dir(job) / PLAYBACK_FILE
        if converted.exists():
            return converted
        if Path(job.source).suffix in BROWSER_AUDIO:
            return self.dir(job) / job.source
        return None

    # --- views ---

    def list_item(self, job: Job) -> dict:
        return {
            "id": job.id, "filename": job.filename, "created_at": job.created_at,
            "duration_sec": job.duration_sec, "status": job.status, "stage": job.stage,
            "progress_pct": job.progress_pct(), "queue_position": self.queue_position(job),
            "title": job.summary["title"] if job.summary else None,
        }

    def detail(self, job: Job) -> dict:
        return {
            **self.list_item(job),
            "options": job.options, "stages": job.stages,
            "progress": {"processed_sec": round(job.processed_sec, 1),
                         "total_sec": job.duration_sec, "phrases": len(job.transcript)},
            "error": job.error, "summary_error": job.summary_error,
            "provider_used": job.provider_used,
            "audio_ready": self.playback_path(job) is not None,
            "transcript": list(job.transcript), "summary": job.summary,
        }

    def admin_item(self, job: Job) -> dict:
        """Metadata only — admins don't see other users' transcripts and summaries."""
        return {"id": job.id, "filename": job.filename, "created_at": job.created_at,
                "duration_sec": job.duration_sec, "status": job.status,
                "summary_type": job.summary["meeting_type"] if job.summary else None,
                "provider_used": job.provider_used}

    # --- worker ---

    def start(self) -> None:
        threading.Thread(target=self._worker, name="jobs-worker", daemon=True).start()

    def _worker(self) -> None:
        while True:
            with self.cond:
                while not self.queue:
                    self.cond.wait()
                job_id, kind = self.queue.pop(0)
                job = self.jobs[job_id]
                job.status = "running"
            try:
                if kind == "full":
                    self._run_full(job)
                else:
                    self._run_summary(job)
                if job.cancelled:
                    raise Cancelled
                job.status, job.stage = "done", None
            except Cancelled:
                shutil.rmtree(self.dir(job), ignore_errors=True)
                continue
            except Exception as e:  # noqa: BLE001 — any failure ends up in the job, not the log
                if job.cancelled:
                    shutil.rmtree(self.dir(job), ignore_errors=True)
                    continue
                job.status, job.error = "error", str(e) or type(e).__name__
                if job.stage:
                    self._finish(job, job.stage, "error")
                job.stage = None
            self._save(job)

    def _begin(self, job: Job, stage: str) -> None:
        job.stage = stage
        job.stages[stage].update(status="running", started_at=_now())
        self._save(job)

    def _finish(self, job: Job, stage: str, status: str = "done") -> None:
        job.stages[stage].update(status=status, finished_at=_now())
        self._save(job)

    def _run_full(self, job: Job) -> None:
        job_dir = self.dir(job)
        self._begin(job, "transcribing")
        language = self.settings.whisper_language()
        with closing(self.pipeline.transcribe(str(job_dir / job.source), language)) as items:
            for item in items:
                if job.cancelled:
                    raise Cancelled
                if isinstance(item, float):
                    job.processed_sec = item
                else:
                    start, text = item
                    job.transcript.append({"start_sec": round(start, 2), "text": text})
        job.processed_sec = job.duration_sec or job.processed_sec
        self._record_usage(job, kind="transcribe", provider="whisper", model=WHISPER_MODEL_NAME,
                           audio_sec=job.duration_sec or 0.0)
        if not job.transcript:
            raise RuntimeError("В записи не найдено речи")
        self._finish(job, "transcribing")
        (job_dir / "transcript.txt").write_text(job.transcript_text(), encoding="utf-8")

        if job.cancelled:
            raise Cancelled
        if job.options["summary"]:
            self._run_summary(job)

    def _run_summary(self, job: Job) -> None:
        """Summary failures don't fail the job: the transcript is still the result."""
        text = job.transcript_text()
        config, registry = self.settings.llm_config(), self.types.registry()

        def on_usage(u: Usage) -> None:
            self._record_usage(job, kind=u.kind, provider=u.provider, model=u.model,
                               prompt_tokens=u.prompt_tokens,
                               completion_tokens=u.completion_tokens)

        try:
            job.provider_used = self.pipeline.resolve_provider(text, job.options["provider"],
                                                               config, registry)
            self._begin(job, "summarizing")
            result = self.pipeline.summarize(text, job.provider_used,
                                             job.options.get("summary_type", "auto"),
                                             config=config, registry=registry, on_usage=on_usage)
            if job.cancelled:
                raise Cancelled
            summary_mod.save_summary(result, text, self.dir(job) / "summary.md", docx=False,
                                     registry=registry)
            job.summary, job.summary_error = result.model_dump(), None
            self._finish(job, "summarizing")
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001
            job.summary_error = str(e) or type(e).__name__
            if job.stage == "summarizing":
                self._finish(job, "summarizing", "error")

    # --- playback copy ---

    def _ensure_playback(self, job: Job) -> None:
        source = self.dir(job) / job.source
        if (Path(job.source).suffix in BROWSER_AUDIO or not source.exists()
                or (self.dir(job) / PLAYBACK_FILE).exists()):
            return
        threading.Thread(target=self._convert_playback, args=(job,), daemon=True).start()

    def _convert_playback(self, job: Job) -> None:
        job_dir = self.dir(job)
        tmp = job_dir / f"{PLAYBACK_FILE}.part"
        result = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(job_dir / job.source),
             "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-f", "mp4", str(tmp)],
            capture_output=True,
        )
        if result.returncode == 0 and not job.cancelled:
            tmp.replace(job_dir / PLAYBACK_FILE)
        else:
            tmp.unlink(missing_ok=True)
