// Mirrors transcriber/web.py and transcriber/summary_types. Keep in sync with the backend.

export type Provider = 'auto' | 'deepseek' | 'ollama'
export type LlmProvider = Exclude<Provider, 'auto'>
export type BuiltinTypeId = 'client' | 'meeting' | 'interview' | 'one_on_one' | 'highlights' | 'freeform'
export const BUILTIN_TYPES: readonly BuiltinTypeId[] = [
  'client',
  'meeting',
  'interview',
  'one_on_one',
  'highlights',
  'freeform',
]
/** A built-in id or the id of a type created in the admin interface. */
export type SummaryTypeId = string
/** 'auto' or a type id. */
export type SummaryTypeChoice = string
export type JobStatus = 'queued' | 'running' | 'done' | 'error'
export type StageName = 'transcribing' | 'summarizing'
export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

export interface ProviderInfo {
  available: boolean
  reason: 'no_api_key' | 'not_running' | 'model_missing' | null
  model: string
}

export interface SectionRef {
  key: string
  title: string
}

export interface SummaryTypeInfo {
  id: SummaryTypeId
  label: string
  description: string
  builtin: boolean
  /** Only for custom types: the order and titles of `details` sections. */
  sections: SectionRef[] | null
}

export interface Config {
  providers: { deepseek: ProviderInfo; ollama: ProviderInfo }
  summary_types: SummaryTypeInfo[]
  defaults: {
    provider: Provider
    summary: boolean
    summary_type: SummaryTypeChoice
  }
  max_upload_bytes: number
}

export interface JobListItem {
  id: string
  filename: string
  created_at: string
  duration_sec: number | null
  status: JobStatus
  stage: StageName | null
  progress_pct: number
  queue_position: number | null
  title: string | null
}

export interface Phrase {
  start_sec: number
  text: string
}

export interface StageInfo {
  status: StageStatus
  started_at: string | null
  finished_at: string | null
}

export interface JobOptions {
  provider: Provider
  summary: boolean
  summary_type?: SummaryTypeChoice
}

export interface JobDetail extends JobListItem {
  options: JobOptions
  stages: Record<StageName, StageInfo>
  progress: { processed_sec: number; total_sec: number | null; phrases: number }
  error: string | null
  summary_error: string | null
  provider_used: LlmProvider | null
  audio_ready: boolean
  transcript: Phrase[]
  /** The current version; kept while a new one is being made and after a failed attempt. */
  summary: Summary | null
  /** Earlier and current summaries, newest first, without their content. */
  summary_versions: SummaryVersion[]
}

export interface SummaryVersion {
  id: number
  created_at: string
  /** 'unknown' for versions backfilled from recordings imported without provider_used. */
  provider: LlmProvider | 'unknown'
  summary_type: SummaryTypeId
  /** What the user asked to change for this version. */
  instructions: string | null
  current: boolean
}

/** Server limit for `instructions` in a summary request (longer is a 422). */
export const INSTRUCTIONS_MAX = 2000

// --- Summary ---

export interface Participant {
  name: string | null
  role: string
  side?: string
}

export interface Figure {
  value: string
  context: string
}

export interface Topic {
  timestamp: string
  title: string
  points: string[]
}

export interface Decision {
  timestamp: string
  text: string
}

export interface ActionItem {
  timestamp: string
  task: string
  owner: string | null
  due: string | null
}

export interface ClientDetails {
  needs: string[]
  pains: string[]
  objections: string[]
  budget_and_timeline: string[]
  decision_process: string[]
  deal_risks: string[]
}

export interface MeetingDetails {
  status_updates: string[]
  blockers: string[]
  risks: string[]
}

export type CompetencyAssessment =
  | 'сильная сторона'
  | 'достаточно'
  | 'есть сомнения'
  | 'не проверялось'

export interface Competency {
  name: string
  assessment: CompetencyAssessment
  evidence: string[]
  timestamp: string
}

export interface InterviewDetails {
  position: string | null
  experience: string[]
  competencies: Competency[]
  strengths: string[]
  concerns: string[]
  motivation: string[]
  expectations: string[]
  candidate_questions: string[]
  assessment: {
    verdict: 'рекомендовать' | 'скорее да' | 'скорее нет' | 'не рекомендовать' | 'недостаточно данных'
    rationale: string
  }
}

export interface OneOnOneDetails {
  wins: string[]
  challenges: string[]
  workload: string[]
  feedback_to_employee: string[]
  feedback_to_manager: string[]
  growth: string[]
  next_time: string[]
}

export interface HighlightsDetails {
  theses: string[]
}

