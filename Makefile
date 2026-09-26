# Shortcuts for common commands; `make` without a target prints the list.
# Written for the GNU make 3.81 that ships with macOS.

.DEFAULT_GOAL := help
.PHONY: help install test transcribe summarize model db web dev build lint screenshots \
	up rebuild down logs ps users migration

FILE ?=
ARGS ?=
MSG ?=

help: ## Список команд
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  Параметры: FILE=<файл> ARGS=\"<флаги>\" MSG=\"<описание миграции>\""
	@echo "  Пример:    make transcribe FILE=recordings/record.mp3 ARGS=\"-p ollama\""

# --- Python ---

install: ## Зависимости Python и интерфейса
	uv sync
	cd web && npm ci

test: ## Тесты (без сети, моделей и Postgres)
	uv run pytest $(ARGS)

transcribe: ## Расшифровка и summary: FILE=<аудио> [ARGS=...]
	@test -n "$(FILE)" || (echo "Укажите файл: make transcribe FILE=recordings/record.mp3" && exit 1)
	uv run transcribe "$(FILE)" $(ARGS)

summarize: ## Summary по готовой расшифровке: FILE=<txt> [ARGS=...]
	@test -n "$(FILE)" || (echo "Укажите файл: make summarize FILE=recordings/record.txt" && exit 1)
	uv run summarize "$(FILE)" $(ARGS)

model: ## Скачать модель Whisper в models/
	uv run download-model

users: ## Пользователи веб-интерфейса
	uv run transcriber-admin list-users

# --- Web development ---

db: ## Поднять только Postgres для разработки
	docker compose up -d db

web: db ## API веб-интерфейса на :8000 (с базой)
	uv run transcriber-web --no-browser $(ARGS)

dev: ## Интерфейс в режиме разработки (Vite)
	cd web && npm run dev

build: ## Собрать интерфейс в web/dist
	cd web && npm run build

lint: ## Линтер интерфейса
	cd web && npm run lint

screenshots: ## Скриншоты интерфейса в web/.screenshots/
	cd web && npm run screenshots

migration: ## Новая миграция после изменения server/db.py: MSG="..."
	@test -n "$(MSG)" || (echo "Укажите описание: make migration MSG=\"…\"" && exit 1)
	uv run alembic revision --autogenerate -m "$(MSG)"

# --- Docker ---

up: ## Всё приложение в Docker на :8000
	docker compose up -d

rebuild: ## Пересобрать и перезапустить приложение после изменений в коде
	docker compose up -d --build app

down: ## Остановить контейнеры (данные сохраняются)
	docker compose down

logs: ## Логи приложения в Docker
	docker compose logs -f app

ps: ## Состояние контейнеров
	docker compose ps
