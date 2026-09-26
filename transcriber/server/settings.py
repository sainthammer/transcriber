"""Settings editable in the admin UI. Effective value: database → environment (.env) → default."""

import os
import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from ..summary import (DEEPSEEK_DEFAULT_MODEL, OLLAMA_DEFAULT_HOST, OLLAMA_DEFAULT_MAX_CONTEXT,
                       OLLAMA_DEFAULT_MODEL, LLMConfig)
from .db import Setting, utcnow
from .security import SecretBox

BASE_PROMPT_KEY = "base_prompt"  # stored here too, edited in the summary types section


@dataclass(frozen=True)
class SettingDef:
    key: str
    label: str
    group: str  # "deepseek" | "ollama" | "whisper"
    env: str
    default: str | int | None
    secret: bool = False
    kind: type = str
    help: str | None = None


DEFS = {d.key: d for d in (
    SettingDef("deepseek_api_key", "Ключ API", "deepseek", "DEEPSEEK_API_KEY", None, secret=True,
               help="Ключ из личного кабинета platform.deepseek.com"),
    SettingDef("deepseek_model", "Модель", "deepseek", "DEEPSEEK_MODEL", DEEPSEEK_DEFAULT_MODEL,
               help="deepseek-v4-pro — точнее и дороже"),
    SettingDef("ollama_host", "Адрес", "ollama", "OLLAMA_HOST", OLLAMA_DEFAULT_HOST),
    SettingDef("ollama_model", "Модель", "ollama", "OLLAMA_MODEL", OLLAMA_DEFAULT_MODEL),
    SettingDef("ollama_max_context", "Лимит контекста", "ollama", "OLLAMA_MAX_CONTEXT",
               OLLAMA_DEFAULT_MAX_CONTEXT, kind=int,
               help="До скольки токенов делать summary локально в режиме «Авто»; "
                    "длиннее — через DeepSeek"),
    SettingDef("whisper_language", "Язык распознавания", "whisper", "WHISPER_LANGUAGE", "ru",
               help="Код языка (ru, en, de…) или auto — определять автоматически"),
)}


def _validate(d: SettingDef, raw) -> str:
    value = str(raw).strip()
    if d.kind is int:
        try:
            number = int(value)
        except ValueError:
            raise ValueError(f"{d.label}: нужно целое число") from None
        if not 2048 <= number <= 1_000_000:
            raise ValueError(f"{d.label}: от 2048 до 1 000 000")
        return str(number)
    if d.key == "whisper_language" and not re.fullmatch(r"auto|[a-z]{2,3}", value.lower()):
        raise ValueError("Язык: код вроде ru или en, либо auto")
    if d.key == "ollama_host" and not re.fullmatch(r"(https?://)?[\w.\-]+(:\d+)?/?", value):
        raise ValueError("Адрес Ollama: например http://localhost:11434")
    if len(value) > 500:
        raise ValueError(f"{d.label}: слишком длинное значение")
    return value.lower() if d.key == "whisper_language" else value


def mask(secret: str) -> str:
    return f"{secret[:3]}…{secret[-4:]}" if len(secret) > 10 else "…"


class SettingsStore:
    def __init__(self, sessions: sessionmaker, box: SecretBox, env: dict | None = None):
        self._sessions = sessions
        self._box = box
        self._env = os.environ if env is None else env

    def _stored(self) -> dict[str, str]:
        with self._sessions() as db:
            rows = db.scalars(select(Setting)).all()
        values = {}
        for row in rows:
            d = DEFS.get(row.key)
            value = self._box.decrypt(row.value) if d and d.secret else row.value
            if value is not None:  # undecryptable: SECRET_KEY changed, fall back to .env
                values[row.key] = value
        return values

    def _resolve(self, stored: dict[str, str], d: SettingDef) -> tuple[str | int | None, str]:
        if d.key in stored:
            value, source = stored[d.key], "db"
        elif self._env.get(d.env):
            value, source = self._env[d.env], "env"
        else:
            return d.default, "default"
        if d.kind is int:
            try:
                return int(value), source
            except ValueError:
                return d.default, "default"
        return value, source

    def values(self) -> dict[str, str | int | None]:
        stored = self._stored()
        return {k: self._resolve(stored, d)[0] for k, d in DEFS.items()}

    def llm_config(self) -> LLMConfig:
        v = self.values()
        return LLMConfig(deepseek_api_key=v["deepseek_api_key"] or None,
                         deepseek_model=v["deepseek_model"], ollama_host=v["ollama_host"],
                         ollama_model=v["ollama_model"],
                         ollama_max_context=v["ollama_max_context"])

    def whisper_language(self) -> str | None:
        """ISO code, or None to autodetect (faster-whisper's convention)."""
        lang = str(self.values()["whisper_language"]).lower()
        return None if lang == "auto" else lang

    def admin_view(self) -> list[dict]:
        stored = self._stored()
        items = []
        for d in DEFS.values():
            value, source = self._resolve(stored, d)
            if d.secret and value:
                value = mask(str(value))
            items.append({"key": d.key, "label": d.label, "group": d.group, "value": value,
                          "secret": d.secret, "source": source,
                          "default": None if d.secret else d.default, "help": d.help})
        return items

    def update(self, changes: dict, user_id: int | None) -> None:
        """Save {key: value}; None or "" removes the override (back to .env / default).
        Validates everything before writing anything."""
        unknown = set(changes) - set(DEFS)
        if unknown:
            raise ValueError(f"Неизвестные настройки: {', '.join(sorted(unknown))}")
        clean = {k: None if v is None or str(v).strip() == "" else _validate(DEFS[k], v)
                 for k, v in changes.items()}
        with self._sessions.begin() as db:
            for key, value in clean.items():
                row = db.get(Setting, key)
                if value is None:
                    if row:
                        db.delete(row)
                    continue
                stored = self._box.encrypt(value) if DEFS[key].secret else value
                if row:
                    row.value, row.updated_at, row.updated_by = stored, utcnow(), user_id
                else:
                    db.add(Setting(key=key, value=stored, updated_by=user_id))

    # --- raw values outside DEFS (the base prompt) ---

    def get_raw(self, key: str) -> str | None:
        with self._sessions() as db:
            row = db.get(Setting, key)
            return row.value if row else None

    def set_raw(self, key: str, value: str | None, user_id: int | None) -> None:
        with self._sessions.begin() as db:
            row = db.get(Setting, key)
            if value is None:
                if row:
                    db.delete(row)
            elif row:
                row.value, row.updated_at, row.updated_by = value, utcnow(), user_id
            else:
                db.add(Setting(key=key, value=value, updated_by=user_id))
