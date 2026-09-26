# CLAUDE.md

Транскрибация аудио (faster-whisper, модель уже с пунктуацией) → структурированное summary
(DeepSeek или локальная модель в Ollama). Устройство, команды и переменные окружения — в README.

## Команды

```bash
uv run pytest                                  # тесты: без сети, моделей и Postgres (SQLite), ~3 с
uv run transcribe <audio> --no-summary         # пайплайн без LLM
uv run summarize <transcript.txt> -p ollama    # только summary, локально
docker compose up -d db                        # Postgres для веб-интерфейса (Docker — OrbStack)
uv run transcriber-web --no-browser            # API для веб-интерфейса на :8000
uv run transcriber-admin list-users            # пользователи из командной строки
uv run download-model                          # модель в models/, если её нет (WHISPER_MODEL)
docker compose up -d --build                   # всё приложение в Docker (db + models + app) на :8000
uv run alembic revision --autogenerate -m "…"  # миграция после изменения server/db.py
cd web && npm run dev | build | lint           # интерфейс (npm, lock — web/package-lock.json)
cd web && npm run screenshots                  # скриншоты Playwright в web/.screenshots/
```

Те же команды короче — в `Makefile` (`make` — список). Добавляешь команду — добавь и цель.

Полный прогон 35-минутной записи занимает пару минут на процессоре (int8, без Metal-ускорения —
ctranslate2 его не поддерживает) и грузит ~2 ГБ модели. Для проверки изменений нарезай
фрагмент: `ffmpeg -ss 60 -t 30 -i recordings/record.mp3 /tmp/clip.mp3`.

## Соглашения

- Пользовательский текст (CLI, сообщения, README, промпты, коммиты) — на русском;
  комментарии и docstrings в коде — на английском.
- Код — пакет `transcriber/`, команды (`transcribe`, `summarize`, `transcriber-web`,
  `transcriber-admin`) — в `[project.scripts]`
  (`pyproject.toml`). Импорты внутри пакета относительные; `summary` в `cli.py`
  импортируется лениво (тянет openai).
- Ресурсы проекта ищутся от `__file__`, а не от текущей директории: модели — в `models/`
  в корне проекта (родитель пакета), промпты — рядом с модулями в `transcriber/summary_types/`.
- Формат расшифровки `[ЧЧ:ММ:СС] текст` — контракт между `transcriber.cli.fmt_time`,
  `transcriber.summary_types.transcript_duration` и промптами. Меняешь в одном месте — меняй везде.
- Типы summary («скиллы») — `transcriber/summary_types/`: общая схема и правила в `base.py`/`base.md`,
  на каждый тип `<id>.py` (схема `details`, рендер, `SummaryType`) и `<id>.md` (правила для модели),
  реестр `TYPES` в `__init__.py`. Схема для каждого типа собирается динамически (`SummaryType.model`),
  Markdown собирает код (`render_markdown`). Меняя схему, обнови рендер, тесты и интерфейс в `web/`.
