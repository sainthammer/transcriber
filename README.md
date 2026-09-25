# vosk-example

Транскрибация аудио через [Vosk](https://alphacephei.com/vosk/) с пунктуацией и summary через DeepSeek или локальную модель в Ollama.

## Установка

Нужны `uv` и `ffmpeg`. Модели скачиваются в `models/`:

- `vosk-model-ru-0.42` — распознавание (по умолчанию)
- `vosk-model-small-ru-0.22` — маленькая быстрая модель (`-m models/vosk-model-small-ru-0.22`)
- `vosk-recasepunc-ru-0.22` — пунктуация и заглавные буквы

Все модели: https://alphacephei.com/vosk/models

Для summary создайте `.env`:

```
DEEPSEEK_API_KEY=sk-...
# DEEPSEEK_MODEL=deepseek-v4-pro   # по умолчанию deepseek-flash
# OLLAMA_MODEL=qwen3.5:4b          # локальная модель
# OLLAMA_MAX_CONTEXT=32768         # до скольки токенов считать локально
```

Для локального summary нужен запущенный [Ollama](https://ollama.com) со скачанной моделью (`ollama pull qwen3.5:4b`).

По умолчанию провайдер summary — `auto`: если расшифровка вместе с ответом помещается в
контекст локальной модели (меньшее из `OLLAMA_MAX_CONTEXT` и лимита самой модели),
summary делается локально, иначе — через DeepSeek. Если Ollama не запущен или модели нет,
тоже используется DeepSeek.

## Запуск

```bash
uv run main.py record.mp3                 # всё: распознавание, пунктуация, summary (auto)
uv run main.py record.mp3 -p ollama       # summary только локальной моделью
uv run main.py record.mp3 -p deepseek     # summary только через DeepSeek
uv run main.py record.mp3 --no-summary    # без summary
uv run summary.py record.txt              # summary по готовой расшифровке (-p как у main.py)
```

Результат рядом с исходным файлом:

- `record.raw.txt` — сырой текст, пишется по ходу распознавания
- `record.txt` — текст с пунктуацией и таймкодами
- `record.summary.md` — структурированное summary
- `record.summary.json` — то же summary в JSON (для интеграций)

## Формат summary

Модель возвращает JSON по строгой схеме (`meeting_summary.py`), скрипт проверяет его
и собирает Markdown по фиксированному шаблону — структура всегда одинаковая:
кратко, участники, ключевые цифры, решения, задачи (таблица), открытые вопросы,
ход обсуждения с таймкодами. Для встреч с клиентом добавляется блок «Клиент»
(потребности, проблемы, возражения, бюджет и сроки, процесс решения, риски сделки),
для внутренних созвонов — «Статус» и «Блокеры и риски». Тип модель определяет сама.

Правила для модели (тон, что считать решением и задачей, как обращаться с ошибками
распознавания) — в `prompts/meeting_summary.md`, их можно править без изменения кода.
