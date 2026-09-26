// Dev-only fake backend for UI states that are hard to reproduce with the real one.
// Enabled by ?mock=<scenario> (remembered for the tab): states | empty | offline.
// Summary versions: mock-interview has three, mock-regenerating is making a new one,
// mock-regen-error keeps the old one after a failure. A request whose wishes contain
// «ошибка» fails the same way.
// Imported only under import.meta.env.DEV, so none of this reaches the production build.

import { urls } from '../api/client'
import type {
  Config,
  JobDetail,
  JobListItem,
  Phrase,
  StageInfo,
  Summary,
  SummaryVersion,
  User,
} from '../api/types'
import interviewSummary from './fixtures/interview.summary.json'
import oneOnOneSummary from './fixtures/one_on_one.summary.json'
import interviewText from './fixtures/interview.txt?raw'
import oneOnOneText from './fixtures/one_on_one.txt?raw'

type Scenario = 'states' | 'empty' | 'offline'

function parseTranscript(text: string): Phrase[] {
  return text
    .split('\n')
    .map((line) => line.match(/^\[(\d\d):(\d\d):(\d\d)\] (.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ start_sec: +m[1] * 3600 + +m[2] * 60 + +m[3], text: m[4] }))
}

const iso = (daysAgo: number, h: number, m: number) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

const stage = (status: StageInfo['status'], minutesAgo = 5): StageInfo => ({
  status,
  started_at:
    status === 'pending' || status === 'skipped'
      ? null
      : new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  finished_at:
    status === 'done' || status === 'error'
      ? new Date(Date.now() - (minutesAgo - 1) * 60_000).toISOString()
      : null,
})

function job(
  partial: Partial<JobDetail> &
    Pick<JobDetail, 'id' | 'filename' | 'created_at'>
): JobDetail {
  return {
    duration_sec: 272,
    status: 'done',
    stage: null,
    progress_pct: 100,
    queue_position: null,
    title: null,
    options: {
      provider: 'auto',
      summary: true,
      summary_type: 'auto',
    },
    stages: {
      transcribing: stage('done'),
      summarizing: stage('done'),
    },
    progress: { processed_sec: 272, total_sec: 272, phrases: 0 },
    error: null,
    summary_error: null,
    provider_used: null,
    audio_ready: true,
    transcript: [],
    summary: null,
    summary_versions: [],
    ...partial,
  }
}

const interview = parseTranscript(interviewText)
const oneOnOne = parseTranscript(oneOnOneText)

// --- Summary versions: content by version id, so switching visibly changes the text ---

const versionContent = new Map<number, Summary>()
let nextVersionId = 100

function variant(base: Summary, n: number, provider: 'deepseek' | 'ollama'): Summary {
  return n === 1
    ? base
    : {
        ...base,
        tldr:
          provider === 'ollama'
            ? `${base.tldr} (Черновик локальной модели — детали стоит сверить с расшифровкой.)`
            : `Версия ${n}. ${base.tldr}`,
      }
}

/** Versions newest first, `minutesAfter` the job was created; the newest is current by default. */
function versions(
  created: string,
  base: Summary,
  list: { minutesAfter: number; provider: 'deepseek' | 'ollama'; instructions?: string }[],
  currentIndex = 0,
): { summary: Summary; summary_versions: SummaryVersion[] } {
  const total = list.length
  const out = list.map((v, i) => {
    const id = nextVersionId++
    versionContent.set(id, variant(base, total - i, v.provider))
    return {
      id,
      created_at: new Date(Date.parse(created) + v.minutesAfter * 60_000).toISOString(),
      provider: v.provider,
      summary_type: base.meeting_type,
      instructions: v.instructions ?? null,
      current: i === currentIndex,
    }
  })
  return { summary: versionContent.get(out[currentIndex].id)!, summary_versions: out }
}

