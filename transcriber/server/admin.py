"""Admin API: settings and models, summary types and prompts, users, usage."""

from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from .. import summary as summary_mod
from .api_docs import FORBIDDEN, UNAUTHORIZED, error
from .auth import CurrentUser, admin_user, create_user
from .db import JobRecord, UsageRecord, User, UserSession, iso, utcnow
from .security import check_password_strength, hash_password
from .types_store import Conflict

router = APIRouter(prefix="/api/admin", dependencies=[Depends(admin_user)],
                   responses={**UNAUTHORIZED, **FORBIDDEN})

SETTINGS = "Админка: настройки"
TYPES = "Админка: типы summary"
USERS = "Админка: пользователи"
USAGE = "Админка: расход"
INVALID = {422: error("Некорректные данные")}
TYPE_NOT_FOUND = {404: error("Тип не найден")}
USER_NOT_FOUND = {404: error("Пользователь не найден")}


def _state(request: Request):
    return request.app.state


# --- settings ---

def _settings_view(request: Request) -> dict:
    state = _state(request)
    try:
        models, error = summary_mod.ollama_models(state.settings.llm_config()), None
    except summary_mod.OllamaUnavailable as e:
        models, error = None, str(e)
    return {"items": state.settings.admin_view(), "ollama_models": models, "ollama_error": error}


@router.get("/settings", tags=[SETTINGS], summary="Настройки",
            description="Настройки с источником значения (база, `.env` или умолчание) и "
                        "модели, установленные в Ollama.")
def get_settings(request: Request):
    return _settings_view(request)


@router.put("/settings", tags=[SETTINGS], summary="Изменить настройки",
            description="Передаются только изменённые ключи; `null` или пустая строка "
                        "возвращают значение из `.env` или умолчание.", responses=INVALID)
