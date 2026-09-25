# vosk-example

Транскрибация аудио через [Vosk](https://alphacephei.com/vosk/) с пунктуацией и summary через DeepSeek или локальную модель в Ollama.

## Установка

Нужны `uv` и `ffmpeg`. Модели скачиваются в `models/`:

- `vosk-model-ru-0.42` — распознавание (по умолчанию)
- `vosk-model-small-ru-0.22` — маленькая быстрая модель (`-m models/vosk-model-small-ru-0.22`)
- `vosk-recasepunc-ru-0.22` — пунктуация и заглавные буквы

Все модели: https://alphacephei.com/vosk/models

Для summary создайте `.env` из шаблона и заполните ключ DeepSeek:

```bash
cp .env.example .env
```

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | ключ DeepSeek API |
| `DEEPSEEK_MODEL` | `deepseek-flash` | модель DeepSeek (`deepseek-v4-pro` — точнее и дороже) |
| `OLLAMA_HOST` | `http://localhost:11434` | адрес Ollama |
| `OLLAMA_MODEL` | `qwen3.5:4b` | локальная модель |
| `OLLAMA_MAX_CONTEXT` | `32768` | до скольки токенов считать локально в режиме `auto` |

Для локального summary нужен запущенный [Ollama](https://ollama.com) со скачанной моделью (`ollama pull qwen3.5:4b`).

По умолчанию провайдер summary — `auto`: если расшифровка вместе с ответом помещается в
контекст локальной модели (меньшее из `OLLAMA_MAX_CONTEXT` и лимита самой модели),
summary делается локально, иначе — через DeepSeek. Если Ollama не запущен или модели нет,
тоже используется DeepSeek.

## Запуск

Записи удобно класть в `recordings/` (папка не в git), но подойдёт любой путь.

```bash
uv run transcribe recordings/record.mp3                # всё: распознавание, пунктуация, summary (auto)
uv run transcribe recordings/record.mp3 -p ollama      # summary только локальной моделью
uv run transcribe recordings/record.mp3 -p deepseek    # summary только через DeepSeek
uv run transcribe recordings/record.mp3 --no-summary   # без summary
uv run transcribe recordings/record.mp3 --no-punct     # без пунктуации
uv run transcribe recordings/record.mp3 -o out/meeting.txt  # другое место для результатов
uv run summarize recordings/record.txt                 # summary по готовой расшифровке (-p как у transcribe)
uv run summarize recordings/record.txt -p ollama --model llama3.1   # конкретная модель
```

Модели ищутся в `models/` в корне проекта, поэтому запускать можно из любой папки:
`uv run --project ~/projects/vosk-example transcribe ~/Downloads/call.mp3`.

Результат рядом с исходным файлом:

- `record.raw.txt` — сырой текст, пишется по ходу распознавания
- `record.txt` — текст с пунктуацией и таймкодами
- `record.summary.md` — структурированное summary
- `record.summary.json` — то же summary в JSON (для интеграций)

## Формат summary

Модель возвращает JSON по строгой схеме (`transcriber/meeting_summary.py`), скрипт проверяет его
и собирает Markdown по фиксированному шаблону — структура всегда одинаковая:
кратко, участники, ключевые цифры, решения, задачи (таблица), открытые вопросы,
ход обсуждения с таймкодами. Для встреч с клиентом добавляется блок «Клиент»
(потребности, проблемы, возражения, бюджет и сроки, процесс решения, риски сделки),
для внутренних созвонов — «Статус» и «Блокеры и риски». Тип модель определяет сама.

Правила для модели (тон, что считать решением и задачей, как обращаться с ошибками
распознавания) — в `transcriber/prompts/meeting_summary.md`, их можно править без изменения кода.

## Устройство

| Файл | Что внутри |
|---|---|
| `transcriber/cli.py` | команда `transcribe`: ffmpeg → распознавание Vosk → пунктуация → summary |
| `transcriber/punctuation.py` | пунктуация и регистр моделью `vosk-recasepunc` |
| `transcriber/summary.py` | команда `summarize`: запросы к DeepSeek и Ollama, выбор провайдера |
| `transcriber/meeting_summary.py` | схема summary и сборка Markdown |
| `transcriber/prompts/meeting_summary.md` | правила для модели при составлении summary |
| `tests/` | тесты схемы, рендера и разбора ответа (без сети и моделей) |
| `models/` | скачанные модели (не в git) |
| `recordings/` | ваши записи, расшифровки и summary (не в git) |

Команды `transcribe` и `summarize` объявлены в `[project.scripts]` в `pyproject.toml`
и устанавливаются в `.venv` при `uv sync` (или первом `uv run`).

## Тесты

```bash
uv run pytest
```
