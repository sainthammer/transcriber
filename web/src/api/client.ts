import type {
  AdminJob,
  AdminSettings,
  AdminSummaryType,
  AdminUser,
  BasePrompt,
  Config,
  JobDetail,
  LlmProvider,
  NewSummaryType,
  NewUser,
  Provider,
  ProviderTest,
  SettingsPatch,
  SummaryTypeChoice,
  SummaryTypePatch,
  Usage,
  User,
  UserPatch,
} from './types'

export class ApiError extends Error {
  status: number
  /** Per-field messages from a 422 validation error, keyed by the last `loc` part. */
  fields: Record<string, string>
  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.fields = fields
  }
}

// --- Session expiry: any 401 outside the login form returns the user to the sign-in screen. ---

const unauthorizedListeners = new Set<() => void>()

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

function reportUnauthorized(path: string) {
  if (path === '/api/auth/login') return
  unauthorizedListeners.forEach((l) => l())
}

interface ValidationIssue {
  loc?: (string | number)[]
  msg?: string
}

/** `{"detail": "текст"}`, or FastAPI's `{"detail": [{loc, msg}]}` for 422. */
function parseDetail(status: number, body: unknown): ApiError {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return new ApiError(status, detail)
  if (Array.isArray(detail)) {
    const fields: Record<string, string> = {}
    for (const issue of detail as ValidationIssue[]) {
      const key = issue.loc?.[issue.loc.length - 1]
      if (key !== undefined && issue.msg && !(String(key) in fields)) fields[String(key)] = issue.msg
    }
    const first = (detail as ValidationIssue[])[0]?.msg
    return new ApiError(status, first ?? 'Проверьте введённые данные', fields)
  }
  return new ApiError(status, `Сервер ответил ошибкой ${status}`)
}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    return parseDetail(res.status, await res.json())
  } catch {
    return new ApiError(res.status, `Сервер ответил ошибкой ${res.status}`)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError(0, 'Нет связи с сервером')
  }
  if (res.status === 401) reportUnauthorized(path)
  if (!res.ok) throw await errorFrom(res)
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const enc = encodeURIComponent

export const api = {
  config: () => request<Config>('/api/config'),
  job: (id: string) => request<JobDetail>(`/api/jobs/${enc(id)}`),
  deleteJob: (id: string) => send<void>('DELETE', `/api/jobs/${enc(id)}`),
  /** First summary, a retry or a new version of a ready one; `instructions` — what to change. */
  requestSummary: (
    id: string,
    provider: Provider,
    summaryType: SummaryTypeChoice,
    instructions: string | null = null,
  ) =>
    send<{ id: string }>('POST', `/api/jobs/${enc(id)}/summary`, {
      provider,
      summary_type: summaryType,
      instructions,
    }),
  /** Makes an earlier version current again; 409 while the job is being processed. */
  restoreSummaryVersion: (id: string, versionId: number) =>
    send<JobDetail>('POST', `/api/jobs/${enc(id)}/summary/versions/${versionId}/restore`),

  // Session
  me: () => request<User>('/api/auth/me'),
  login: (email: string, password: string) =>
    send<User>('POST', '/api/auth/login', { email, password }),
  logout: () => send<void>('POST', '/api/auth/logout'),
  changePassword: (current_password: string, new_password: string) =>
    send<void>('POST', '/api/auth/password', { current_password, new_password }),
}

export const admin = {
  settings: () => request<AdminSettings>('/api/admin/settings'),
  saveSettings: (patch: SettingsPatch) => send<AdminSettings>('PUT', '/api/admin/settings', patch),
  testProvider: (provider: LlmProvider) =>
    send<ProviderTest>('POST', '/api/admin/settings/test', { provider }),

  types: () => request<AdminSummaryType[]>('/api/admin/summary-types'),
  createType: (type: NewSummaryType) =>
    send<AdminSummaryType>('POST', '/api/admin/summary-types', type),
  updateType: (id: string, patch: SummaryTypePatch) =>
    send<AdminSummaryType>('PUT', `/api/admin/summary-types/${enc(id)}`, patch),
  deleteType: (id: string) => send<void>('DELETE', `/api/admin/summary-types/${enc(id)}`),
  basePrompt: () => request<BasePrompt>('/api/admin/base-prompt'),
  saveBasePrompt: (prompt: string | null) =>
    send<BasePrompt>('PUT', '/api/admin/base-prompt', { prompt }),

  users: () => request<AdminUser[]>('/api/admin/users'),
  createUser: (user: NewUser) => send<AdminUser>('POST', '/api/admin/users', user),
  updateUser: (id: number, patch: UserPatch) =>
    send<AdminUser>('PATCH', `/api/admin/users/${id}`, patch),
  userJobs: (id: number) => request<AdminJob[]>(`/api/admin/users/${id}/jobs`),

  usage: (days: number) => request<Usage>(`/api/admin/usage?days=${days}`),
}

export const urls = {
  audio: (id: string) => `/api/jobs/${encodeURIComponent(id)}/audio`,
  download: (
    id: string,
    name: 'transcript.txt' | 'summary.md' | 'summary.json' | 'summary.docx' | 'digest.docx',
  ) => `/api/jobs/${encodeURIComponent(id)}/download/${name}`,
  jobEvents: (id: string) => `/api/jobs/${encodeURIComponent(id)}/events`,
  allEvents: '/api/events',
}

export interface UploadOptions {
  provider: Provider
  summary: boolean
  summaryType: SummaryTypeChoice
}

export interface Upload {
  promise: Promise<{ id: string }>
  abort: () => void
}

/** XHR rather than fetch: fetch has no upload progress events. */
export function uploadJob(
  file: File,
  options: UploadOptions,
  onProgress: (fraction: number) => void,
): Upload {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<{ id: string }>((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    form.append('provider', options.provider)
    form.append('summary', String(options.summary))
    form.append('summary_type', options.summaryType)

    xhr.open('POST', '/api/jobs')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response)
      } else {
        if (xhr.status === 401) reportUnauthorized('/api/jobs')
        reject(parseDetail(xhr.status, xhr.response))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, 'Нет связи с сервером'))
    xhr.onabort = () => reject(new ApiError(-1, 'Загрузка отменена'))
    xhr.send(form)
  })
  return { promise, abort: () => xhr.abort() }
}
