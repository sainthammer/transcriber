const pad = (n: number) => String(n).padStart(2, '0')

/** 4:05, 12:30 or 1:02:03. `long` forces hours so a column of timestamps lines up. */
export function clock(seconds: number, long = false): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 || long ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** "ЧЧ:ММ:СС" from the summary contract → seconds. */
export function parseStamp(stamp: string): number {
  const [h, m, s] = stamp.split(':').map(Number)
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0)
}

export function plural(n: number, forms: [string, string, string]): string {
  const n10 = n % 10
  const n100 = n % 100
  if (n10 === 1 && n100 !== 11) return forms[0]
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1]
  return forms[2]
}

/** Human duration: "35 с", "5 мин", "1 ч 12 мин". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return ''
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} с`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} мин`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} ч ${m} мин` : `${h} ч`
}

export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toLocaleString('ru-RU', { maximumFractionDigits: mb < 10 ? 1 : 0 })} МБ`
  return `${(mb / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`
}

const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const dayYearFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Group label for the recordings list. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days === 0) return 'Сегодня'
  if (days === 1) return 'Вчера'
  return d.getFullYear() === now.getFullYear() ? dayFormat.format(d) : dayYearFormat.format(d)
}

export function timeOfDay(iso: string): string {
  return timeFormat.format(new Date(iso))
}

/** "25 сентября, 20:20" or "Сегодня, 20:20". */
export function dateTime(iso: string): string {
  return `${dayLabel(iso)}, ${timeOfDay(iso)}`
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** Summary title when there is one, otherwise the file name without extension. */
export function jobTitle(job: { title: string | null; filename: string }): string {
  return job.title || stripExtension(job.filename)
}
