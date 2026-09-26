# Веб-интерфейс

```bash
npm run dev | build | lint     # lock — package-lock.json, только npm
npm run screenshots            # Playwright → .screenshots/ (--click=<selector> для меню и диалогов)
```

- Типы в `src/api/types.ts` повторяют схемы `transcriber/summary_types` и ответы
  `transcriber/server` — меняй вместе. Порядок разделов summary задаёт `sectionsFor` в `src/job/Summary.tsx`.
- Прокси Vite — на `127.0.0.1:8000`, не `localhost`: Node сначала пробует `::1`, а uvicorn
  слушает только IPv4.
- EventSource закрывать на `done`/`error` (и если `snapshot` уже завершён), иначе он
  переподключается бесконечно. Готовая запись узнаёт о новой версии summary через
  `summary_changed` из общего потока (`useJobs` → событие окна → `useJob`).
- Моки (`src/dev/`) подключаются только под `import.meta.env.DEV`, в `dist` их быть не должно.
