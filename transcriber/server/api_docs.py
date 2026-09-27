"""OpenAPI metadata and the Swagger UI / ReDoc pages served under /api."""

from importlib.metadata import PackageNotFoundError, version

from fastapi import FastAPI
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.security import APIKeyCookie
from pydantic import BaseModel

from .security import SESSION_COOKIE

try:
    VERSION = version("transcriber")
except PackageNotFoundError:  # running from a source tree that was never installed
    VERSION = "0.0.0"

TITLE = "Транскрибация — API"

DESCRIPTION = """
API веб-интерфейса транскрибации: запись встречи → расшифровка (faster-whisper) →
структурированное summary (DeepSeek, YandexGPT или локальная модель в Ollama) → экспорт.

## Вход

Сессия хранится в куке `session` (httpOnly). Чтобы пробовать методы прямо отсюда,
выполните **`POST /api/auth/login`** с email и паролем — браузер запомнит куку и будет
отправлять её со всеми запросами. Кнопка **Authorize** для этого не нужна: браузер не даёт
странице самой подставлять куки.

Без сессии методы отвечают **401**. Методы из разделов «Админка» требуют роли
администратора, иначе **403**. Чужая запись неотличима от несуществующей — **404**, а не 403.

## Основной сценарий

1. `GET /api/config` — доступные провайдеры и типы summary.
2. `POST /api/jobs` — загрузить аудио (`multipart/form-data`), в ответ — `id` задачи.
   Задачи обрабатываются по одной, остальные ждут в очереди.
3. `GET /api/jobs/{job_id}/events` — прогресс в формате
   [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events):
   `snapshot`, `queue`, `stage`, `progress`, `phrase`, затем `done` или `error`.
   Поток списка записей — `GET /api/events` (`snapshot`, `job_updated`, `job_deleted`).
4. `GET /api/jobs/{job_id}` — расшифровка и summary; ошибка summary не делает задачу
   ошибочной (поле `summary_error`), повторить — `POST /api/jobs/{job_id}/summary`.
5. `GET /api/jobs/{job_id}/download/{name}` — расшифровка, summary в Markdown, JSON и Word.

## Ошибки

Ответ с ошибкой — JSON вида `{"detail": "текст для пользователя"}`.
"""

TAGS = [
    {"name": "Вход", "description": "Вход по email и паролю, выход, смена пароля."},
    {"name": "Записи", "description": "Загрузка записей, результат, повтор summary, удаление "
                                      "и прослушивание. Видны только свои записи."},
    {"name": "Прогресс", "description": "Потоки Server-Sent Events: прогресс одной записи и "
                                        "изменения списка записей."},
    {"name": "Экспорт", "description": "Файлы для скачивания: расшифровка, summary в Markdown, "
                                       "JSON и Word."},
    {"name": "Служебное", "description": "Проверка работоспособности и настройки интерфейса."},
    {"name": "Админка: настройки", "description": "Ключи API, модели и адрес Ollama, проверка "
                                                  "провайдеров. Значения из базы важнее `.env`."},
    {"name": "Админка: типы summary", "description": "Типы встреч, их схемы и промпты, общий "
                                                     "промпт для всех типов."},
    {"name": "Админка: пользователи", "description": "Учётные записи и их роли. Записи "
                                                     "пользователей — только метаданные, без "
                                                     "расшифровок и summary."},
    {"name": "Админка: расход", "description": "Расход токенов и минут распознавания по "
                                               "пользователям, моделям и дням."},
]

SWAGGER_UI_PARAMETERS = {
    "docExpansion": "none",
    "filter": True,
    "displayRequestDuration": True,
    "persistAuthorization": True,
    "defaultModelsExpandDepth": 0,
    "defaultModelExpandDepth": 2,
    "syntaxHighlight": {"theme": "nord"},
}

# Served from web/dist (web/public in the Vite dev server).
FAVICON = "/favicon.svg"

# Documents the cookie in the schema so protected operations get a lock icon;
# auto_error=False keeps the 401 message from current_user.
session_cookie = APIKeyCookie(
    name=SESSION_COOKIE, auto_error=False, scheme_name="Сессия",
    description="Кука сессии. Ставится методом `POST /api/auth/login`.",
)


class ErrorResponse(BaseModel):
    detail: str


def error(description: str) -> dict:
    return {"model": ErrorResponse, "description": description}


UNAUTHORIZED = {401: error("Нужно войти: нет сессии или она истекла")}
FORBIDDEN = {403: error("Нужны права администратора")}
JOB_NOT_FOUND = {404: error("Записи нет или она принадлежит другому пользователю")}


def mount_docs(app: FastAPI) -> None:
    """Swagger UI at /api/docs and ReDoc at /api/redoc: under /api so the Vite proxy passes them.

    Must run before the /api catch-all route is registered.
    """
    openapi_url = app.openapi_url

    @app.get("/api/docs", include_in_schema=False)
    def swagger_ui():
        return get_swagger_ui_html(openapi_url=openapi_url, title=TITLE,
                                   swagger_favicon_url=FAVICON,
                                   swagger_ui_parameters=SWAGGER_UI_PARAMETERS)

    @app.get("/api/redoc", include_in_schema=False)
    def redoc():
        return get_redoc_html(openapi_url=openapi_url, title=TITLE, redoc_favicon_url=FAVICON)