function initialJobs(): JobDetail[] {
  return [
    job({
      id: 'mock-running',
      filename: 'Звонок с подрядчиком.m4a',
      created_at: iso(0, 11, 40),
      duration_sec: 260,
      status: 'running',
      stage: 'transcribing',
      progress_pct: 0,
      stages: {
        transcribing: stage('running', 1),
        summarizing: stage('pending'),
      },
      progress: { processed_sec: 0, total_sec: 260, phrases: 0 },
    }),
    job({
      id: 'mock-queued',
      filename: 'Планёрка 25.09.mp3',
      created_at: iso(0, 11, 42),
      duration_sec: 1860,
      status: 'queued',
      progress_pct: 0,
      queue_position: 1,
      stages: {
        transcribing: stage('pending'),
        summarizing: stage('pending'),
      },
      progress: { processed_sec: 0, total_sec: 1860, phrases: 0 },
    }),
    job({
      id: 'mock-interview',
      filename: 'interview.m4a',
      created_at: iso(0, 10, 30),
      duration_sec: 260,
      title: interviewSummary.title,
      provider_used: 'deepseek',
      options: {
        provider: 'deepseek',
        summary: true,
        summary_type: 'interview',
      },
      transcript: interview,
      progress: {
        processed_sec: 260,
        total_sec: 260,
        phrases: interview.length,
      },
      ...versions(iso(0, 10, 30), interviewSummary as Summary, [
        {
          minutesAfter: 25,
          provider: 'deepseek',
          instructions:
            'Подробнее про опыт с Kafka и ожидания по зарплате; кандидата зовут Ирина, не Марина.',
        },
        { minutesAfter: 12, provider: 'ollama' },
        { minutesAfter: 6, provider: 'deepseek' },
      ]),
    }),
    job({
      id: 'mock-regenerating',
      filename: 'Собеседование — бэкенд.m4a',
      created_at: iso(0, 9, 10),
      duration_sec: 260,
      status: 'running',
      stage: 'summarizing',
      progress_pct: 95,
      provider_used: 'deepseek',
      options: { provider: 'deepseek', summary: true, summary_type: 'interview' },
      stages: {
        transcribing: stage('done', 30),
        summarizing: stage('running', 1),
      },
      transcript: interview,
      progress: { processed_sec: 260, total_sec: 260, phrases: interview.length },
      ...versions(iso(0, 9, 10), interviewSummary as Summary, [
        { minutesAfter: 18, provider: 'ollama' },
        { minutesAfter: 6, provider: 'deepseek' },
      ]),
    }),
    job({
      id: 'mock-regen-error',
      filename: 'Собеседование — фронтенд.m4a',
      created_at: iso(1, 15, 20),
      duration_sec: 260,
      provider_used: 'ollama',
      options: { provider: 'ollama', summary: true, summary_type: 'interview' },
      stages: {
        transcribing: stage('done', 90),
        summarizing: stage('error', 2),
      },
      summary_error:
        'Модель вернула ответ не по схеме — попробуйте ещё раз или выберите DeepSeek',
      transcript: interview,
      progress: { processed_sec: 260, total_sec: 260, phrases: interview.length },
      ...versions(iso(1, 15, 20), interviewSummary as Summary, [
        { minutesAfter: 40, provider: 'deepseek', instructions: 'Короче, только решения и задачи' },
        { minutesAfter: 7, provider: 'deepseek' },
      ]),
    }),
    job({
      id: 'mock-one-on-one',
      filename: '1-1 Дима.m4a',
      created_at: iso(1, 17, 5),
      duration_sec: 170,
      title: oneOnOneSummary.title,
      provider_used: 'ollama',
      options: {
        provider: 'ollama',
        summary: true,
        summary_type: 'one_on_one',
      },
      transcript: oneOnOne,
      progress: {
        processed_sec: 170,
        total_sec: 170,
        phrases: oneOnOne.length,
      },
      summary: oneOnOneSummary as Summary,
    }),
    job({
      id: 'mock-summary-error',
      filename: 'Созвон с юристами.mp3',
      created_at: iso(1, 12, 15),
      duration_sec: 260,
      provider_used: 'ollama',
      stages: {
        transcribing: stage('done'),
        summarizing: stage('error'),
      },
      summary_error:
        'Модель вернула ответ не по схеме — попробуйте ещё раз или выберите DeepSeek',
      transcript: interview,
    }),
    job({
      id: 'mock-no-summary',
      filename: 'Лекция по SQL.mp4',
      created_at: iso(3, 9, 0),
      duration_sec: 260,
      options: {
        provider: 'auto',
        summary: false,
        summary_type: 'auto',
      },
      stages: {
        transcribing: stage('done'),
        summarizing: stage('skipped'),
      },
      transcript: oneOnOne,
    }),
    job({
      id: 'mock-error',
      filename: 'Без звука.mov',
      created_at: iso(3, 8, 45),
      duration_sec: 42,
      status: 'error',
      progress_pct: 0,
      error: 'В записи не найдено речи',
      stages: {
        transcribing: stage('error'),
        summarizing: stage('pending'),
      },
    }),
  ]
}

