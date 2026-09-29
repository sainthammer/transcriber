"""Database schema and engine. Postgres in production (DATABASE_URL), SQLite in tests."""

import os
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import (JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text,
                        create_engine, event)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DEFAULT_DATABASE_URL = "postgresql+psycopg://transcriber:transcriber@127.0.0.1:5432/transcriber"
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

Json = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime | None) -> str | None:
    """Local-time ISO string for the API. SQLite returns naive datetimes; they're UTC."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone().isoformat(timespec="seconds")


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)  # stored lowercased
    name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), default="user")  # "admin" | "user"
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UserSession(Base):
    __tablename__ = "sessions"

    # sha256 of the cookie token: a leaked table doesn't give working cookies.
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class JobRecord(Base):
    """Persisted state of a recording; the live copy is JobManager's in-memory Job."""

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    filename: Mapped[str] = mapped_column(String(500))
    source: Mapped[str] = mapped_column(String(50))  # file name inside the job directory
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_sec: Mapped[float | None] = mapped_column(Float)
    options: Mapped[dict] = mapped_column(Json)
    status: Mapped[str] = mapped_column(String(16))
    stage: Mapped[str | None] = mapped_column(String(16))
    stages: Mapped[dict] = mapped_column(Json)
    processed_sec: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str | None] = mapped_column(Text)
    summary_error: Mapped[str | None] = mapped_column(Text)
    provider_used: Mapped[str | None] = mapped_column(String(16))
    transcript: Mapped[list] = mapped_column(Json)
    summary: Mapped[dict | None] = mapped_column(Json)
    # Denormalized summary.meeting_type: admin listings and "is this type in use".
    summary_type: Mapped[str | None] = mapped_column(String(40), index=True)
    # SummaryVersion.id of `summary`. No FK: summary_versions already points here, and a
    # cycle would complicate deletes; the job's versions go with it by cascade.
    summary_version_id: Mapped[int | None] = mapped_column(Integer)


class SummaryVersion(Base):
    """A successful summary of a job; the latest SUMMARY_VERSIONS_LIMIT per job are kept."""

    __tablename__ = "summary_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    provider: Mapped[str] = mapped_column(String(16))
    summary_type: Mapped[str] = mapped_column(String(40))  # = summary.meeting_type
    instructions: Mapped[str | None] = mapped_column(Text)  # the user's wishes, if any
    summary: Mapped[dict] = mapped_column(Json)


class Setting(Base):
    """Admin overrides of .env settings; secrets are stored encrypted (security.SecretBox)."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(Integer)


class SummaryTypeRecord(Base):
    """A custom summary type, or overrides (prompt, enabled) of a built-in one."""

    __tablename__ = "summary_types"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    label: Mapped[str | None] = mapped_column(String(100))  # custom types only
    description: Mapped[str | None] = mapped_column(Text)  # custom types only
    prompt: Mapped[str | None] = mapped_column(Text)  # None: the built-in default
    sections: Mapped[list | None] = mapped_column(Json)  # custom: [{key, title, description}]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UsageRecord(Base):
    """One model request (tokens) or one transcription (audio seconds)."""

    __tablename__ = "usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    job_id: Mapped[str | None] = mapped_column(String(40))  # no FK: usage outlives the job
    kind: Mapped[str] = mapped_column(String(16))  # "transcribe" | "classify" | "summary"
    provider: Mapped[str] = mapped_column(String(16))  # whisper | deepseek | ollama | yandex
    model: Mapped[str] = mapped_column(String(100))
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    audio_sec: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow,
                                                 index=True)


def database_url() -> str:
    return os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)


def make_engine(url: str) -> Engine:
    engine = create_engine(url, pool_pre_ping=True)
    if engine.dialect.name == "sqlite":
        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn, _):  # SQLite ignores foreign keys unless asked
            dbapi_conn.execute("PRAGMA foreign_keys=ON")
    return engine


def make_sessionmaker(engine: Engine) -> sessionmaker:
    return sessionmaker(engine, expire_on_commit=False)


def migrate(engine: Engine) -> None:
    """Bring the schema up to date: Alembic migrations for Postgres, create_all for SQLite
    (tests and throwaway setups)."""
    if engine.dialect.name == "sqlite":
        Base.metadata.create_all(engine)
        return
    from alembic import command
    from alembic.config import Config

    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
