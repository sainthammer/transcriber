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
from fastapi import Path as PathParam
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse, Response,
                               StreamingResponse)
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text

from ..docx_export import markdown_to_docx
from ..log import SERVER_DEFAULT, setup_logging
from ..summary import PROVIDERS, normalize_instructions
from ..summary_types import strip_empty_sections, transcript_duration
from . import admin, api_docs, auth
from .api_docs import JOB_NOT_FOUND, UNAUTHORIZED, error
from .auth import CurrentUser, current_user
from .db import database_url, make_engine, make_sessionmaker, migrate
from .jobs import MAX_UPLOAD_BYTES, Job, JobManager, Pipeline, UploadTooLarge
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


PROVIDER_HELP = "`auto`, `deepseek` или `ollama`; `auto` выбирает по размеру расшифровки"
SUMMARY_TYPE_HELP = "id типа из `GET /api/config` или `auto` — модель определит сама"
# Room for a paragraph of wishes; the prompt (and Ollama's num_ctx) grows with them.
MAX_INSTRUCTIONS = 2000


class SummaryRequest(BaseModel):
    provider: str = Field("auto", description=PROVIDER_HELP)
    summary_type: str = Field("auto", description=SUMMARY_TYPE_HELP)
    instructions: str | None = Field(
        None, description="Пожелания к новой версии, например «подробнее про задачи». "
                          f"Пробелы по краям обрезаются, пустая строка — как null; не длиннее "
                          f"{MAX_INSTRUCTIONS} символов. Правила типа и схема важнее пожеланий.")

    @field_validator("instructions")
    @classmethod
    def _instructions(cls, value: str | None) -> str | None:
        value = normalize_instructions(value)
        if value and len(value) > MAX_INSTRUCTIONS:
            raise ValueError(f"Пожелания длиннее {MAX_INSTRUCTIONS} символов")
        return value


class JobCreated(BaseModel):
    id: str


class Health(BaseModel):
    status: str
    database: bool


