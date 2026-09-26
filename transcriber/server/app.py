"""FastAPI app: recordings API for the signed-in user, admin API, the built frontend."""

import argparse
import asyncio
import json
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import quote

import uvicorn
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text

from ..docx_export import markdown_to_docx
from ..summary import PROVIDERS
from ..summary_types import strip_empty_sections, transcript_duration
from . import admin, auth
from .auth import CurrentUser, current_user
from .db import database_url, make_engine, make_sessionmaker, migrate
from .jobs import Job, JobManager, Pipeline
from .security import SecretBox
from .settings import SettingsStore
from .types_store import TypesStore

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_JOBS_DIR = PROJECT_ROOT / "recordings" / "jobs"
WEB_DIST = PROJECT_ROOT / "web" / "dist"
SECRET_KEY_FILE = PROJECT_ROOT / "instance" / "secret_key"

DOWNLOADS = {
    "transcript.txt": ("text/plain; charset=utf-8", ".txt"),
    "summary.md": ("text/markdown; charset=utf-8", ".summary.md"),
    "summary.json": ("application/json", ".summary.json"),
    "summary.docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                     ".summary.docx"),
    "digest.docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    ".digest.docx"),
}
# Regenerated from the structured summary on every download (not the stored summary.md):
# print-friendly, so no timestamps, and digest.docx also drops the chronological discussion
# and type-specific details — see Registry.render_markdown/render_digest.
DOCX_NAMES = {"summary.docx", "digest.docx"}


class SummaryRequest(BaseModel):
    provider: str = "auto"
    summary_type: str = "auto"


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _download_name(job: Job, suffix: str) -> str:
    base = job.summary["title"] if job.summary else Path(job.filename).stem
    base = "".join("-" if c in '/\\:*?"<>|' else c for c in base).strip()
    return f"{job.created_at[:10]} {base}{suffix}"