- Word-версия (`docx_export.py`) строится из этого же Markdown, а не из модели: понимает только то,
  что выдаёт `render_markdown` (заголовки `#`–`###`, `- `, таблицы, `---`, `**`, `_`, `` ` ``).
  Добавляешь в рендер новую разметку — научи ей и экспорт. Шрифт Arial: Calibri нет на Mac без Office.
- Сервер (`transcriber/server/`): тяжёлая работа — в `Pipeline` (подменяется в тестах `FakePipeline`),
  задачи по одной в фоновом потоке (`jobs.py`); живое состояние — в памяти `JobManager`,
  в Postgres (`jobs`) оно пишется на смене стадий, файлы — в `recordings/jobs/<id>/`. Ошибка
  summary не делает задачу ошибочной (`summary_error`), расшифровка остаётся результатом.
- Настройки моделей и типы summary в `summary.py` передаются явно: `LLMConfig` и `Registry`
  (по умолчанию — `.env` и встроенные типы, так работает CLI). Сервер собирает их из базы на
  каждую задачу (`SettingsStore.llm_config()`, `TypesStore.registry()`): база → `.env` → умолчание.
  Каждый запрос к модели отдаёт `Usage` через `on_usage` — так считается расход.
- Каждый маршрут `/api/*`, кроме входа, требует сессию (`Depends(current_user)`), записи
  фильтруются по `user_id`: чужая запись — 404, не 403. Админские — в `admin.py` под `admin_user`.
- Схема базы — `server/db.py`; меняешь модели — делай миграцию Alembic. Тесты используют
  SQLite (`create_all`), поэтому никаких Postgres-only конструкций в запросах.

## Неочевидное (не «исправлять»)

- **`trust_env=False` в httpx-клиенте Ollama**: в macOS включён системный прокси
  (VPN, `127.0.0.1:1082`), httpx подхватывает его и шлёт через него даже localhost → 503.
  SSH к GitHub тоже не проходит (соединение закрывается) — вероятно, из-за того же VPN.
- **faster-whisper на Mac — только CPU**: ctranslate2 (бэкенд faster-whisper) не умеет в Metal,
  GPU не используется. `compute_type="int8"` (в `cli.DEVICE`/`cli.COMPUTE_TYPE`) заметно быстрее
  float32 на CPU почти без потери качества — не менять на float32 без причины.
  Модель и так уже расставляет пунктуацию и регистр, отдельного прохода не нужно.
- **`vad_filter=True`** в `transcriber.cli.transcribe()` — отсечение тишины и не-речи через Silero VAD
  (идёт в комплекте faster-whisper). Без него модель на тишине иногда «галлюцинирует» фразы.
- **Язык распознавания** — `WHISPER_LANGUAGE` в `.env` (`cli.default_language()`), по умолчанию `ru`;
  `auto` превращается в `language=None` — это соглашение faster-whisper для автоопределения.
  CLI-флаг `--language` того же смысла имеет приоритет над `.env`.
- **DeepSeek `deepseek-flash`** по умолчанию в режиме рассуждений, и они расходуют
  `max_tokens` (~3k на 35-минутную встречу) — поэтому лимит 32k. Сменить модель в коде
  или `.env` можно, но актуальные имена моделей проверяй в документации DeepSeek.
- **Ollama по умолчанию режет контекст до 4096 токенов** без ошибки — `num_ctx` задаётся
  явно по размеру запроса, запросы идут в нативный `/api/chat`, не в OpenAI-совместимый.
- **Фильтр личных данных в собеседованиях** (`summary_types/interview.py`, `sanitize`): без
  него `qwen3.5:4b` записывала возраст и планы на ребёнка и даже вносила беременность
  в «Сомнения», несмотря на запрет в промпте. Не убирать; расширять словарь осторожно —
  «семь человек», «5 лет опыта», «внешние сервисы» не должны вырезаться (есть тест).
- **Веб-интерфейс** (`web/`):
  - типы в `web/src/api/types.ts` повторяют схемы `summary_types` и ответы `transcriber/server` — меняй вместе;
    порядок разделов summary в UI задаёт `sectionsFor` в `web/src/job/Summary.tsx`;
  - прокси Vite — на `127.0.0.1:8000`, не `localhost`: Node сначала пробует `::1`, а uvicorn
    слушает только IPv4;
  - EventSource закрывать на `done`/`error` (и если `snapshot` уже завершён), иначе он
    переподключается бесконечно;
  - моки подключаются только под `import.meta.env.DEV`, в `dist` их быть не должно;
  - SSE-потоки сами не заканчиваются: по Ctrl+C `main()` в `server/app.py` ставит `app.state.stopping`,
    и циклы потоков выходят. Без этого uvicorn ждёт открытые вкладки вечно и сервер не останавливается.
- **Админ не видит содержимое чужих записей** — только метаданные и расход. Это решение о
  приватности (собеседования, one-to-one), не недоделка: не добавлять админу доступ к
  расшифровкам без явной просьбы пользователя.
- **API-ключи в базе зашифрованы** (`security.SecretBox`, Fernet от `SECRET_KEY`). Без
  `SECRET_KEY` ключ генерируется в `instance/secret_key`; при смене ключа сохранённые
  значения не расшифровываются и молча уступают `.env` — это ожидаемо.
- **Первый вход**: админ из `ADMIN_EMAIL`/`ADMIN_PASSWORD` при пустой таблице `users` или
  `transcriber-admin create-user --admin`; старые `recordings/jobs/*/job.json` импортируются
  первому админу при каждом старте (уже импортированные пропускаются, файлы не удаляются).
- **Журнал моделей** (`transcriber/log.py`, логгеры `transcriber.*`, `LOG_LEVEL`): только
  метаданные — размеры, время, токены, типы ошибок, пути полей из `e.errors()`. Никогда текст
  расшифровки, промптов, ответов, summary, ключей и `str(e)` у ValidationError/ошибок API (там
  бывает ввод) — есть тест с маркером. В CLI по умолчанию выключен (пользователю всё говорят
  `print` по-русски), в сервере — INFO, с `[job <id>]` из contextvar воркера. Вывод через
  `tqdm.write`, чтобы не ломать прогресс-бар; уровень uvicorn (`warning`) — отдельно.
- **Качество локальной `qwen3.5:4b`**: структура стабильная (JSON по схеме через `format`),
  но путает стороны встречи и может выдумывать детали. DeepSeek заметно точнее.
  Выбор в режиме `auto` — только по размеру контекста, не по качеству.

- **Docker** (`Dockerfile`, `docker-compose.yml`, раздел README «Запуск в Docker»):
  - `docker compose up -d db` поднимает только базу для разработки — `app` и `models` не
    должны становиться её зависимостями;
  - пакет в образе ставится editable в `/app`: пути от `__file__` (models/, recordings/, web/dist,
    instance/) совпадают с bind mount'ами; не менять на обычную установку в site-packages;
  - модель не в образе: одноразовый сервис `models` (`download-model`) качает её в `./models`
    до старта `app` (`service_completed_successfully`); `app` работает с `HF_HUB_OFFLINE=1`.
    Скачивание — в `.<имя>.partial` с переименованием в конце, по HTTP, не Xet
    (`HF_HUB_DISABLE_XET`): так недокачанное лежит на bind mount и видно в прогрессе;
  - `models` стартует от root только чтобы отдать созданные Docker (root на Linux) папки
    `APP_UID` и тут же сбрасывает права; `app` — сразу от `APP_UID`;
  - `CMD` — exec-форма без `sh`/`uv run` плюс `init: true`: SIGTERM доходит до сервера, выход
    с кодом 143 при `docker stop` — нормально;
  - адрес Ollama из админки важнее `DOCKER_OLLAMA_HOST`: `localhost` из контейнера — это сам
    контейнер;
  - эксперименты — отдельным проектом (`docker compose -p <tmp> --env-file <tmp.env>` с
    другими `APP_PORT`/`MODELS_DIR`/`RECORDINGS_DIR`/`INSTANCE_DIR`, без публикации 5432 через
    override `ports: !reset []`), затем `down -v`; том `pgdata` и `./recordings` не трогать.

## Работа с репозиторием

- Не читать и не выводить `.env`.
- `models/` и `recordings/` (записи, расшифровки и summary пользователя) не трогать и не коммитить.
- База веб-интерфейса (Postgres в Docker, volume `pgdata`) — тоже данные пользователя: для
  экспериментов создавай отдельную базу (`CREATE DATABASE …` + `DATABASE_URL`) и удаляй её после.
- Коммиты — только по просьбе пользователя. В удалённый репозиторий пользователь отправляет
  изменения сам, `git push` не делать.
- Агент `.claude/agents/project-architect.md` — аудит структуры; по умолчанию только отчёт.
