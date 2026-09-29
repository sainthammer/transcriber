import { Fragment, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { CSSProperties } from 'react'
import { admin } from '../api/client'
import type { LlmProvider, TokenCounts, Usage as UsageData } from '../api/types'
import { Segmented } from '../components/ui/Segmented'
import { useMediaQuery } from '../lib/hooks'
import { getParam, setParam, userPath } from '../lib/router'
import { Link } from '../components/ui/Link'
import { audio, compact, num } from './format'
import { LoadError, Loading, Page, Section } from './Page'
import { DailyChart } from './DailyChart'
import { useResource } from './useResource'
import { isCloud } from '../lib/providers'
import ui from './admin.module.css'
import styles from './Usage.module.css'

const PERIODS = ['7', '30', '90'] as const
type Period = (typeof PERIODS)[number]

const tokens = (t: TokenCounts) => t.prompt_tokens + t.completion_tokens
const sum = <T,>(items: T[], f: (x: T) => number) => items.reduce((n, x) => n + f(x), 0)

const rangeFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })

export function Usage() {
  const [period, setPeriod] = useState<Period>(() => {
    const p = getParam('days')
    return PERIODS.includes(p as Period) ? (p as Period) : '30'
  })
  const { data, error, reload } = useResource(`usage-${period}`, () => admin.usage(Number(period)))
  // Keep the last numbers on screen while the next period loads: no jump to empty.
  const [shown, setShown] = useState<UsageData | null>(null)
  if (data && data !== shown) setShown(data)
  const loading = !data && !!shown

  const change = (p: Period) => {
    setPeriod(p)
    setParam('days', p === '30' ? null : p)
  }

  const subtitle = shown
    ? `${rangeFormat.format(new Date(shown.from))} — ${rangeFormat.format(new Date(shown.to))}`
    : undefined

  return (
    <Page
      title="Расход"
      subtitle={subtitle}
      actions={
        <Segmented<Period>
          legend="Период"
          hideLegend
          className={styles.period}
          value={period}
          onChange={change}
          options={PERIODS.map((p) => ({ value: p, label: `${p} дней` }))}
        />
      }
    >
      {error && !data ? (
        <LoadError error={error} onRetry={reload} />
      ) : !shown ? (
        <Loading />
      ) : (
        <div className={styles.body} data-loading={loading || undefined} aria-busy={loading}>
          <Report data={shown} days={Number(period)} />
        </div>
      )}
    </Page>
  )
}

function Report({ data, days }: { data: UsageData; days: number }) {
  const table = useMediaQuery('(min-width: 768px)')
  const paid = data.by_model.filter((m) => isCloud(m.provider))
  const free = data.by_model.filter((m) => m.provider === 'ollama')
  // YandexGPT is optional: its colour, column and legend appear only once it has been used.
  const yandex = data.by_model.some((m) => m.provider === 'yandex')
  const empty = data.totals.requests === 0 && data.totals.audio_sec === 0

  return (
    <>
      <dl className={`${ui.stats} ${styles.kpis}`}>
        <div className={ui.stat}>
          <dt className={ui.statLabel}>
            <Swatch provider="deepseek" />
            {yandex && <Swatch provider="yandex" />}
            {yandex ? 'Облако, платно' : 'DeepSeek, платно'}
          </dt>
          <dd className={ui.statValue}>{compact(sum(paid, tokens))}</dd>
          <dd className={styles.kpiNote}>
            {compact(sum(paid, (m) => m.prompt_tokens))} на входе ·{' '}
            {compact(sum(paid, (m) => m.completion_tokens))} на выходе
          </dd>
        </div>
        <div className={ui.stat}>
          <dt className={ui.statLabel}>
            <Swatch provider="ollama" />
            Локально, бесплатно
          </dt>
          <dd className={ui.statValue}>{compact(sum(free, tokens))}</dd>
          <dd className={styles.kpiNote}>токенов на своём сервере</dd>
        </div>
        <div className={ui.stat}>
          <dt className={ui.statLabel}>Запросов к моделям</dt>
          <dd className={ui.statValue}>{num(data.totals.requests)}</dd>
          <dd className={styles.kpiNote}>один итог — один запрос</dd>
        </div>
        <div className={ui.stat}>
          <dt className={ui.statLabel}>Распознано аудио</dt>
          <dd className={ui.statValue}>{audio(data.totals.audio_sec)}</dd>
          <dd className={styles.kpiNote}>локально, бесплатно</dd>
        </div>
      </dl>

      {empty ? (
        <p className={`${ui.empty} ${styles.emptyPeriod}`}>За этот период записей не обрабатывали.</p>
      ) : (
        <>
          <Section
            title="Токены по дням"
            actions={
              <p className={styles.legend}>
                <span>
                  <Swatch provider="deepseek" />
                  DeepSeek
                </span>
                {yandex && (
                  <span>
                    <Swatch provider="yandex" />
                    YandexGPT
                  </span>
                )}
                <span>
                  <Swatch provider="ollama" />
                  Локально
                </span>
              </p>
            }
          >
            <DailyChart to={data.to} days={days} daily={data.daily} yandex={yandex} />
          </Section>

          <Section title="По пользователям">
            <ByUser data={data} table={table} yandex={yandex} />
          </Section>

          <Section title="По моделям">
            <ByModel data={data} table={table} />
          </Section>

          {data.by_model.length > 1 && data.by_user.length > 1 && (
            <Section title="Кто какими моделями пользуется" description="Токены на входе и выходе вместе.">
              <Matrix data={data} />
            </Section>
          )}
        </>
      )}
    </>
  )
}

