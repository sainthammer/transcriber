# Транскрибация и summary записей

Транскрибация аудио через [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(модель Whisper large-v3-turbo) и summary через DeepSeek или локальную модель в Ollama.

## Установка

Нужны `uv` и `ffmpeg` (или только Docker — см. «Запуск в Docker»). Модель распознавания
(~1,5 ГБ) нужно один раз скачать в `models/`:

```bash
uv run download-model    # models/faster-whisper-large-v3-turbo; уже скачанную не трогает
```

Для summary создайте `.env` из шаблона и заполните ключ DeepSeek:

```bash
cp .env.example .env
```

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `WHISPER_LANGUAGE` | `ru` | язык распознавания; `auto` — определять автоматически |
| `WHISPER_MODEL` | `faster-whisper-large-v3-turbo` | папка модели в `models/` или абсолютный путь; `faster-whisper-<размер>` (`small`, `medium`, `large-v3`…) скачивает `download-model` |
| `DEEPSEEK_API_KEY` | — | ключ DeepSeek API |
| `DEEPSEEK_MODEL` | `deepseek-flash` | модель DeepSeek (`deepseek-v4-pro` — точнее и дороже) |
| `OLLAMA_HOST` | `http://localhost:11434` | адрес Ollama |
| `OLLAMA_MODEL` | `qwen3.5:4b` | локальная модель |
| `OLLAMA_MAX_CONTEXT` | `32768` | до скольки токенов считать локально в режиме `auto` |
| `LOG_LEVEL` | CLI — выкл., сервер — `INFO` | журнал работы моделей (`DEBUG`, `INFO`, `WARNING`, `ERROR`), см. «Журнал работы моделей» |

Для локального summary нужен запущенный [Ollama](https://ollama.com) со скачанной моделью (`ollama pull qwen3.5:4b`).

По умолчанию провайдер summary — `auto`: если расшифровка вместе с ответом помещается в
контекст локальной модели (меньшее из `OLLAMA_MAX_CONTEXT` и лимита самой модели),
summary делается локально, иначе — через DeepSeek. Если Ollama не запущен или модели нет,
тоже используется DeepSeek.

## Запуск

Записи удобно класть в `recordings/` (папка не в git), но подойдёт любой путь.

```bash
uv run transcribe recordings/record.mp3                # всё: распознавание, summary (auto)
uv run transcribe recordings/record.mp3 -p ollama      # summary только локальной моделью
uv run transcribe recordings/record.mp3 -p deepseek    # summary только через DeepSeek
uv run transcribe recordings/record.mp3 --no-summary   # без summary
uv run transcribe recordings/record.mp3 --language en  # распознавание на другом языке (по умолчанию — .env, иначе ru)
uv run transcribe recordings/record.mp3 -o out/meeting.txt  # другое место для результатов
uv run summarize recordings/record.txt                 # summary по готовой расшифровке (-p как у transcribe)
uv run summarize recordings/record.txt -p ollama --model llama3.1   # конкретная модель
uv run summarize recordings/record.txt -t interview    # тип записи задан явно (см. «Типы summary»)
uv run summarize recordings/record.txt -i "Иван — заказчик"  # пожелания к summary (правила типа важнее)
```

Модели ищутся в `models/` в корне проекта, поэтому запускать можно из любой папки:
`uv run --project <путь к проекту> transcribe ~/Downloads/call.mp3`.

Результат рядом с исходным файлом:

- `record.txt` — текст с пунктуацией и таймкодами, пишется по ходу распознавания
- `record.summary.md` — структурированное summary
- `record.summary.json` — то же summary в JSON (для интеграций)
- `record.summary.docx` — то же summary в Word: для отправки коллегам и печати

### Журнал работы моделей

Для разработчика: какая модель вызывалась, сколько символов и токенов ушло и пришло, сколько
длился запрос, почему закончилась генерация, повторы после ошибки схемы; для Whisper — загрузка
модели, язык, длительность аудио и скорость распознавания. Пишется в stderr в формате uvicorn
(`INFO:     transcriber.summary: LLM done: ...`), в веб-интерфейсе — с id задачи (`[job <id>]`).

```bash
LOG_LEVEL=INFO uv run summarize recordings/record.txt -p ollama   # CLI: по умолчанию журнал выключен
LOG_LEVEL=DEBUG uv run transcriber-web --no-browser               # сервер: по умолчанию INFO
```

В журнал попадают только метаданные и цифры — никогда текст расшифровок, промптов, ответов
модели и summary, даже на `DEBUG`: записи — собеседования и one-to-one.

## Веб-интерфейс

Загрузка записей, прогресс обработки, summary с переходом по таймкодам к месту в записи,
расшифровка с поиском и плеер, скачивание summary в Word, Markdown и JSON.
Summary можно сделать заново — другим провайдером, типом или с пожеланиями
(«подробнее про задачи»); последние 20 версий сохраняются, к любой можно вернуться.

Интерфейс работает с учётными записями: у каждого пользователя свой список записей,
а администратор управляет пользователями, ключами API и моделями, типами встреч и их
промптами и видит расход токенов. Данные хранятся в Postgres, для него нужен Docker
(например, [OrbStack](https://orbstack.dev)), а для сборки интерфейса — Node.js (npm).

```bash
docker compose up -d db                     # Postgres на 127.0.0.1:5432
cd web && npm install && npm run build && cd ..
uv run transcriber-web                      # откроет http://127.0.0.1:8000
```

Первый администратор создаётся при запуске из `ADMIN_EMAIL` и `ADMIN_PASSWORD` в `.env`
(если пользователей ещё нет) или командой:

```bash
uv run transcriber-admin create-user you@example.com --name "Имя" --admin
uv run transcriber-admin set-password you@example.com    # забыли пароль
uv run transcriber-admin list-users
```

Остальных пользователей заводит администратор в интерфейсе, самостоятельной регистрации
нет. Администратор видит у чужих записей только метаданные (имя файла, дата, длительность,
тип) и расход, но не расшифровки и summary.

Переменные веб-интерфейса в `.env`:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://transcriber:transcriber@127.0.0.1:5432/transcriber` | база веб-интерфейса |
| `SECRET_KEY` | генерируется в `instance/secret_key` | шифрование ключей API в базе |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | — | первый администратор (если пользователей нет) |
| `COOKIE_SECURE` | — | `1`, если интерфейс открыт по HTTPS |

Настройки из админки (ключ DeepSeek, модели, адрес Ollama, язык распознавания) перекрывают
`.env`, а если их сбросить, снова действует `.env`. Ключи API хранятся в базе
зашифрованными ключом `SECRET_KEY`. Команды `transcribe` и `summarize` базу не используют и
берут настройки только из `.env`.

Схема базы обновляется сама при запуске сервера (миграции Alembic). Записи, сделанные до
появления учётных записей (`recordings/jobs/*/job.json`), при первом запуске переходят
первому администратору.

Файлы записей хранятся в `recordings/jobs/`. Обработка идёт по одной записи, модель
распознавания загружается при первой записи и остаётся в памяти (~2 ГБ), пока сервер запущен.

Разработка интерфейса — в двух терминалах: `uv run transcriber-web --no-browser` и
`cd web && npm run dev` (http://localhost:5173). В dev-режиме есть моки состояний:
`?mock=states`, `?mock=empty`, `?mock=offline`.

Документация API — http://127.0.0.1:8000/api/docs (Swagger UI) и `/api/redoc`, схема —
`/api/openapi.json`. Чтобы вызывать методы из Swagger, сначала выполните там
`POST /api/auth/login`: сессия хранится в куке, её браузер подставит сам.

## Запуск в Docker

Всё приложение — база, сервер и собранный интерфейс — одной командой. Нужен только Docker
(Docker Desktop, OrbStack или Docker Engine) с Compose v2.24+; `uv`, Node.js и `ffmpeg` не нужны.

```bash
cp .env.example .env          # необязательно: ключ DeepSeek, ADMIN_EMAIL/ADMIN_PASSWORD, SECRET_KEY
docker compose up -d --build  # http://127.0.0.1:8000
docker compose logs -f models app
```

Что поднимается:

| Сервис | Что делает | Данные |
|---|---|---|
| `db` | Postgres | том `pgdata` |
| `models` | одноразовый: скачивает модель, если её нет, и завершается | `./models` (`MODELS_DIR`) |
| `app` | сервер и интерфейс на `127.0.0.1:8000` (`APP_PORT`), стартует после `db` и `models` | `./recordings`, `./instance` |

- **Первый запуск** скачивает модель (~1,5 ГБ, несколько минут, прогресс — в
  `docker compose logs -f models`), и только потом стартует `app`. Модель лежит в `./models`
  на диске хоста, поэтому переживает пересборку и не качается повторно; уже скачанная для
  запуска без Docker тоже подхватывается. Прерванное скачивание не оставляет битую модель:
  файлы качаются в `models/.<имя>.partial` и переименовываются в конце.
- **Первый вход** — `ADMIN_EMAIL`/`ADMIN_PASSWORD` из `.env` или
  `docker compose exec app transcriber-admin create-user you@example.com --name "Имя" --admin`.
- **Данные**: база — в томе `pgdata` (тот же, что у `docker compose up -d db`), записи — в
  `./recordings/jobs`, ключ шифрования — в `./instance` (или `SECRET_KEY` в `.env`). Не
  запускайте одновременно `app` и `uv run transcriber-web`: у них общие база и записи.
- **Обновление**: `git pull && docker compose up -d --build` — данные остаются.
  `docker compose down` данные не трогает; `down -v` удаляет том с базой.
- **Бэкап базы**: `docker compose exec db pg_dump -U transcriber transcriber > backup.sql`.
- **Ollama** — на хосте, контейнер обращается к нему по `http://host.docker.internal:11434`
  (`DOCKER_OLLAMA_HOST`). Адрес Ollama, сохранённый в админке, важнее переменных окружения:
  если там `http://localhost:11434`, из контейнера Ollama не найдётся — сбросьте его или
  укажите `host.docker.internal`.
- **DeepSeek через VPN/прокси хоста**: раскомментируйте `HTTPS_PROXY` в `docker-compose.yml`;
  прокси должен принимать подключения не только с `127.0.0.1`.
- **Скорость**: распознавание в контейнере на процессоре, как и без Docker (GPU нет ни там,
  ни там); контейнеру нужно ~2–3 ГБ памяти (лимит — `APP_MEMORY`, по умолчанию 4 ГБ).
  В Docker Desktop выделите виртуальной машине не меньше 6 ГБ.

Для разработки по-прежнему достаточно одной базы: `docker compose up -d db`.

### macOS

Docker Desktop или OrbStack, дальше — команды выше. Образ собирается под архитектуру Mac
(arm64 на Apple Silicon).

### Windows

Через Docker Desktop с WSL 2. Клонируйте репозиторий **внутрь WSL** (`~/…` в Ubuntu, не
`/mnt/c/…`): на диске Windows bind mount медленный. Команды — в терминале WSL. Памяти WSL
по умолчанию может не хватить: в `%UserProfile%\.wslconfig`

```ini
[wsl2]
memory=8GB
```

и `wsl --shutdown`. Переводы строк в репозитории — LF (`.gitattributes`), так что клон через
Git for Windows тоже подойдёт. Ollama для Windows обычно доступен из контейнера по
`host.docker.internal` как есть; если нет — задайте ему переменную `OLLAMA_HOST=0.0.0.0` и
перезапустите.

### Linux

Docker Engine и плагин `docker compose`. Сервер работает не от root, а от `APP_UID:APP_GID`
(по умолчанию `1000:1000` — обычно это первый пользователь). Если `id -u` у вас другой:

```bash
echo "APP_UID=$(id -u)" >> .env && echo "APP_GID=$(id -g)" >> .env
```

Папки `models`, `recordings`, `instance`, которые создаст сам Docker (от root), сервис
`models` отдаёт этому пользователю; уже существующие не трогает — они должны быть доступны
ему на запись. Ollama на хосте слушает только `127.0.0.1`, а контейнер приходит с адреса
моста: запустите его с `OLLAMA_HOST=0.0.0.0` (`systemctl edit ollama` →
`Environment="OLLAMA_HOST=0.0.0.0"`) и закройте порт 11434 снаружи файрволом.

## Типы summary

Модель возвращает JSON по строгой схеме, скрипт проверяет его и собирает Markdown по
фиксированному шаблону. Общие разделы у всех типов: кратко, участники, ключевые цифры,
решения, задачи (таблица), открытые вопросы, ход обсуждения с таймкодами. Плюс разделы
своего типа:

| Тип (`-t`) | Для чего | Свои разделы |
|---|---|---|
| `client` | встреча с клиентом, заказчиком, партнёром | потребности, проблемы, возражения, бюджет и сроки, процесс решения, риски сделки |
| `meeting` | совещание команды | статусы, блокеры и риски |
| `interview` | собеседование | предварительная оценка, вакансия и опыт, компетенции с подтверждениями, сильные стороны, сомнения, мотивация, ожидания, вопросы кандидата |
| `one_on_one` | встреча руководителя и сотрудника | успехи, сложности, нагрузка, обратная связь в обе стороны, развитие, темы на следующую встречу |
| `highlights` | всё остальное: доклад, брифинг, звонок без чёткой структуры; он же — запасной тип, если определить не удалось | тезисы |

По умолчанию `-t auto`: модель определяет тип по началу расшифровки отдельным коротким
запросом, затем делает summary по правилам этого типа.

В summary собеседования не попадают возраст, пол, семья, здоровье и другие личные
характеристики кандидата: это запрещено в инструкции модели и дополнительно вычищается
кодом после генерации. Для собеседований и one-to-one разумно использовать `-p ollama` —
текст разговора не покинет компьютер.

Каждый тип — «скилл» из двух файлов в `transcriber/summary_types/`: `<тип>.md` — правила
для модели (что важно, как заполнять разделы), `<тип>.py` — схема разделов и их вид в
Markdown. Общие правила — в `base.md` и `base.py`. Правила можно править без изменения кода.
Новый тип: добавить пару файлов и зарегистрировать его в `transcriber/summary_types/__init__.py`.

В веб-интерфейсе администратор может без кода создать свой тип (промпт и список разделов
с описаниями), поправить промпт встроенного типа и общие правила или отключить тип. Эти
изменения хранятся в базе и действуют только в веб-интерфейсе.

## Устройство

| Файл | Что внутри |
|---|---|
| `transcriber/cli.py` | команда `transcribe`: распознавание faster-whisper (с пунктуацией) → summary |
| `transcriber/summary.py` | команда `summarize`: запросы к DeepSeek и Ollama, выбор провайдера и типа |
| `transcriber/summary_types/` | типы summary: общая схема и правила (`base.*`) и по паре файлов на тип |
| `transcriber/log.py` | журнал работы моделей: `LOG_LEVEL`, формат uvicorn, id задачи сервера |
| `transcriber/docx_export.py` | Word-версия summary: Markdown из `render_markdown` → стилизованный .docx |
| `transcriber/server/` | команда `transcriber-web`: сервер веб-интерфейса — вход (`auth.py`), записи (`jobs.py`), админка (`admin.py`, `settings.py`, `types_store.py`), база (`db.py`, `migrations/`), описание API для Swagger (`api_docs.py`) |
| `transcriber/server/manage.py` | команда `transcriber-admin`: пользователи из командной строки |
| `transcriber/models.py` | команда `download-model`: скачать модель распознавания, если её нет |
| `docker-compose.yml`, `Dockerfile` | Postgres для разработки; всё приложение в Docker (см. «Запуск в Docker») |
| `web/` | веб-интерфейс: Vite + React + TypeScript, сборка в `web/dist` |
| `tests/` | тесты схем, рендера, разбора ответа и API сервера (без сети, моделей и Postgres — на SQLite) |
| `models/` | скачанные модели (не в git) |
| `recordings/` | ваши записи, расшифровки и summary (не в git) |

Команды `transcribe`, `summarize`, `transcriber-web`, `transcriber-admin` и `download-model`
объявлены в `[project.scripts]` в `pyproject.toml` и устанавливаются в `.venv` при `uv sync` (или первом `uv run`).

Частые команды есть и в `Makefile`: `make` без цели печатает список.

```bash
make test                                              # тесты
make transcribe FILE=recordings/record.mp3 ARGS="-p ollama"
make web                                               # Postgres + API на :8000
make rebuild                                           # пересобрать приложение в Docker после изменений
```

## Тесты

```bash
uv run pytest
uv run ruff check transcriber tests   # линтер Python; make lint гоняет его и интерфейс
```

CI (`.github/workflows/ci.yml`) на каждый push и pull request прогоняет то же самое —
`ruff` и `pytest` для Python, `oxlint` и сборку для интерфейса.