const configs: Record<'ok' | 'none', Config> = {
  ok: {
    providers: {
      deepseek: { available: true, reason: null, model: 'DeepSeek' },
      ollama: { available: true, reason: null, model: 'Локальный ИИ' },
    },
    summary_types: [
      {
        id: 'client',
        label: 'Встреча с клиентом',
        description:
          'встреча с внешним клиентом, заказчиком или партнёром: потребности, предложение, условия, цена, договор',
        builtin: true,
        sections: null,
      },
      {
        id: 'meeting',
        label: 'Совещание',
        description:
          'внутренняя встреча команды: статусы, планирование, обсуждение решений, распределение задач',
        builtin: true,
        sections: null,
      },
      {
        id: 'interview',
        label: 'Собеседование',
        description:
          'собеседование с кандидатом на вакансию: опыт, навыки, мотивация, условия',
        builtin: true,
        sections: null,
      },
      {
        id: 'one_on_one',
        label: 'Один на один',
        builtin: true,
        sections: null,
        description:
          'регулярная встреча руководителя и сотрудника один на один: прогресс, сложности, обратная связь, нагрузка, развитие',
      },
      {
        id: 'highlights',
        label: 'Общие тезисы',
        builtin: true,
        sections: null,
        description:
          'запись, которая не подходит под другие типы: доклад, брифинг, звонок или обсуждение без строгой структуры участников и ролей',
      },
    ],
    defaults: {
      provider: 'auto',
      summary: true,
      summary_type: 'auto',
    },
    max_upload_bytes: 2 * 1024 ** 3,
  },
  none: {} as Config,
}
configs.none = {
  ...configs.ok,
  providers: {
    deepseek: {
      available: false,
      reason: 'no_api_key',
      model: 'deepseek-flash',
    },
    ollama: { available: false, reason: 'not_running', model: 'qwen3.5:4b' },
  },
}

const mockUser: User = {
  id: 1,
  email: 'anna@example.com',
  name: 'Анна',
  role: 'admin',
}

// --- State and change notifications ---

let jobs: JobDetail[] = []
const listeners = new Set<(event: string, data: unknown) => void>()
const emitAll = (event: string, data: unknown) =>
  listeners.forEach((l) => l(event, data))

const listItem = (j: JobDetail): JobListItem => ({
  id: j.id,
  filename: j.filename,
  created_at: j.created_at,
  duration_sec: j.duration_sec,
  status: j.status,
  stage: j.stage,
  progress_pct: j.progress_pct,
  queue_position: j.queue_position,
  title: j.summary?.title ?? null,
})

function update(id: string, patch: Partial<JobDetail>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j))
  const j = jobs.find((x) => x.id === id)
  if (j) emitAll('job_updated', listItem(j))
}

/** Simulated pipeline for the running job: model load, progress, phrases, done. */
function simulate(
  id: string,
  summary: Summary,
  final: Phrase[],
  total: number
) {
  let processed = 0
  let sent = 0
  const startedAt = Date.now()
  const timer = setInterval(() => {
    const j = jobs.find((x) => x.id === id)
    if (!j) return clearInterval(timer)
    if (Date.now() - startedAt < 6000) return // "loading the recognition model"
    processed = Math.min(total, processed + 4)
    const phrases: Phrase[] = []
    while (sent < final.length && final[sent].start_sec <= processed)
      phrases.push(final[sent++])
    const transcript = [...j.transcript, ...phrases]
    update(id, {
      progress: {
        processed_sec: processed,
        total_sec: total,
        phrases: transcript.length,
      },
      progress_pct: Math.round((95 * processed) / total),
      transcript,
    })
    phrases.forEach((p) => emitJob(id, 'phrase', p))
    emitJob(id, 'progress', {
      stage: 'transcribing',
      processed_sec: processed,
      total_sec: total,
      phrases: transcript.length,
    })
    if (processed >= total) {
      clearInterval(timer)
      update(id, {
        stage: 'summarizing',
        provider_used: 'ollama',
        stages: {
          ...j.stages,
          transcribing: stage('done', 1),
          summarizing: stage('running', 0),
        },
      })
      emitJob(id, 'stage', { stage: 'summarizing', provider: 'ollama' })
      setTimeout(() => {
        const c = jobs.find((x) => x.id === id)!
        update(id, {
          status: 'done',
          stage: null,
          progress_pct: 100,
          summary,
          title: summary.title,
          stages: { ...c.stages, summarizing: stage('done', 0) },
        })
        emitJob(
          id,
          'done',
          jobs.find((x) => x.id === id)
        )
      }, 4000)
    }
  }, 700)
}

