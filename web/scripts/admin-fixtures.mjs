// Fixtures for the admin pages in screenshots (Playwright page.route, no backend needed).
// Deliberately awkward data: long emails, names, file names and model names.
const day = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return d.toISOString()
}

const me = { id: 1, email: 'admin@example.com', name: 'Анна Соколова', role: 'admin' }

const users = [
  { ...me, is_active: true, created_at: day(120), last_login_at: day(0), jobs_count: 42, audio_sec: 81234, tokens_total: 1834000 },
  { id: 2, email: 'konstantin.vasilevsky-rozhdestvensky@very-long-company-domain.example.org', name: 'Константин Васильевский-Рождественский', role: 'user', is_active: true, created_at: day(60), last_login_at: day(2), jobs_count: 7, audio_sec: 12400, tokens_total: 240000 },
  { id: 3, email: 'ivan@example.com', name: '', role: 'user', is_active: false, created_at: day(30), last_login_at: null, jobs_count: 0, audio_sec: 0, tokens_total: 0 },
  { id: 4, email: 'maria.petrova@example.com', name: 'Мария Петрова', role: 'admin', is_active: true, created_at: day(10), last_login_at: day(1), jobs_count: 13, audio_sec: 30000, tokens_total: 560000 },
]

const userJobs = [
  { id: 'j1', filename: 'Собеседование_Backend_Senior_Константин_2026-09-20_полная_запись.m4a', created_at: day(1), duration_sec: 3120, status: 'done', summary_type: 'interview', provider_used: 'deepseek' },
  { id: 'j2', filename: 'one-on-one.mp3', created_at: day(3), duration_sec: 1800, status: 'error', summary_type: 'one_on_one', provider_used: 'ollama' },
  { id: 'j3', filename: 'Планёрка.wav', created_at: day(4), duration_sec: 600, status: 'running', summary_type: null, provider_used: null },
]

const type = (t) => ({ builtin: true, enabled: true, prompt: 'Правила…\n'.repeat(8), default_prompt: '', prompt_modified: false, sections: null, jobs_count: 0, updated_at: null, ...t })
const types = [
  type({ id: 'meeting', label: 'Рабочая встреча', description: 'Обсуждение задач команды: решения, поручения, открытые вопросы', jobs_count: 31 }),
  type({ id: 'interview', label: 'Собеседование', description: 'Интервью с кандидатом: опыт, компетенции, сомнения и итоговая рекомендация', jobs_count: 12, prompt_modified: true }),
  type({ id: 'one_on_one', label: 'One-to-one', description: 'Встреча руководителя с сотрудником', enabled: false }),
  type({ id: 'retrospective_with_a_very_long_identifier', builtin: false, label: 'Ретроспектива спринта с разбором инцидентов и планом улучшений на квартал', description: 'Что получилось, что мешало, что изменить в следующем спринте', sections: [
    { key: 'went_well', title: 'Что получилось', description: 'Что стоит сохранить' },
    { key: 'to_improve_in_the_next_sprint', title: 'Что улучшить в следующем спринте обязательно', description: 'Что мешало работать и что команда хочет изменить' },
  ], jobs_count: 2 }),
]

const settings = {
  items: [
    { key: 'deepseek_api_key', label: 'API-ключ', group: 'deepseek', value: 'sk-…a1b2', secret: true, source: 'db', default: 'sk-…ffff', help: null },
    { key: 'deepseek_model', label: 'Модель', group: 'deepseek', value: 'deepseek-flash', secret: false, source: 'default', default: 'deepseek-flash', help: 'Имя модели в API DeepSeek.' },
    { key: 'ollama_host', label: 'Адрес сервера', group: 'ollama', value: 'http://127.0.0.1:11434', secret: false, source: 'db', default: 'http://localhost:11434', help: null },
    { key: 'ollama_model', label: 'Модель', group: 'ollama', value: 'qwen3.5:4b', secret: false, source: 'env', default: 'qwen3.5:4b', help: null },
    { key: 'ollama_max_context', label: 'Максимальный контекст, токенов', group: 'ollama', value: 32768, secret: false, source: 'default', default: 32768, help: 'Длинные записи, которые не помещаются, уходят в DeepSeek (в режиме «Авто»).' },
    { key: 'yandex_api_key', label: 'Ключ API', group: 'yandex', value: 'AQVN…x7Qe', secret: true, source: 'db', default: null, help: 'API-ключ сервисного аккаунта с ролью ai.languageModels.user' },
    { key: 'yandex_folder_id', label: 'ID каталога', group: 'yandex', value: null, secret: false, source: 'default', default: null, help: 'Каталог Yandex Cloud, в котором работает модель (b1g…)' },
    { key: 'yandex_model', label: 'Модель', group: 'yandex', value: 'yandexgpt/latest', secret: false, source: 'default', default: 'yandexgpt/latest', help: 'yandexgpt/latest — YandexGPT Pro, yandexgpt-lite/latest — дешевле; или полный URI gpt://…' },
    { key: 'yandex_max_context', label: 'Лимит контекста', group: 'yandex', value: 32768, secret: false, source: 'default', default: 32768, help: 'Контекст модели в токенах; длиннее — понятная ошибка до запроса. YandexGPT — 32768' },
    { key: 'whisper_language', label: 'Язык записей', group: 'whisper', value: 'ru', secret: false, source: 'env', default: 'ru', help: null },
  ],
  ollama_models: null,
  ollama_error: 'connection refused (127.0.0.1:11434)',
}