def put_settings(request: Request, changes: dict = Body(...),
                 user: CurrentUser = Depends(admin_user)):
    try:
        _state(request).settings.update(changes, user.id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return _settings_view(request)


class TestRequest(BaseModel):
    provider: str = Field(description="`deepseek`, `ollama` или `yandex`")


@router.post("/settings/test", tags=[SETTINGS], summary="Проверить провайдера",
             description="Пробный запрос к провайдеру с текущими настройками. Неудача — "
                         "это `ok: false` с сообщением, а не код ошибки.", responses=INVALID)
def test_provider(body: TestRequest, request: Request):
    config = _state(request).settings.llm_config()
    try:
        if body.provider == "deepseek":
            return {"ok": True, "message": summary_mod.check_deepseek(config)}
        if body.provider == "yandex":
            return {"ok": True, "message": summary_mod.check_yandex(config)}
        if body.provider == "ollama":
            models = [m["name"] for m in summary_mod.ollama_models(config)]
            if config.ollama_model not in models:
                return {"ok": False, "message": f"Ollama работает, но модели {config.ollama_model} "
                                                f"нет. Скачайте: ollama pull {config.ollama_model}"}
            return {"ok": True, "message": f"Ollama работает, модель {config.ollama_model} есть"}
    except Exception as e:  # noqa: BLE001 — shown to the admin as is
        return {"ok": False, "message": str(e) or type(e).__name__}
    raise HTTPException(422, "provider: deepseek, ollama или yandex")


# --- summary types ---

@router.get("/summary-types", tags=[TYPES], summary="Типы summary",
            description="Встроенные и свои типы, включая отключённые.")
def list_types(request: Request):
    return _state(request).types.admin_list()


@router.post("/summary-types", status_code=201, tags=[TYPES], summary="Создать тип",
             responses={**INVALID, 409: error("Тип с таким id уже есть")})
def create_type(request: Request, data: dict = Body(...)):
    try:
        return _state(request).types.create(data)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    except Conflict as e:
        raise HTTPException(409, str(e)) from None


@router.put("/summary-types/{type_id}", tags=[TYPES], summary="Изменить тип",
            responses={**TYPE_NOT_FOUND, **INVALID,
                       409: error("Должен остаться хотя бы один включённый тип")})
def update_type(type_id: str, request: Request, data: dict = Body(...)):
    try:
        return _state(request).types.update(type_id, data)
    except KeyError:
        raise HTTPException(404, "Тип не найден") from None
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    except Conflict as e:
        raise HTTPException(409, str(e)) from None


@router.delete("/summary-types/{type_id}", status_code=204, tags=[TYPES], summary="Удалить тип",
               description="Встроенные и используемые в записях типы не удаляются — их можно "
                           "отключить.",
               responses={**TYPE_NOT_FOUND,
                          409: error("Тип встроенный, используется в записях или последний "
                                     "включённый")})
def delete_type(type_id: str, request: Request):
    try:
        _state(request).types.delete(type_id)
    except KeyError:
        raise HTTPException(404, "Тип не найден") from None
    except Conflict as e:
        raise HTTPException(409, str(e)) from None


class PromptRequest(BaseModel):
    prompt: str | None = Field(description="`null` — вернуть встроенный промпт")


@router.get("/base-prompt", tags=[TYPES], summary="Общий промпт",
            description="Правила для модели, общие для всех типов summary.")
def get_base_prompt(request: Request):
    return _state(request).types.base_prompt_view()


@router.put("/base-prompt", tags=[TYPES], summary="Изменить общий промпт",
            responses=INVALID)
def put_base_prompt(body: PromptRequest, request: Request, user: CurrentUser = Depends(admin_user)):
    try:
        _state(request).types.set_base_prompt(body.prompt, user.id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return _state(request).types.base_prompt_view()


# --- users ---

def _user_stats(db) -> dict[int, dict]:
    stats: dict[int, dict] = defaultdict(lambda: {"jobs_count": 0, "audio_sec": 0.0,
                                                  "tokens_total": 0})
    for user_id, count in db.execute(select(JobRecord.user_id, func.count())
                                     .group_by(JobRecord.user_id)):
        stats[user_id]["jobs_count"] = count
    for user_id, audio, prompt, completion in db.execute(
            select(UsageRecord.user_id, func.sum(UsageRecord.audio_sec),
                   func.sum(UsageRecord.prompt_tokens), func.sum(UsageRecord.completion_tokens))
            .group_by(UsageRecord.user_id)):
        if user_id is not None:
            stats[user_id]["audio_sec"] = round(audio or 0, 1)
            stats[user_id]["tokens_total"] = (prompt or 0) + (completion or 0)
    return stats


def _user_view(u: User, stats: dict) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role,
            "is_active": u.is_active, "created_at": iso(u.created_at),
            "last_login_at": iso(u.last_login_at),
            **stats.get(u.id, {"jobs_count": 0, "audio_sec": 0.0, "tokens_total": 0})}


@router.get("/users", tags=[USERS], summary="Пользователи",
            description="С числом записей, минутами аудио и расходом токенов.")
def list_users(request: Request):
    with _state(request).sessions() as db:
        users = db.scalars(select(User).order_by(User.created_at)).all()
        stats = _user_stats(db)
    return [_user_view(u, stats) for u in users]


class NewUser(BaseModel):
    email: str
    name: str = Field("", description="Пусто — часть email до @")
    password: str
    role: str = Field("user", description="`admin` или `user`")


@router.post("/users", status_code=201, tags=[USERS], summary="Добавить пользователя",
             responses={**INVALID, 409: error("Пользователь с таким email уже есть")})
def add_user(body: NewUser, request: Request):
    sessions = _state(request).sessions
    try:
        user = create_user(sessions, body.email, body.name, body.password, body.role)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    except LookupError as e:
        raise HTTPException(409, str(e)) from None
    with sessions() as db:
        return _user_view(db.get(User, user.id), {})


class UserPatch(BaseModel):
    name: str | None = None
    role: str | None = Field(None, description="`admin` или `user`")
    is_active: bool | None = Field(None, description="`false` завершает сессии пользователя")
    password: str | None = Field(None, description="Новый пароль; завершает сессии пользователя")


@router.patch("/users/{user_id}", tags=[USERS], summary="Изменить пользователя",
              description="Передаются только изменяемые поля.",
              responses={**USER_NOT_FOUND, **INVALID,
                         409: error("Нельзя отключить себя или снять с себя права администратора")})
def patch_user(user_id: int, body: UserPatch, request: Request,
               me: CurrentUser = Depends(admin_user)):
    if user_id == me.id and (body.is_active is False or body.role not in (None, "admin")):
        raise HTTPException(409, "Нельзя отключить себя или снять с себя права администратора")
    if body.role not in (None, "admin", "user"):
        raise HTTPException(422, "Роль: admin или user")
    if body.password is not None:
        try:
            check_password_strength(body.password)
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
    sessions = _state(request).sessions
    with sessions.begin() as db:
        user = db.get(User, user_id)
        if user is None:
            raise HTTPException(404, "Пользователь не найден")
        if body.name is not None:
            if not body.name.strip():
                raise HTTPException(422, "Имя не может быть пустым")
            user.name = body.name.strip()
        if body.role is not None:
            user.role = body.role
        if body.is_active is not None:
            user.is_active = body.is_active
        if body.password is not None:
            user.password_hash = hash_password(body.password)
        if body.is_active is False or body.password is not None:
            db.execute(delete(UserSession).where(UserSession.user_id == user_id))
    with sessions() as db:
        return _user_view(db.get(User, user_id), _user_stats(db))


@router.get("/users/{user_id}/jobs", tags=[USERS], summary="Записи пользователя",
            description="Только метаданные и расход, без расшифровок и summary.",
            responses=USER_NOT_FOUND)
def user_jobs(user_id: int, request: Request):
    state = _state(request)
    with state.sessions() as db:
        if db.get(User, user_id) is None:
            raise HTTPException(404, "Пользователь не найден")
    jobs = sorted(state.manager.for_user(user_id), key=lambda j: j.created_at, reverse=True)
    return [state.manager.admin_item(j) for j in jobs]


# --- usage ---

@router.get("/usage", tags=[USAGE], summary="Расход",
            description="Токены по пользователям, моделям и дням и минуты распознавания.")
def usage(request: Request, days: int = Query(30, ge=1, le=366, description="За сколько дней")):
    now = utcnow()
    since = now - timedelta(days=days)
    with _state(request).sessions() as db:
        users = {u.id: u for u in db.scalars(select(User))}
        rows = db.scalars(select(UsageRecord).where(UsageRecord.created_at >= since)).all()

    totals = {"prompt_tokens": 0, "completion_tokens": 0, "requests": 0, "audio_sec": 0.0}
    by_user: dict = {}
    by_model: dict = {}
    by_user_model: dict = {}
    daily: dict = {}
    for r in rows:
        if r.kind == "transcribe":
            totals["audio_sec"] += r.audio_sec
            if r.user_id is not None:
                _bucket_user(by_user, r.user_id, users)["audio_sec"] += r.audio_sec
            continue
        tokens = {"prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
                  "requests": 1}
        buckets = [totals,
                   by_model.setdefault((r.provider, r.model), _zero(provider=r.provider,
                                                                     model=r.model))]
        if r.user_id is not None:
            buckets.append(_bucket_user(by_user, r.user_id, users))
            buckets.append(by_user_model.setdefault(
                (r.user_id, r.provider, r.model),
                _zero(user_id=r.user_id, provider=r.provider, model=r.model)))
        for bucket in buckets:
            for k, v in tokens.items():
                bucket[k] += v
        day = _local_date(r.created_at)
        entry = daily.setdefault((day, r.provider),
                                 {"date": day, "provider": r.provider, "prompt_tokens": 0,
                                  "completion_tokens": 0})
        entry["prompt_tokens"] += r.prompt_tokens
        entry["completion_tokens"] += r.completion_tokens

    totals["audio_sec"] = round(totals["audio_sec"], 1)
    for bucket in by_user.values():
        bucket["audio_sec"] = round(bucket["audio_sec"], 1)
    total_tokens = lambda b: b["prompt_tokens"] + b["completion_tokens"]  # noqa: E731
    return {
        "from": _local_date(since), "to": _local_date(now),
        "totals": totals,
        "by_user": sorted(by_user.values(), key=total_tokens, reverse=True),
        "by_model": sorted(by_model.values(), key=total_tokens, reverse=True),
        "by_user_model": sorted(by_user_model.values(), key=total_tokens, reverse=True),
        "daily": sorted(daily.values(), key=lambda d: (d["date"], d["provider"])),
    }


def _zero(**keys) -> dict:
    return {**keys, "prompt_tokens": 0, "completion_tokens": 0, "requests": 0}


def _bucket_user(by_user: dict, user_id: int, users: dict) -> dict:
    if user_id not in by_user:
        u = users.get(user_id)
        by_user[user_id] = {**_zero(user_id=user_id, email=u.email if u else "",
                                    name=u.name if u else ""), "audio_sec": 0.0}
    return by_user[user_id]


def _local_date(dt: datetime) -> str:
    return iso(dt)[:10]
