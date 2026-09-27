import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Usage } from '../api/types'
import { useMediaQuery } from '../lib/hooks'
import { compact, num } from './format'
import styles from './DailyChart.module.css'

interface Day {
  date: string
  deepseek: number
  yandex: number
  free: number
}

const empty = (date: string): Day => ({ date, deepseek: 0, yandex: 0, free: 0 })
const total = (d: Day) => d.deepseek + d.yandex + d.free

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
const longDate = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
const parse = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * Every day of the period, including the quiet ones. Anchored on `to` (not `from`):
 * `from`/`to` from the server are a rolling `days`-long duration ending "now", so its
 * calendar-date span can be `days + 1` days wide (an edge day only partially in range).
 * Building the grid backwards from `to` guarantees today's column always shows, even
 * when the timestamp math leaves `from` a day earlier than `to - (days - 1)`.
 */
function fill(to: string, days: number, daily: Usage['daily']): Day[] {
  const byDate = new Map<string, Day>()
  for (const row of daily) {
    const day = byDate.get(row.date) ?? empty(row.date)
    const n = row.prompt_tokens + row.completion_tokens
    if (row.provider === 'deepseek') day.deepseek += n
    else if (row.provider === 'yandex') day.yandex += n
    else day.free += n
    byDate.set(row.date, day)
  }
  const end = parse(to.slice(0, 10))
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(end)
    d.setDate(end.getDate() - (days - 1 - i))
    const key = iso(d)
    return byDate.get(key) ?? empty(key)
  })
}

/** 1, 2, 5 × 10ⁿ at or above the value — round numbers for the axis. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power
  return 10 * power
}

interface Props {
  to: string
  days: number
  daily: Usage['daily']
  /** Show YandexGPT in the tooltip: only when the period has any. */
  yandex: boolean
}

/**
 * Stacked columns in CSS: paid cloud tokens at the base (DeepSeek in the accent color,
 * YandexGPT in its lighter shade), free local tokens above in grey. Hover or arrow keys
 * show one day's numbers.
 */
export function DailyChart({ to, days, daily, yandex }: Props) {
  const data = useMemo(() => fill(to, days, daily), [to, days, daily])
  const max = niceMax(Math.max(...data.map(total)))
  const [active, setActive] = useState<number | null>(null)
  // Fewer date labels on phones so neighbours don't run into each other.
  const narrow = useMediaQuery('(max-width: 599px)')
  const step = Math.ceil(data.length / (narrow ? 4 : 6))
  const day = active === null ? null : data[active]

  const onKey = (e: KeyboardEvent) => {
    const last = data.length - 1
    const next =
      e.key === 'ArrowRight'
        ? Math.min(last, (active ?? -1) + 1)
        : e.key === 'ArrowLeft'
          ? Math.max(0, (active ?? last + 1) - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (next === null) return
    e.preventDefault()
    setActive(next)
  }

  const pct = (n: number) => `${(100 * n) / max}%`

  return (
    <div className={styles.chart}>
      <div className={styles.axis} aria-hidden>
        <span style={{ bottom: '100%' }}>{compact(max)}</span>
        <span style={{ bottom: '50%' }}>{compact(max / 2)}</span>
        <span style={{ bottom: 0 }}>0</span>
      </div>
      <div
        className={styles.plot}
        style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}
        data-dense={data.length > 40 || undefined}
        tabIndex={0}
        role="group"
        aria-label="Токены по дням. Стрелки влево и вправо — перейти к дню."
        onKeyDown={onKey}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        {data.map((d, i) => (
          <div
            key={d.date}
            className={styles.column}
            data-active={i === active || undefined}
            onPointerEnter={() => setActive(i)}
          >
            <div className={styles.stack}>
              {d.deepseek > 0 && <span data-provider="deepseek" style={{ height: pct(d.deepseek) }} />}
              {d.yandex > 0 && <span data-provider="yandex" style={{ height: pct(d.yandex) }} />}
              {d.free > 0 && <span data-provider="ollama" style={{ height: pct(d.free) }} />}
            </div>
            {i % step === 0 && (
              <span className={styles.tick} aria-hidden>
                {shortDate.format(parse(d.date)).replace('.', '')}
              </span>
            )}
          </div>
        ))}
        {day && active !== null && (
          <div
            className={styles.tooltip}
            style={{ left: `${((active + 0.5) * 100) / data.length}%` }}
            data-edge={active < data.length * 0.2 ? 'start' : active > data.length * 0.8 ? 'end' : undefined}
            aria-hidden
          >
            <strong>{longDate.format(parse(day.date))}</strong>
            <span>
              <i data-provider="deepseek" />
              DeepSeek <b className="tabular">{num(day.deepseek)}</b>
            </span>
            {yandex && (
              <span>
                <i data-provider="yandex" />
                YandexGPT <b className="tabular">{num(day.yandex)}</b>
              </span>
            )}
            <span>
              <i data-provider="ollama" />
              Локально <b className="tabular">{num(day.free)}</b>
            </span>
          </div>
        )}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {day
          ? `${longDate.format(parse(day.date))}: DeepSeek ${num(day.deepseek)}${yandex ? `, YandexGPT ${num(day.yandex)}` : ''}, локально ${num(day.free)} токенов`
          : ''}
      </p>
    </div>
  )
}
