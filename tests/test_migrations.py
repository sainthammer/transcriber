"""Alembic migrations on SQLite: the schema matches the models, data is backfilled."""

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from transcriber.server.db import MIGRATIONS_DIR, make_engine


def upgrade(engine, revision):
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, revision)


def test_summary_versions_backfill(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    upgrade(engine, "0c0c76492809")
    with engine.begin() as db:
        db.execute(text("INSERT INTO users VALUES (1, 'a@b', 'A', 'x', 'admin', 1, "
                        "'2026-01-01', NULL)"))
        for job_id, summary, summary_type, provider in (
                ("with", '{"meeting_type": "meeting", "title": "T"}', "meeting", "ollama"),
                ("without", "null", None, None)):
            db.execute(text(
                "INSERT INTO jobs (id, user_id, filename, source, created_at, options, status, "
                "stages, processed_sec, transcript, summary, summary_type, provider_used) "
                "VALUES (:id, 1, 'f', 's', '2026-01-01', '{}', 'done', '{}', 0, '[]', "
                ":summary, :type, :provider)"),
                {"id": job_id, "summary": summary, "type": summary_type, "provider": provider})
    upgrade(engine, "head")
    with engine.connect() as db:
        versions = db.execute(text("SELECT id, job_id, provider, summary_type, instructions "
                                   "FROM summary_versions")).all()
        current = dict(db.execute(text("SELECT id, summary_version_id FROM jobs")).all())
    assert [tuple(v[1:]) for v in versions] == [("with", "ollama", "meeting", None)]
    assert current == {"with": versions[0][0], "without": None}
