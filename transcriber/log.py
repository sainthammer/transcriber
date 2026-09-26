"""Developer logs of the model runs (Whisper, LLM), shared by the CLI and the web server.

Only metadata goes to these logs — sizes, timings, token counts, model names, error
types. Never transcript text, prompts, model replies, summaries or API keys: the
recordings are interviews and one-on-ones.

LOG_LEVEL (env or .env) sets the level of the `transcriber.*` loggers for every command.
Defaults differ on purpose: the CLI already tells the user everything in Russian via
print + tqdm, so its logs are off unless asked for; the web server logs INFO so model
runs show up in the console and `docker compose logs`.
"""

import logging
import os
import sys
from contextvars import ContextVar

from dotenv import load_dotenv
from tqdm import tqdm
from uvicorn.logging import DefaultFormatter

LOGGER_NAME = "transcriber"
LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
# Above anything the code logs: the CLI is silent unless LOG_LEVEL is set.
CLI_DEFAULT = logging.CRITICAL
SERVER_DEFAULT = logging.INFO

# Id of the server job being processed in the current thread (the jobs worker sets it),
# so model logs can be tied to a job.
job_id: ContextVar[str | None] = ContextVar("job_id", default=None)


class _JobFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        job = job_id.get()
        record.job = f"[job {job}] " if job else ""
        return True


class _TqdmHandler(logging.StreamHandler):
    """Writes through tqdm so log lines don't break an active progress bar."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            tqdm.write(self.format(record), file=self.stream)
        except Exception:  # noqa: BLE001 — logging must never break the caller
            self.handleError(record)


def setup_logging(default: int) -> None:
    """Configure the `transcriber` logger once per process; LOG_LEVEL overrides `default`.

    Same look as uvicorn's own lines ("INFO:     ..."), to stderr like uvicorn's; the
    logger doesn't propagate, so it never doubles up with a root handler."""
    load_dotenv()
    level, raw = default, os.getenv("LOG_LEVEL", "").strip().upper()
    if raw in LEVELS:
        level = getattr(logging, raw)
    elif raw:
        print(f"LOG_LEVEL={raw} не распознан (варианты: {', '.join(LEVELS)}), "
              "используется уровень по умолчанию", file=sys.stderr)

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(level)
    logger.propagate = False
    if not any(isinstance(h, _TqdmHandler) for h in logger.handlers):
        handler = _TqdmHandler(sys.stderr)
        handler.setFormatter(DefaultFormatter("%(levelprefix)s %(name)s: %(job)s%(message)s"))
        handler.addFilter(_JobFilter())
        logger.addHandler(handler)