function usage(days) {
  const daily = []
  for (let i = 0; i < days; i++) {
    const date = day(i).slice(0, 10)
    if (i % 3 !== 1) daily.push({ date, provider: 'deepseek', prompt_tokens: 20000 + ((i * 7919) % 50000), completion_tokens: 4000 + ((i * 131) % 6000) })
    if (i % 5 === 2) daily.push({ date, provider: 'yandex', prompt_tokens: 12000 + ((i * 2749) % 20000), completion_tokens: 2500 })
    if (i % 4 === 0) daily.push({ date, provider: 'ollama', prompt_tokens: 15000 + ((i * 3571) % 30000), completion_tokens: 3000 })
  }
  return {
    from: day(days),
    to: day(0),
    totals: { prompt_tokens: 1800000, completion_tokens: 320000, requests: 184, audio_sec: 123634 },
    by_user: users.slice(0, 3).map((u, i) => ({ user_id: u.id, email: u.email, name: u.name, requests: 60 - i * 20, audio_sec: u.audio_sec, prompt_tokens: 600000 - i * 150000, completion_tokens: 100000 - i * 30000 })),
    by_model: [
      { provider: 'deepseek', model: 'deepseek-flash', requests: 120, prompt_tokens: 1400000, completion_tokens: 260000 },
      { provider: 'yandex', model: 'yandexgpt/latest', requests: 22, prompt_tokens: 280000, completion_tokens: 40000 },
      { provider: 'ollama', model: 'qwen3.5:4b-instruct-q4_K_M-with-a-long-tag', requests: 64, prompt_tokens: 400000, completion_tokens: 60000 },
    ],
    by_user_model: [
      { user_id: 1, provider: 'deepseek', model: 'deepseek-flash', requests: 40, prompt_tokens: 500000, completion_tokens: 90000 },
      { user_id: 1, provider: 'ollama', model: 'qwen3.5:4b-instruct-q4_K_M-with-a-long-tag', requests: 20, prompt_tokens: 100000, completion_tokens: 10000 },
      { user_id: 2, provider: 'deepseek', model: 'deepseek-flash', requests: 30, prompt_tokens: 400000, completion_tokens: 60000 },
      { user_id: 2, provider: 'yandex', model: 'yandexgpt/latest', requests: 22, prompt_tokens: 280000, completion_tokens: 40000 },
      { user_id: 3, provider: 'ollama', model: 'qwen3.5:4b-instruct-q4_K_M-with-a-long-tag', requests: 20, prompt_tokens: 300000, completion_tokens: 40000 },
    ],
    daily,
  }
}

const config = {
  providers: { deepseek: { available: true, reason: null, model: 'deepseek-flash' }, ollama: { available: true, reason: null, model: 'qwen3.5:4b' }, yandex: { available: false, reason: 'no_folder_id', model: 'yandexgpt/latest' } },
  summary_types: [],
  defaults: { provider: 'auto', summary: true, summary_type: 'auto' },
}

function respond(path, search) {
  if (path === '/api/auth/me') return me
  if (path === '/api/config') return config
  if (path === '/api/jobs') return []
  if (path === '/api/admin/users') return users
  if (/^\/api\/admin\/users\/\d+\/jobs$/.test(path)) return userJobs
  if (path === '/api/admin/summary-types') return types
  if (path === '/api/admin/base-prompt') return { prompt: 'Общие правила…\n'.repeat(12), default_prompt: '', modified: true }
  if (path === '/api/admin/settings') return settings
  if (path === '/api/admin/usage') return usage(Number(new URLSearchParams(search).get('days') ?? 30))
  return undefined
}

/** Routes /api/* of a Playwright context to the fixtures above. */
export async function installAdminFixtures(context) {
  await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/events')) return route.abort()
    const body = respond(url.pathname, url.search)
    if (body === undefined) return route.fulfill({ status: 404, json: { detail: 'Нет в фикстурах' } })
    return route.fulfill({ json: body })
  })
}