def create_app(jobs_dir: Path = DEFAULT_JOBS_DIR, pipeline=None, start_worker: bool = True,
               web_dist: Path = WEB_DIST, database: str | None = None,
               secret_key: str | None = None, env: dict | None = None) -> FastAPI:
    """`env` replaces os.environ for settings and the first admin (tests pass {})."""
    if env is None:
        load_dotenv()
        env = os.environ
    engine = make_engine(database or database_url())
    migrate(engine)
    sessions = make_sessionmaker(engine)
    settings = SettingsStore(sessions, SecretBox(secret_key or env.get("SECRET_KEY"),
                                                 key_file=SECRET_KEY_FILE), env)
    types = TypesStore(sessions, settings)
    auth.bootstrap_admin(sessions, env)

    pipeline = pipeline or Pipeline()
    manager = JobManager(jobs_dir, pipeline, sessions, settings, types)
    if (owner := auth.first_admin_id(sessions)) and (n := manager.import_legacy(owner)):
        print(f"Перенесено записей из recordings/jobs: {n}", file=sys.stderr)
    if start_worker:
        manager.start()

    app = FastAPI(title="Транскрибация", docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.sessions = sessions
    app.state.settings = settings
    app.state.types = types
    app.state.manager = manager
    # Set on Ctrl+C: SSE streams never end on their own and would keep uvicorn's
    # graceful shutdown waiting forever.
    app.state.stopping = stopping = threading.Event()
    app.include_router(auth.router)
    app.include_router(admin.router)

    def get_job(job_id: str, user: CurrentUser = Depends(current_user)) -> Job:
        job = manager.jobs.get(job_id)
        # Someone else's recording is indistinguishable from a missing one.
        if job is None or job.user_id != user.id:
            raise HTTPException(404, "Запись не найдена")
        return job

    def check_options(provider: str, summary_type: str) -> None:
        if provider not in PROVIDERS:
            raise HTTPException(422, f"Неизвестный провайдер: {provider}")
        if summary_type != "auto" and summary_type not in types.registry().enabled:
            raise HTTPException(422, f"Неизвестный тип summary: {summary_type}")

    @app.get("/api/health")
    def health(request: Request):
        """Liveness for the Docker healthcheck: no session, just the database."""
        try:
            with request.app.state.sessions() as s:
                s.execute(text("SELECT 1"))
        except Exception:  # noqa: BLE001 — any database failure means "unhealthy"
            return Response('{"status":"error","database":false}', status_code=503,
                            media_type="application/json")
        return {"status": "ok", "database": True}

    @app.get("/api/config")
    def config(user: CurrentUser = Depends(current_user)):
        return {"providers": pipeline.provider_status(settings.llm_config()),
                "summary_types": types.public_list(),
                "defaults": {"provider": "auto", "summary": True, "summary_type": "auto"}}

    @app.get("/api/jobs")
    def list_jobs(user: CurrentUser = Depends(current_user)):
        jobs = sorted(manager.for_user(user.id), key=lambda j: j.created_at, reverse=True)
        return [manager.list_item(j) for j in jobs]

    @app.post("/api/jobs", status_code=201)
    def create_job(file: UploadFile = File(...), provider: str = Form("auto"),
                   summary: bool = Form(True), summary_type: str = Form("auto"),
                   user: CurrentUser = Depends(current_user)):
        check_options(provider, summary_type)
        try:
            job = manager.create(user.id, file.filename or "запись", file.file,
                                 {"provider": provider, "summary": summary,
                                  "summary_type": summary_type})
        except ValueError as e:
            raise HTTPException(415, str(e)) from None
        return {"id": job.id}

    @app.get("/api/jobs/{job_id}")
    def job_detail(job: Job = Depends(get_job)):
        return manager.detail(job)

    @app.delete("/api/jobs/{job_id}", status_code=204)
    def delete_job(job: Job = Depends(get_job)):
        manager.delete(job.id)

    @app.post("/api/jobs/{job_id}/summary", status_code=202)
    def retry_summary(body: SummaryRequest, job: Job = Depends(get_job)):
        check_options(body.provider, body.summary_type)
        try:
            manager.retry_summary(job, body.provider, body.summary_type)
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        return {"id": job.id}

    @app.get("/api/jobs/{job_id}/audio")
    def job_audio(job: Job = Depends(get_job)):
        path = manager.playback_path(job)
        if path is None:
            raise HTTPException(409, "Аудио для прослушивания ещё готовится")
        return FileResponse(path)

    @app.get("/api/jobs/{job_id}/download/{name}")
    def job_download(name: str, job: Job = Depends(get_job)):
        if name not in DOWNLOADS:
            raise HTTPException(404, "Файл не найден")
        media_type, suffix = DOWNLOADS[name]
        filename = _download_name(job, suffix)
        if name in DOCX_NAMES:
            # Built from the structured summary on every download rather than stored, so
            # changes to the document styling (or to timestamp handling) reach existing
            # jobs too.
            if job.summary is None:
                raise HTTPException(404, "Файл не найден")
            registry = types.registry()
            s = registry.parse(job.summary)
            duration = transcript_duration(job.transcript_text())
            md = (registry.render_digest(s, duration) if name == "digest.docx"
                  else registry.render_markdown(s, duration, timestamps=False))
            md = strip_empty_sections(md)
            disposition = f"attachment; filename*=utf-8''{quote(filename)}"
            return Response(markdown_to_docx(md), media_type=media_type,
                            headers={"Content-Disposition": disposition})
        path = manager.dir(job) / name
        if not path.exists():
            raise HTTPException(404, "Файл не найден")
        return FileResponse(path, media_type=media_type, filename=filename)

    @app.get("/api/jobs/{job_id}/events")
    async def job_events(request: Request, job: Job = Depends(get_job)):
        async def stream():
            yield _sse("snapshot", manager.detail(job))
            if job.status in ("done", "error"):
                return
            transcript, sent = job.transcript, len(job.transcript)
            last = (job.status, job.stage, None, manager.queue_position(job))
            beat = time.monotonic()
            while not stopping.is_set() and not await request.is_disconnected():
                await asyncio.sleep(0.25)  # also caps progress events at 4/s
                if job.cancelled:
                    yield _sse("error", {"message": "Запись удалена"})
                    return
                for phrase in transcript[sent:]:
                    yield _sse("phrase", phrase)
                sent = len(transcript)

                status, stage, position = job.status, job.stage, manager.queue_position(job)
                progress = round(job.processed_sec, 1)
                if position != last[3] and status == "queued":
                    yield _sse("queue", {"queue_position": position})
                if stage != last[1] and stage:
                    yield _sse("stage", {"stage": stage, "provider": job.provider_used
                                         if stage == "summarizing" else None})
                if stage == "transcribing" and progress != last[2]:
                    yield _sse("progress", {"stage": stage, "processed_sec": progress,
                                            "total_sec": job.duration_sec,
                                            "phrases": len(transcript)})
                if status == "done":
                    yield _sse("done", manager.detail(job))
                    return
                if status == "error":
                    yield _sse("error", {"message": job.error})
                    return
                last = (status, stage, progress, position)
                if time.monotonic() - beat > 15:
                    beat = time.monotonic()
                    yield ": ping\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/events")
    async def all_events(request: Request, user: CurrentUser = Depends(current_user)):
        def snapshot() -> dict:
            return {j.id: manager.list_item(j) for j in manager.for_user(user.id)}

        async def stream():
            known = snapshot()
            yield _sse("snapshot", {"jobs": list(known.values())})
            beat = time.monotonic()
            while not stopping.is_set() and not await request.is_disconnected():
                await asyncio.sleep(0.5)
                current = snapshot()
                for job_id in known.keys() - current.keys():
                    yield _sse("job_deleted", {"id": job_id})
                for job_id, item in current.items():
                    if known.get(job_id) != item:
                        yield _sse("job_updated", item)
                known = current
                if time.monotonic() - beat > 15:
                    beat = time.monotonic()
                    yield ": ping\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/{path:path}", include_in_schema=False)
    def api_not_found(path: str):
        raise HTTPException(404, "Нет такого метода API")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        dist = web_dist.resolve()
        file = (dist / path).resolve()
        if path and file.is_file() and file.is_relative_to(dist):
            return FileResponse(file)
        index = dist / "index.html"
        if index.exists():  # client-side routes like /jobs/<id>
            return FileResponse(index)
        return HTMLResponse("<p>Интерфейс ещё не собран: <code>cd web && npm run build</code></p>",
                            status_code=503)

    return app


def main():
    parser = argparse.ArgumentParser(description="Веб-интерфейс транскрибации")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    args = parser.parse_args()

    try:
        app = create_app()
    except Exception as e:  # noqa: BLE001 — typically the database isn't running
        sys.exit(f"Не удалось запустить сервер: {e}\n"
                 "База запущена? docker compose up -d db (адрес — DATABASE_URL в .env)")
    url = f"http://{args.host}:{args.port}"
    print(f"Интерфейс: {url}  (остановить — Ctrl+C)")
    if not args.no_browser:
        threading.Timer(1.5, webbrowser.open, [url]).start()
    server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=args.port,
                                           log_level="warning", timeout_graceful_shutdown=3))
    handle_exit = server.handle_exit

    def stop(sig, frame):
        app.state.stopping.set()  # end open SSE streams so Ctrl+C doesn't hang
        handle_exit(sig, frame)

    server.handle_exit = stop
    server.run()
