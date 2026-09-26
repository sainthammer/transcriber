import { dateTime } from '../lib/format'

const full = new Intl.NumberFormat('ru-RU')
const short = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 })

/** 1 234 567 */
export const num = (n: number) => full.format(n)

/** 9 800, 12,4 тыс., 1,2 млн — exact below ten thousand. */
export const compact = (n: number) => (Math.abs(n) < 10_000 ? full.format(n) : short.format(n))

/** Minutes of audio: «42 мин», «12 ч 5 мин», «—» for none. */
export function audio(seconds: number): string {
  if (seconds <= 0) return '—'
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} мин`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} ч ${m} мин` : `${h} ч`
}

export const lastSeen = (iso: string | null) => (iso ? dateTime(iso) : 'Не входил')

const dateOnly = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
export const date = (iso: string) => dateOnly.format(new Date(iso))

export const providerName = (p: string | null) =>
  p === 'deepseek' ? 'DeepSeek' : p === 'ollama' ? 'Локально' : '—'

export const ROLE_LABEL = { admin: 'Администратор', user: 'Пользователь' } as const

export const ADMIN_HINT =
  'Администратор управляет пользователями, моделями и типами встреч. Чужие расшифровки и итоги он не видит.'