/** Sections the model chose itself; empty ones are dropped on the backend. */
export interface FreeformSection {
  title: string
  paragraphs: string[]
  points: string[]
}

export interface FreeformDetails {
  sections: FreeformSection[]
}

interface SummaryCommon {
  title: string
  tldr: string
  participants: Participant[]
  key_figures: Figure[]
  topics: Topic[]
  decisions: Decision[]
  action_items: ActionItem[]
  open_questions: string[]
}

export type BuiltinSummary =
  | (SummaryCommon & { meeting_type: 'client'; details: ClientDetails })
  | (SummaryCommon & { meeting_type: 'meeting'; details: MeetingDetails })
  | (SummaryCommon & { meeting_type: 'interview'; details: InterviewDetails })
  | (SummaryCommon & { meeting_type: 'one_on_one'; details: OneOnOneDetails })
  | (SummaryCommon & { meeting_type: 'highlights'; details: HighlightsDetails })
  | (SummaryCommon & { meeting_type: 'freeform'; details: FreeformDetails })

/** A type created by an admin: `details` maps section keys to bullet points. */
export type CustomSummary = SummaryCommon & {
  meeting_type: string
  details: Record<string, string[]>
}

export type Summary = BuiltinSummary | CustomSummary

export const isBuiltinSummary = (s: Summary): s is BuiltinSummary =>
  (BUILTIN_TYPES as readonly string[]).includes(s.meeting_type)

// --- Accounts ---

export type Role = 'admin' | 'user'

export interface User {
  id: number
  email: string
  name: string
  role: Role
}

// --- Admin ---

export type SettingKey =
  | 'deepseek_api_key'
  | 'deepseek_model'
  | 'ollama_host'
  | 'ollama_model'
  | 'ollama_max_context'
  | 'whisper_language'

export type SettingSource = 'db' | 'env' | 'default'

export interface SettingItem {
  key: SettingKey
  label: string
  group: 'deepseek' | 'ollama' | 'whisper'
  /** For a secret: a mask like "sk-…a1b2", or null when not set. */
  value: string | number | null
  secret: boolean
  source: SettingSource
  default: string | number | null
  help: string | null
}

export interface OllamaModel {
  name: string
  size_bytes: number
}

export interface AdminSettings {
  items: SettingItem[]
  /** null — Ollama is unreachable, see ollama_error. */
  ollama_models: OllamaModel[] | null
  ollama_error: string | null
}

export type SettingsPatch = Partial<Record<SettingKey, string | number | null>>

export interface ProviderTest {
  ok: boolean
  message: string
}

export interface SectionDef {
  key: string
  title: string
  description: string
}

export interface AdminSummaryType {
  id: string
  label: string
  description: string
  builtin: boolean
  enabled: boolean
  prompt: string
  /** Only built-in types. */
  default_prompt: string | null
  prompt_modified: boolean
  /** Only custom types. */
  sections: SectionDef[] | null
  jobs_count: number
  updated_at: string | null
}

export interface NewSummaryType {
  id: string
  label: string
  description: string
  prompt: string
  sections: SectionDef[]
}

export type SummaryTypePatch = Partial<{
  label: string
  description: string
  /** null resets a built-in prompt to the default. */
  prompt: string | null
  sections: SectionDef[]
  enabled: boolean
}>

export interface BasePrompt {
  prompt: string
  default_prompt: string
  modified: boolean
}

export interface AdminUser extends User {
  is_active: boolean
  created_at: string
  last_login_at: string | null
  jobs_count: number
  audio_sec: number
  tokens_total: number
}

export interface NewUser {
  email: string
  name: string
  password: string
  role: Role
}

export type UserPatch = Partial<{
  name: string
  role: Role
  is_active: boolean
  password: string
}>

export interface AdminJob {
  id: string
  filename: string
  created_at: string
  duration_sec: number | null
  status: JobStatus
  summary_type: string | null
  provider_used: LlmProvider | null
}

export interface TokenCounts {
  prompt_tokens: number
  completion_tokens: number
}

export interface Usage {
  from: string
  to: string
  totals: TokenCounts & { requests: number; audio_sec: number }
  by_user: (TokenCounts & {
    user_id: number
    email: string
    name: string
    requests: number
    audio_sec: number
  })[]
  by_model: (TokenCounts & { provider: LlmProvider; model: string; requests: number })[]
  by_user_model: (TokenCounts & {
    user_id: number
    provider: LlmProvider
    model: string
    requests: number
  })[]
  daily: (TokenCounts & { date: string; provider: LlmProvider })[]
}
