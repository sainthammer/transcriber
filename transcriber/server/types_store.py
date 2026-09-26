"""Summary types managed in the admin UI: prompt overrides of built-in types, custom types,
the shared base prompt. Builds the Registry used for every summary request."""

import dataclasses

from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from ..summary_types import BASE_PROMPT, TYPES, Registry
from ..summary_types.custom import MAX_SECTIONS, SECTION_KEY, TYPE_ID, Section, custom_type
from .db import JobRecord, SummaryTypeRecord, iso, utcnow
from .settings import BASE_PROMPT_KEY, SettingsStore

MAX_PROMPT = 20_000


class Conflict(Exception):
    """The request is valid but clashes with current state (HTTP 409)."""


def _text(value, field: str, max_len: int, required: bool = True) -> str:
    value = (value or "").strip()
    if required and not value:
        raise ValueError(f"{field}: обязательное поле")
    if len(value) > max_len:
        raise ValueError(f"{field}: не длиннее {max_len} символов")
    return value


def _sections(raw) -> list[dict]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_SECTIONS:
        raise ValueError(f"Разделы: от 1 до {MAX_SECTIONS}")
    sections, keys = [], set()
    for item in raw:
        key = str(item.get("key", "")).strip()
        if not SECTION_KEY.fullmatch(key):
            raise ValueError(f"Ключ раздела «{key}»: латиница в нижнем регистре, цифры и _")
        if key in keys:
            raise ValueError(f"Ключ раздела «{key}» повторяется")
        keys.add(key)
        sections.append({"key": key,
                         "title": _text(item.get("title"), "Заголовок раздела", 100),
                         "description": _text(item.get("description"), "Описание раздела", 500,
                                              required=False)})
    return sections


