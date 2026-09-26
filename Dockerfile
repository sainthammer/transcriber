# syntax=docker/dockerfile:1
# Образ веб-интерфейса: собирается на машине пользователя (docker compose build),
# linux/amd64 и linux/arm64. Модель распознавания в образ не входит — её скачивает
# сервис models в ./models (см. docker-compose.yml).

ARG PYTHON_IMAGE=python:3.13-slim-trixie

# --- web/dist: node работает на платформе сборщика, результат — платформонезависимая статика
FROM --platform=$BUILDPLATFORM node:24-slim AS web
WORKDIR /web
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- .venv: uv нужен только здесь, в итоговый образ не попадает
FROM ${PYTHON_IMAGE} AS venv
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_NO_DEV=1
# Зависимости отдельным слоем: пересобираются только при изменении uv.lock
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project
# Пакет ставится editable (.pth → /app): ресурсы ищутся от __file__
COPY README.md ./
COPY transcriber/ transcriber/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen

# --- приложение
FROM ${PYTHON_IMAGE} AS app

# ffmpeg/ffprobe вызываются как программы (длительность, копия для плеера)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Непривилегированный пользователь; в compose UID подменяется под хост (APP_UID)
RUN useradd --create-home --uid 1000 --user-group app

WORKDIR /app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1

COPY --from=venv /app/.venv .venv
COPY pyproject.toml README.md alembic.ini ./
COPY transcriber/ transcriber/
COPY --from=web /web/dist web/dist
# Точки монтирования (models/, recordings/, instance/) — с владельцем app
RUN mkdir -p models recordings instance && chown app:app models recordings instance

USER app
EXPOSE 8000
# exec-форма без sh и uv run: SIGTERM доходит до сервера, он закрывает SSE-потоки
# и выходит (см. main() в transcriber/server/app.py)
CMD ["transcriber-web", "--host", "0.0.0.0", "--port", "8000", "--no-browser"]