const jobListeners = new Map<
  string,
  Set<(event: string, data: unknown) => void>
>()
function emitJob(id: string, event: string, data: unknown) {
  jobListeners.get(id)?.forEach((l) => l(event, data))
}

// --- Fake EventSource ---

class MockEventSource extends EventTarget {
  readyState = 0
  url: string
  onerror: ((e: Event) => void) | null = null
  private off: (() => void) | null = null
  private scenario: Scenario

  constructor(url: string, scenario: Scenario) {
    super()
    this.url = url
    this.scenario = scenario
    setTimeout(() => this.open(), 30)
  }

  private send(event: string, data: unknown) {
    if (this.readyState === 2) return
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }))
  }

  private open() {
    if (this.readyState === 2) return
    if (this.scenario === 'offline') {
      const e = new Event('error')
      this.onerror?.(e)
      this.dispatchEvent(e)
      return
    }
    this.readyState = 1
    if (this.url === '/api/events') {
      this.send('snapshot', { jobs: jobs.map(listItem) })
      const l = (event: string, data: unknown) => this.send(event, data)
      listeners.add(l)
      this.off = () => listeners.delete(l)
      return
    }
    const id = decodeURIComponent(this.url.split('/')[3])
    const j = jobs.find((x) => x.id === id)
    if (!j) return
    this.send('snapshot', j)
    if (j.status === 'done' || j.status === 'error') return
    const l = (event: string, data: unknown) => this.send(event, data)
    const set = jobListeners.get(id) ?? new Set()
    set.add(l)
    jobListeners.set(id, set)
    this.off = () => set.delete(l)
  }

  close() {
    this.readyState = 2
    this.off?.()
  }
}

// --- Silent audio so the player works without the real file ---

function silentWav(seconds: number): string {
  const rate = 8000
  const n = Math.ceil(seconds * rate)
  const buf = new ArrayBuffer(44 + n)
  const v = new DataView(buf)
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + n, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate, true)
  v.setUint16(32, 1, true)
  v.setUint16(34, 8, true)
  str(36, 'data')
  v.setUint32(40, n, true)
  new Uint8Array(buf, 44).fill(128)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

// --- Install ---