class TypesStore:
    def __init__(self, sessions: sessionmaker, settings: SettingsStore):
        self._sessions = sessions
        self._settings = settings

    def _records(self) -> dict[str, SummaryTypeRecord]:
        with self._sessions() as db:
            return {r.id: r for r in db.scalars(select(SummaryTypeRecord)
                                                .order_by(SummaryTypeRecord.created_at))}

    def registry(self) -> Registry:
        records = self._records()
        types = {}
        for type_id, t in TYPES.items():
            r = records.get(type_id)
            types[type_id] = dataclasses.replace(t, prompt_text=r.prompt) if r and r.prompt else t
        for r in records.values():
            if not r.builtin:
                types[r.id] = custom_type(r.id, r.label, r.description, r.prompt or "",
                                          [Section(**s) for s in r.sections])
        disabled = frozenset(r.id for r in records.values() if not r.enabled)
        return Registry(types, self.base_prompt(), disabled)

    def base_prompt(self) -> str:
        return self._settings.get_raw(BASE_PROMPT_KEY) or BASE_PROMPT

    def set_base_prompt(self, prompt: str | None, user_id: int) -> None:
        value = _text(prompt, "Общие правила", MAX_PROMPT) if prompt is not None else None
        self._settings.set_raw(BASE_PROMPT_KEY, value if value != BASE_PROMPT else None, user_id)

    def base_prompt_view(self) -> dict:
        prompt = self.base_prompt()
        return {"prompt": prompt, "default_prompt": BASE_PROMPT, "modified": prompt != BASE_PROMPT}

    def public_list(self) -> list[dict]:
        """Enabled types for /api/config: what users can pick."""
        records = self._records()
        registry = self.registry()
        return [{"id": t.id, "label": t.label, "description": t.description,
                 "builtin": t.builtin,
                 "sections": None if t.builtin else
                 [{"key": s["key"], "title": s["title"]} for s in records[t.id].sections]}
                for t in registry.enabled.values()]

    def _jobs_count(self) -> dict[str, int]:
        with self._sessions() as db:
            rows = db.execute(select(JobRecord.summary_type, func.count())
                              .where(JobRecord.summary_type.is_not(None))
                              .group_by(JobRecord.summary_type))
            return dict(rows.all())

    def admin_list(self) -> list[dict]:
        records, counts, registry = self._records(), self._jobs_count(), self.registry()
        return [self._view(t, records.get(t.id), counts.get(t.id, 0))
                for t in registry.types.values()]

    def admin_get(self, type_id: str) -> dict:
        registry = self.registry()
        if type_id not in registry.types:
            raise KeyError(type_id)
        return self._view(registry.types[type_id], self._records().get(type_id),
                          self._jobs_count().get(type_id, 0))

    @staticmethod
    def _view(t, record: SummaryTypeRecord | None, jobs_count: int) -> dict:
        return {
            "id": t.id, "label": t.label, "description": t.description, "builtin": t.builtin,
            "enabled": record.enabled if record else True,
            "prompt": t.prompt,
            "default_prompt": t.default_prompt,
            "prompt_modified": bool(t.builtin and record and record.prompt is not None),
            "sections": record.sections if record and not t.builtin else None,
            "jobs_count": jobs_count,
            "updated_at": iso(record.updated_at) if record else None,
        }

    def create(self, data: dict) -> dict:
        type_id = str(data.get("id", "")).strip()
        if not TYPE_ID.fullmatch(type_id):
            raise ValueError("Идентификатор: латиница в нижнем регистре, цифры и _, 2–32 символа, "
                             "начинается с буквы")
        record = SummaryTypeRecord(
            id=type_id, builtin=False, enabled=True,
            label=_text(data.get("label"), "Название", 100),
            description=_text(data.get("description"), "Описание", 1000),
            prompt=_text(data.get("prompt"), "Промпт", MAX_PROMPT),
            sections=_sections(data.get("sections")),
        )
        with self._sessions.begin() as db:
            if type_id in TYPES or db.get(SummaryTypeRecord, type_id):
                raise Conflict(f"Тип «{type_id}» уже есть")
            db.add(record)
        return self.admin_get(type_id)

    def update(self, type_id: str, data: dict) -> dict:
        builtin = type_id in TYPES
        allowed = {"prompt", "enabled"} if builtin else {"label", "description", "prompt",
                                                          "sections", "enabled"}
        extra = set(data) - allowed
        if extra:
            raise ValueError(f"Нельзя менять у {'встроенного' if builtin else 'этого'} типа: "
                             f"{', '.join(sorted(extra))}")
        with self._sessions.begin() as db:
            record = db.get(SummaryTypeRecord, type_id)
            if record is None:
                if not builtin:
                    raise KeyError(type_id)
                record = SummaryTypeRecord(id=type_id, builtin=True, enabled=True)
                db.add(record)
            if "enabled" in data:
                if not data["enabled"] and record.enabled and self._last_enabled(db, type_id):
                    raise Conflict("Должен остаться хотя бы один включённый тип")
                record.enabled = bool(data["enabled"])
            if "prompt" in data:
                if builtin and (data["prompt"] is None
                                or data["prompt"].strip() == TYPES[type_id].default_prompt.strip()):
                    record.prompt = None
                else:
                    record.prompt = _text(data["prompt"], "Промпт", MAX_PROMPT)
            if "label" in data:
                record.label = _text(data["label"], "Название", 100)
            if "description" in data:
                record.description = _text(data["description"], "Описание", 1000)
            if "sections" in data:
                record.sections = _sections(data["sections"])
            record.updated_at = utcnow()
        return self.admin_get(type_id)

    def _last_enabled(self, db, type_id: str) -> bool:
        records = {r.id: r for r in db.scalars(select(SummaryTypeRecord))}
        ids = set(TYPES) | {k for k, r in records.items() if not r.builtin}
        enabled = {i for i in ids if i not in records or records[i].enabled}
        return enabled == {type_id}

    def delete(self, type_id: str) -> None:
        if type_id in TYPES:
            raise Conflict("Встроенный тип нельзя удалить — его можно отключить")
        count = self._jobs_count().get(type_id, 0)
        if count:
            raise Conflict(f"Тип используется в записях ({count}) — его можно отключить")
        with self._sessions.begin() as db:
            record = db.get(SummaryTypeRecord, type_id)
            if record is None:
                raise KeyError(type_id)
            if record.enabled and self._last_enabled(db, type_id):
                raise Conflict("Должен остаться хотя бы один включённый тип")
            db.delete(record)
