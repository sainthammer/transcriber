"""Alembic environment. Run by the server on startup (db.migrate) or by hand:
uv run alembic upgrade head / uv run alembic revision --autogenerate -m "..." """

from alembic import context
from dotenv import load_dotenv

from transcriber.server.db import Base, database_url, make_engine

target_metadata = Base.metadata


def run(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata,
                      compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


connection = context.config.attributes.get("connection")
if connection is not None:
    run(connection)
else:
    load_dotenv()
    with make_engine(database_url()).connect() as conn:
        run(conn)
        conn.commit()