export function Swatch({ provider }: { provider: LlmProvider }) {
  return <span className={styles.swatch} data-provider={provider} aria-hidden />
}

// --- By user ---

function perUser(data: UsageData) {
  return data.by_user
    .map((u) => {
      const rows = data.by_user_model.filter((r) => r.user_id === u.user_id)
      const by = (p: LlmProvider) => sum(rows.filter((r) => r.provider === p), tokens)
      const deepseek = by('deepseek')
      const yandex = by('yandex')
      return { ...u, deepseek, yandex, paid: deepseek + yandex, free: by('ollama') }
    })
    .sort((a, b) => b.paid - a.paid || b.free - a.free || b.audio_sec - a.audio_sec)
}

type UserRow = ReturnType<typeof perUser>[number]

function ShareBar({ row, max }: { row: UserRow; max: number }) {
  if (!max) return null
  const width = (n: number) => ({ width: `${(100 * n) / max}%` })
  return (
    <span className={styles.share} aria-hidden>
      <span data-provider="deepseek" style={width(row.deepseek)} />
      {row.yandex > 0 && <span data-provider="yandex" style={width(row.yandex)} />}
      <span data-provider="ollama" style={width(row.free)} />
    </span>
  )
}

function ByUser({ data, table, yandex }: { data: UsageData; table: boolean; yandex: boolean }) {
  const rows = useMemo(() => perUser(data), [data])
  const max = Math.max(0, ...rows.map((r) => r.paid + r.free))
  if (rows.length === 0) return <p className={ui.empty}>Никто ничего не загружал</p>

  if (!table) {
    return (
      <ul className={ui.group}>
        {rows.map((r) => (
          <li key={r.user_id}>
            <Link href={userPath(r.user_id)} className={ui.linkRow}>
              <span className={ui.linkText}>
                <span className={ui.linkTitle}>
                  <span>{r.name || r.email}</span>
                </span>
                <ShareBar row={r} max={max} />
                <span className={`${ui.linkMeta} ${styles.meta} tabular`}>
                  {/* Only what the user actually spent: three zeros in a row read as noise. */}
                  {(
                    [
                      ['DeepSeek', r.deepseek],
                      ['YandexGPT', r.yandex],
                      ['локально', r.free],
                    ] as const
                  )
                    .filter(([, n]) => n > 0)
                    .map(([label, n]) => (
                      <Fragment key={label}>
                        {/* The dot stays with its item, so a wrapped line never starts with it. */}
                        <span>
                          {label} {compact(n)} ·
                        </span>{' '}
                      </Fragment>
                    ))}
                  <span>{audio(r.audio_sec)}</span>
                </span>
              </span>
              <ChevronRight size={18} strokeWidth={2} className={ui.chevron} aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th scope="col">Пользователь</th>
            <th scope="col" className={ui.num}>
              Запросы
            </th>
            <th scope="col" className={ui.num}>
              DeepSeek
            </th>
            {yandex && (
              <th scope="col" className={ui.num}>
                YandexGPT
              </th>
            )}
            <th scope="col" className={ui.num}>
              Локально
            </th>
            <th scope="col" className={ui.num}>
              Аудио
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.user_id} data-link="">
              <td className={styles.userCell}>
                <Link href={userPath(r.user_id)} className={ui.rowLink}>
                  {r.name || r.email}
                </Link>
                <ShareBar row={r} max={max} />
              </td>
              <td className={ui.num}>{num(r.requests)}</td>
              <td className={`${ui.num} ${styles.paid}`}>{r.deepseek ? compact(r.deepseek) : '—'}</td>
              {yandex && <td className={`${ui.num} ${styles.paid}`}>{r.yandex ? compact(r.yandex) : '—'}</td>}
              <td className={`${ui.num} ${ui.muted}`}>{r.free ? compact(r.free) : '—'}</td>
              <td className={`${ui.num} ${ui.muted}`}>{audio(r.audio_sec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- By model ---

function ByModel({ data, table }: { data: UsageData; table: boolean }) {
  const rows = [...data.by_model].sort(
    (a, b) => Number(isCloud(b.provider)) - Number(isCloud(a.provider)) || tokens(b) - tokens(a),
  )
  if (rows.length === 0) return <p className={ui.empty}>К моделям не обращались</p>

  if (!table) {
    return (
      <ul className={ui.group}>
        {rows.map((m) => (
          <li key={`${m.provider}/${m.model}`} className={styles.modelRow}>
            <span className={ui.linkText}>
              <span className={`${ui.linkTitle} ${styles.modelTitle}`}>
                <code className={styles.model}>{m.model}</code>
                <ProviderBadge provider={m.provider} />
              </span>
              <span className={`${ui.linkMeta} ${styles.meta} tabular`}>
                <span>{num(m.requests)} запр.</span> · <span>{compact(m.prompt_tokens)} на входе</span> ·{' '}
                <span>{compact(m.completion_tokens)} на выходе</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th scope="col">Модель</th>
            <th scope="col" className={ui.num}>
              Запросы
            </th>
            <th scope="col" className={ui.num}>
              На входе
            </th>
            <th scope="col" className={ui.num}>
              На выходе
            </th>
            <th scope="col" className={ui.num}>
              Всего
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={`${m.provider}/${m.model}`}>
              <td>
                <span className={styles.modelCell}>
                  <code className={styles.model}>{m.model}</code>
                  <ProviderBadge provider={m.provider} />
                </span>
              </td>
              <td className={ui.num}>{num(m.requests)}</td>
              <td className={`${ui.num} ${ui.muted}`}>{num(m.prompt_tokens)}</td>
              <td className={`${ui.num} ${ui.muted}`}>{num(m.completion_tokens)}</td>
              <td className={`${ui.num} ${isCloud(m.provider) ? styles.paid : ''}`}>{num(tokens(m))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ProviderBadge({ provider }: { provider: LlmProvider }) {
  return isCloud(provider) ? (
    <span className={ui.badge} data-tone="accent">
      {provider === 'yandex' ? 'YandexGPT' : 'DeepSeek'} · платно
    </span>
  ) : (
    <span className={ui.badge}>Ollama · бесплатно</span>
  )
}

// --- User × model ---

function Matrix({ data }: { data: UsageData }) {
  const users = useMemo(() => perUser(data), [data])
  const models = [...data.by_model].sort(
    (a, b) => Number(isCloud(b.provider)) - Number(isCloud(a.provider)) || tokens(b) - tokens(a),
  )
  const cell = (userId: number, provider: string, model: string) => {
    const r = data.by_user_model.find((x) => x.user_id === userId && x.provider === provider && x.model === model)
    return r ? tokens(r) : 0
  }
  const max = Math.max(1, ...data.by_user_model.map(tokens))

  return (
    <div className={ui.tableWrap}>
      <table className={`${ui.table} ${styles.matrix}`}>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Пользователь</span>
            </th>
            {models.map((m) => (
              <th key={`${m.provider}/${m.model}`} scope="col" className={ui.num}>
                <span className={styles.matrixHead}>
                  <Swatch provider={m.provider} />
                  <code>{m.model}</code>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.user_id}>
              <th scope="row" className={styles.matrixUser}>
                {u.name || u.email}
              </th>
              {models.map((m) => {
                const value = cell(u.user_id, m.provider, m.model)
                return (
                  <td
                    key={`${m.provider}/${m.model}`}
                    className={ui.num}
                    data-provider={m.provider}
                    data-zero={value === 0 || undefined}
                    style={{ '--level': value / max } as CSSProperties}
                  >
                    <span>{value ? compact(value) : '—'}</span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