const json = (data: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export function installMocks() {
  const param = new URLSearchParams(location.search).get('mock')
  if (param === 'off') sessionStorage.removeItem('mock')
  else if (param) sessionStorage.setItem('mock', param)
  const scenario = sessionStorage.getItem('mock') as Scenario | null
  if (!scenario) return

  jobs = scenario === 'states' ? initialJobs() : []
  if (scenario === 'states') {
    simulate('mock-running', interviewSummary as Summary, interview, 260)
  }
  const config = scenario === 'empty' ? configs.none : configs.ok
  const audio = new Map<string, string>()
  urls.audio = (id: string) => {
    if (!audio.has(id))
      audio.set(
        id,
        silentWav(jobs.find((j) => j.id === id)?.duration_sec ?? 60)
      )
    return audio.get(id)!
  }

  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname
          : input.url
    if (!url.startsWith('/api/')) return realFetch(input, init)
    if (scenario === 'offline') throw new TypeError('Failed to fetch')
    const method = init?.method ?? 'GET'
    await new Promise((r) => setTimeout(r, 120))
    if (url === '/api/config') return json(config)
    if (url === '/api/auth/me') return json(mockUser)
    if (url === '/api/auth/logout') return json(null, 204)
    const m = url.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/)
    const j = m && jobs.find((x) => x.id === decodeURIComponent(m[1]))
    if (!m || !j) return json({ detail: 'Запись не найдена' }, 404)
    const rest = m[2] ?? ''
    if (!rest && method === 'DELETE') {
      jobs = jobs.filter((x) => x.id !== j.id)
      emitAll('job_deleted', { id: j.id })
      return json(null, 204)
    }
    if (!rest) return json(j)
    if (rest === '/summary' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        provider: 'auto' | 'deepseek' | 'ollama'
        summary_type: string
        instructions?: string | null
      }
      const instructions = body.instructions?.trim() || null
      if (instructions && instructions.length > 2000)
        return json(
          {
            detail: [
              {
                loc: ['body', 'instructions'],
                msg: 'Не длиннее 2000 символов',
              },
            ],
          },
          422
        )
      const used = body.provider === 'deepseek' ? 'deepseek' : 'ollama'
      update(j.id, {
        status: 'running',
        stage: 'summarizing',
        summary_error: null,
        provider_used: used,
        options: {
          ...j.options,
          summary: true,
          provider: body.provider,
          summary_type: body.summary_type,
        },
        stages: { ...j.stages, summarizing: stage('running', 0) },
      })
      setTimeout(() => {
        const c = jobs.find((x) => x.id === j.id)
        if (!c) return
        if (instructions?.toLowerCase().includes('ошибка')) {
          update(j.id, {
            status: 'done',
            stage: null,
            summary_error:
              'DeepSeek не ответил вовремя — попробуйте ещё раз чуть позже',
            stages: { ...c.stages, summarizing: stage('error', 0) },
          })
        } else {
          const base = (
            j.transcript === interview ? interviewSummary : oneOnOneSummary
          ) as Summary
          const id = nextVersionId++
          const n = c.summary_versions.length + 1
          const summary: Summary =
            n === 1
              ? base
              : {
                  ...base,
                  tldr: instructions
                    ? `Версия ${n} с учётом пожелания «${instructions}». ${base.tldr}`
                    : `Версия ${n}. ${base.tldr}`,
                }
          versionContent.set(id, summary)
          update(j.id, {
            status: 'done',
            stage: null,
            summary,
            title: summary.title,
            summary_versions: [
              {
                id,
                created_at: new Date().toISOString(),
                provider: used,
                summary_type:
                  body.summary_type === 'auto'
                    ? base.meeting_type
                    : body.summary_type,
                instructions,
                current: true,
              },
              ...c.summary_versions.map((v) => ({ ...v, current: false })),
            ],
            stages: { ...c.stages, summarizing: stage('done', 0) },
          })
        }
        emitJob(
          j.id,
          'done',
          jobs.find((x) => x.id === j.id)
        )
      }, 5000)
      return json({ id: j.id }, 202)
    }
    const restore = rest.match(/^\/summary\/versions\/(\d+)\/restore$/)
    if (restore && method === 'POST') {
      if (j.status === 'queued' || j.status === 'running')
        return json({ detail: 'Запись сейчас обрабатывается' }, 409)
      const id = Number(restore[1])
      const version = j.summary_versions.find((v) => v.id === id)
      const summary = versionContent.get(id)
      if (!version || !summary)
        return json({ detail: 'Версия не найдена' }, 404)
      update(j.id, {
        summary,
        provider_used: version.provider === 'unknown' ? null : version.provider,
        summary_versions: j.summary_versions.map((v) => ({
          ...v,
          current: v.id === id,
        })),
      })
      return json(jobs.find((x) => x.id === j.id))
    }
    if (rest === '/download/summary.md' && j.summary) {
      return new Response(
        `# ${j.summary.title}\n\n## Кратко\n\n${j.summary.tldr}\n`,
        {
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        }
      )
    }
    return json({ detail: 'Файл не найден' }, 404)
  }

  const RealEventSource = window.EventSource
  window.EventSource = function (url: string | URL, init?: EventSourceInit) {
    const path = String(url)
    if (!path.startsWith('/api/')) return new RealEventSource(url, init)
    return new MockEventSource(path, scenario) as unknown as EventSource
  } as unknown as typeof EventSource

  console.info(
    `[mock] scenario "${scenario}" — ?mock=off to use the real server`
  )
}