def _stream_response(description: str) -> dict:
    return {200: {"description": description, "content": {"text/event-stream": {}}}}


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

    app = FastAPI(title=api_docs.TITLE, version=api_docs.VERSION,
                  description=api_docs.DESCRIPTION, openapi_tags=api_docs.TAGS,
                  openapi_url="/api/openapi.json", docs_url=None, redoc_url=None)
    api_docs.mount_docs(app)
    app.state.sessions = sessions
    app.state.settings = settings
    app.state.types = types
    app.state.manager = manager
    # Set on Ctrl+C: SSE streams never end on their own and would keep uvicorn's
    # graceful shutdown waiting forever.
    app.state.stopping = stopping = threading.Event()
    app.include_router(auth.router)
    app.include_router(admin.router)

    @app.middleware("http")
    async def upload_limit(request: Request, call_next):
        # Starlette spools the whole upload to disk before the handler runs, so reject an
        # oversized one by its declared length up front; manager.create() still counts the
        # bytes for uploads without Content-Length.
        length = request.headers.get("content-length", "")
        if (request.method == "POST" and request.url.path == "/api/jobs"
                and length.isdigit() and int(length) > MAX_UPLOAD_BYTES + 1024**2):
            return JSONResponse({"detail": f"Файл больше {MAX_UPLOAD_BYTES // 1024**3} ГБ"},
                                status_code=413)
        return await call_next(request)

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

    @app.get("/api/health", tags=["Служебное"], summary="Проверка работоспособности",
             description="Для healthcheck Docker: без входа, проверяет только доступность базы.",
             response_model=Health,
             responses={503: {"model": Health, "description": "База недоступна"}})
    def health(request: Request):
        try:
            with request.app.state.sessions() as s:
                s.execute(text("SELECT 1"))
        except Exception:  # noqa: BLE001 — any database failure means "unhealthy"
            return Response('{"status":"error","database":false}', status_code=503,
                            media_type="application/json")
        return {"status": "ok", "database": True}

    @app.get("/api/config", tags=["Служебное"], summary="Настройки для формы загрузки",
             description="Доступность провайдеров, включённые типы summary, значения по "
                         "умолчанию и предельный размер файла.", responses=UNAUTHORIZED)
    def config(user: CurrentUser = Depends(current_user)):
        return {"providers": pipeline.provider_status(settings.llm_config()),
                "summary_types": types.public_list(),
                "defaults": {"provider": "auto", "summary": True, "summary_type": "auto"},
                "max_upload_bytes": MAX_UPLOAD_BYTES}

    @app.get("/api/jobs", tags=["Записи"], summary="Список записей",
             description="Записи текущего пользователя, новые первыми.", responses=UNAUTHORIZED)
    def list_jobs(user: CurrentUser = Depends(current_user)):
        jobs = sorted(manager.for_user(user.id), key=lambda j: j.created_at, reverse=True)
        return [manager.list_item(j) for j in jobs]

    @app.post("/api/jobs", status_code=201, tags=["Записи"], summary="Загрузить запись",
              description="Ставит запись в очередь на расшифровку и summary. Прогресс — "
                          "`GET /api/jobs/{job_id}/events`.",
              response_model=JobCreated,
              responses={**UNAUTHORIZED,
                         413: error(f"Файл больше {MAX_UPLOAD_BYTES // 1024**3} ГБ"),
                         415: error("Файл не читается как аудио или видео"),
                         422: error("Неизвестный провайдер или тип summary")})
    def create_job(file: UploadFile = File(..., description="Аудио или видео"),
                   provider: str = Form("auto", description=PROVIDER_HELP),
                   summary: bool = Form(True, description="Делать ли summary после расшифровки"),
                   summary_type: str = Form("auto", description=SUMMARY_TYPE_HELP),
                   user: CurrentUser = Depends(current_user)):
        check_options(provider, summary_type)
        try:
            job = manager.create(user.id, file.filename or "запись", file.file,
                                 {"provider": provider, "summary": summary,
                                  "summary_type": summary_type})
        except UploadTooLarge as e:
            raise HTTPException(413, str(e)) from None
        except ValueError as e:
            raise HTTPException(415, str(e)) from None
        return {"id": job.id}

    @app.get("/api/jobs/{job_id}", tags=["Записи"], summary="Запись целиком",
             description="Состояние, расшифровка и summary.",
             responses={**UNAUTHORIZED, **JOB_NOT_FOUND})
    def job_detail(job: Job = Depends(get_job)):
        return manager.detail(job)

    @app.delete("/api/jobs/{job_id}", status_code=204, tags=["Записи"],
                summary="Удалить запись", description="Идущая обработка прерывается.",
                responses={**UNAUTHORIZED, **JOB_NOT_FOUND})
    def delete_job(job: Job = Depends(get_job)):
        manager.delete(job.id)

    @app.post("/api/jobs/{job_id}/summary", status_code=202, tags=["Записи"],
              summary="Новая версия summary",
              description="Заново делает summary по готовой расшифровке — другим провайдером, "
                          "типом или с пожеланиями пользователя. Текущее summary остаётся до "
                          "готовности новой версии, а при ошибке — и после (с `summary_error`). "
                          "Каждое готовое summary сохраняется в `summary_versions`.",
              response_model=JobCreated,
              responses={**UNAUTHORIZED, **JOB_NOT_FOUND,
                         409: error("Запись ещё обрабатывается или расшифровки нет"),
                         422: error("Неизвестный провайдер или тип summary, слишком длинные "
                                    "пожелания")})
    def retry_summary(body: SummaryRequest, job: Job = Depends(get_job)):
        check_options(body.provider, body.summary_type)
        try:
            manager.retry_summary(job, body.provider, body.summary_type, body.instructions)
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        return {"id": job.id}

    @app.post("/api/jobs/{job_id}/summary/versions/{version_id}/restore", tags=["Записи"],
              summary="Вернуть версию summary",
              description="Делает сохранённую версию текущей: summary, провайдер и файлы для "
                          "скачивания. Ответ — запись целиком, как `GET /api/jobs/{job_id}`.",
              responses={**UNAUTHORIZED,
                         404: error("Записи или версии нет"),
                         409: error("Запись ещё обрабатывается или тип summary версии "
                                    "удалён")})
    def restore_summary_version(version_id: int = PathParam(description="id из "
                                                             "`summary_versions`"),
                                job: Job = Depends(get_job)):
        try:
            manager.restore_version(job, version_id)
        except LookupError:
            raise HTTPException(404, "Версия summary не найдена") from None
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        return manager.detail(job)

    @app.get("/api/jobs/{job_id}/audio", tags=["Записи"], summary="Аудио для прослушивания",
             responses={200: {"description": "Аудиофайл", "content": {"audio/*": {}}},
                        **UNAUTHORIZED, **JOB_NOT_FOUND,
                        409: error("Аудио для прослушивания ещё готовится")})
    def job_audio(job: Job = Depends(get_job)):
        path = manager.playback_path(job)
        if path is None:
            raise HTTPException(409, "Аудио для прослушивания ещё готовится")
        return FileResponse(path)

    @app.get("/api/jobs/{job_id}/download/{name}", tags=["Экспорт"], summary="Скачать файл",
             description="`transcript.txt` — расшифровка с таймкодами; `summary.md`, "
                         "`summary.json` — summary; `summary.docx` — summary в Word без "
                         "таймкодов; `digest.docx` — короткая версия для печати.",
             responses={200: {"description": "Файл",
                              "content": {media: {} for media, _ in DOWNLOADS.values()}},
                        **UNAUTHORIZED,
                        404: error("Записи или файла нет (например, summary ещё не готово)")})
    def job_download(name: str = PathParam(description="Имя файла",
                                           examples=list(DOWNLOADS)),
                     job: Job = Depends(get_job)):
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

    @app.get("/api/jobs/{job_id}/events", tags=["Прогресс"], summary="Прогресс записи (SSE)",
             description="Первым приходит `snapshot` — запись целиком; для готовой записи поток "
                         "на нём и заканчивается. Дальше: `queue` (место в очереди), `stage` "
                         "(стадия), `progress` (секунды распознанного аудио), `phrase` (новая "
                         "фраза расшифровки) и в конце `done` (запись целиком) или `error`.",
             responses={**_stream_response("Поток событий"), **UNAUTHORIZED, **JOB_NOT_FOUND})
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

    @app.get("/api/events", tags=["Прогресс"], summary="Изменения списка записей (SSE)",
             description="`snapshot` со всеми записями, затем `job_updated` и `job_deleted`, "
                         "а `summary_changed` (`{id, summary_version_id}`) — когда у записи "
                         "сменилась текущая версия summary (новая или возвращённая): открытой "
                         "записи пора перечитать `GET /api/jobs/{job_id}`. Поток не "
                         "заканчивается сам.",
             responses={**_stream_response("Поток событий"), **UNAUTHORIZED})
    async def all_events(request: Request, user: CurrentUser = Depends(current_user)):
        def snapshot() -> dict:
            return {j.id: manager.list_item(j) for j in manager.for_user(user.id)}

        def versions() -> dict:
            return {j.id: j.summary_version_id for j in manager.for_user(user.id)}

        async def stream():
            seen = manager.revision
            known, known_versions = snapshot(), versions()
            yield _sse("snapshot", {"jobs": list(known.values())})
            beat = time.monotonic()
            while not stopping.is_set() and not await request.is_disconnected():
                await asyncio.sleep(0.5)
                if time.monotonic() - beat > 15:
                    beat = time.monotonic()
                    yield ": ping\n\n"
                if manager.revision == seen:
                    continue
                seen = manager.revision
                current, current_versions = snapshot(), versions()
                for job_id in known.keys() - current.keys():
                    yield _sse("job_deleted", {"id": job_id})
                for job_id, item in current.items():
                    if known.get(job_id) != item:
                        yield _sse("job_updated", item)
                for job_id, version_id in current_versions.items():
                    if job_id in known_versions and known_versions[job_id] != version_id:
                        yield _sse("summary_changed", {"id": job_id,
                                                       "summary_version_id": version_id})
                known, known_versions = current, current_versions

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
    setup_logging(SERVER_DEFAULT)

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
