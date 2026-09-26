import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import type {
  ActionItem,
  ClientDetails,
  Competency,
  CompetencyAssessment,
  Decision,
  Figure,
  HighlightsDetails,
  InterviewDetails,
  MeetingDetails,
  OneOnOneDetails,
  Participant,
  SectionRef,
  Summary as SummaryData,
  Topic,
} from '../api/types'
import { isBuiltinSummary } from '../api/types'
import { capitalize } from '../lib/format'
import { useJobContext } from './context'
import { TimeButton } from './TimeButton'
import styles from './Summary.module.css'

// --- Section model: one list drives both the table of contents and the body. ---

interface SectionDef {
  id: string
  title: string
  count: number
  /** Shown on one line when there's nothing to say. */
  emptyText: string
  body: () => ReactNode
  /** The title is a raw JSON key (a section the type definition no longer has). */
  raw?: boolean
}

const list = (id: string, title: string, items: string[], emptyText = 'не зафиксировано'): SectionDef => ({
  id,
  title,
  count: items.length,
  emptyText,
  body: () => <Bullets items={items} />,
})

function commonSections(s: SummaryData) {
  return {
    decisions: {
      id: 'decisions',
      title: 'Решения',
      count: s.decisions.length,
      emptyText: 'не зафиксированы',
      body: () => <Decisions items={s.decisions} />,
    },
    tasks: {
      id: 'tasks',
      title: 'Задачи',
      count: s.action_items.length,
      emptyText: 'не зафиксированы',
      body: () => <Tasks items={s.action_items} />,
    },
    figures: {
      id: 'figures',
      title: 'Ключевые цифры',
      count: s.key_figures.length,
      emptyText: 'не прозвучали',
      body: () => <Figures items={s.key_figures} />,
    },
    questions: list('questions', 'Открытые вопросы', s.open_questions, 'не осталось'),
    participants: {
      id: 'participants',
      title: 'Участники',
      count: s.participants.length,
      emptyText: 'не определены',
      body: () => <Participants items={s.participants} />,
    },
    topics: {
      id: 'topics',
      title: 'Ход обсуждения',
      count: s.topics.length,
      emptyText: 'не выделен',
      body: () => <Topics items={s.topics} />,
    },
  } satisfies Record<string, SectionDef>
}

const CLIENT_PARTS: [keyof ClientDetails, string][] = [
  ['needs', 'Потребности'],
  ['pains', 'Текущие проблемы'],
  ['objections', 'Возражения и опасения'],
  ['budget_and_timeline', 'Бюджет и сроки'],
  ['decision_process', 'Процесс принятия решения'],
  ['deal_risks', 'Риски сделки'],
]

const ONE_ON_ONE_PARTS: [keyof OneOnOneDetails, string, string][] = [
  ['wins', 'Успехи', 'wins'],
  ['challenges', 'Сложности', 'challenges'],
  ['workload', 'Нагрузка и самочувствие', 'workload'],
  ['feedback_to_employee', 'Обратная связь сотруднику', 'feedback-employee'],
  ['feedback_to_manager', 'Обратная связь руководителю', 'feedback-manager'],
  ['growth', 'Развитие', 'growth'],
  ['next_time', 'На следующую встречу', 'next-time'],
]

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/**
 * A custom type: `details` sections in the order of the type definition, then keys the
 * definition no longer has (the type was edited after this summary was made) under their key.
 */
function customSections(details: Record<string, unknown>, defs: SectionRef[] | null): SectionDef[] {
  const known = new Set((defs ?? []).map((d) => d.key))
  return [
    ...(defs ?? []).map((d) => list(`d-${d.key}`, d.title, strings(details[d.key]), 'не обсуждали')),
    ...Object.keys(details)
      .filter((key) => !known.has(key))
      .map((key) => ({ ...list(`d-${key}`, key, strings(details[key]), 'пусто'), raw: true })),
  ]
}

/**
 * Order: what to act on first (decisions, tasks), then the type-specific findings,
 * then reference material. Within a type block the order follows render_markdown.
 */
function sectionsFor(s: SummaryData, defs: SectionRef[] | null): SectionDef[] {
  const c = commonSections(s)
  if (!isBuiltinSummary(s)) {
    return [
      c.decisions,
      c.tasks,
      ...customSections(s.details ?? {}, defs),
      c.figures,
      c.questions,
      c.participants,
      c.topics,
    ]
  }
  switch (s.meeting_type) {
    case 'client': {
      const d = s.details
      const count = CLIENT_PARTS.reduce((n, [key]) => n + d[key].length, 0)
      return [
        c.decisions,
        c.tasks,
        c.figures,
        c.questions,
        { id: 'client', title: 'Клиент', count, emptyText: 'ничего не выяснили', body: () => <ClientBlock d={d} /> },
        c.participants,
        c.topics,
      ]
    }
    case 'meeting': {
      const d: MeetingDetails = s.details
      return [
        c.decisions,
        c.tasks,
        list('status', 'Статус', d.status_updates),
        list('blockers', 'Блокеры и риски', [...d.blockers, ...d.risks], 'не названы'),
        c.figures,
        c.questions,
        c.participants,
        c.topics,
      ]
    }
    case 'interview': {
      const d: InterviewDetails = s.details
      return [
        {
          id: 'candidate',
          title: 'Кандидат',
          count: d.experience.length,
          emptyText: 'об опыте не говорили',
          body: () => <Candidate d={d} />,
        },
        {
          id: 'competencies',
          title: 'Компетенции',
          count: d.competencies.length,
          emptyText: 'не проверялись',
          body: () => <Competencies items={d.competencies} />,
        },
        list('strengths', 'Сильные стороны', d.strengths, 'не названы'),
        list('concerns', 'Сомнения', d.concerns, 'нет'),
        list('motivation', 'Мотивация', d.motivation, 'не обсуждали'),
        list('expectations', 'Ожидания и условия', d.expectations, 'не прозвучали'),
        list('candidate-questions', 'Вопросы кандидата', d.candidate_questions, 'не задавал'),
        c.decisions,
        c.tasks,
        c.figures,
        c.questions,
        c.participants,
        c.topics,
      ]
    }
    case 'one_on_one': {
      const d: OneOnOneDetails = s.details
      return [
        c.decisions,
        c.tasks,
        ...ONE_ON_ONE_PARTS.map(([key, title, id]) => list(id, title, d[key], 'не обсуждали')),
        c.figures,
        c.questions,
        c.participants,
        c.topics,
      ]
    }
    case 'highlights': {
      const d: HighlightsDetails = s.details
      return [
        list('theses', 'Тезисы', d.theses, 'не выделены'),
        c.decisions,
        c.tasks,
        c.figures,
        c.questions,
        c.participants,
        c.topics,
      ]
    }
  }
}

// --- Rendering ---

interface BodyProps {
  summary: SummaryData
  /** Section titles of a custom type, from /api/config. */
  sections?: SectionRef[] | null
}

export function SummaryBody({ summary, sections: defs = null }: BodyProps) {
  const sections = sectionsFor(summary, defs)
  const filled = sections.filter((s) => s.count > 0)

  const scrollTo = (id: string) => {
    const el = document.getElementById(`s-${id}`)
    if (!el) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    el.focus({ preventScroll: true })
  }

  const { long } = useJobContext()

  return (
    <div className={styles.body} data-long={long || undefined}>
      <section aria-labelledby="s-tldr-title" className={styles.lead}>
        <h2 id="s-tldr-title" className="visually-hidden">
          Кратко
        </h2>
        <p>{summary.tldr}</p>
      </section>

      {isBuiltinSummary(summary) && summary.meeting_type === 'interview' && (
        <Assessment d={summary.details} />
      )}

      {filled.length > 1 && (
        <nav className={styles.toc} aria-label="Разделы итога" data-copy-skip>
          <ul>
            {filled.map((s) => (
              <li key={s.id}>
                <a
                  href={`#s-${s.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    scrollTo(s.id)
                  }}
                >
                  {s.raw ? <code>{s.title}</code> : s.title}
                  <span className={`${styles.tocCount} tabular`}>{s.count}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {sections.map((s) =>
        s.count > 0 ? (
          <section key={s.id} id={`s-${s.id}`} tabIndex={-1} className={styles.section} aria-labelledby={`s-${s.id}-h`}>
            <h2 id={`s-${s.id}-h`} className={styles.h2}>
              {s.raw ? <code className={styles.rawKey}>{s.title}</code> : s.title}
            </h2>
            {s.body()}
          </section>
        ) : (
          <section key={s.id} id={`s-${s.id}`} tabIndex={-1} className={styles.emptySection}>
            <h2 className={styles.h2}>{s.raw ? <code className={styles.rawKey}>{s.title}</code> : s.title}</h2>
            <p className={styles.emptyText}>— {s.emptyText}</p>
          </section>
        ),
      )}
    </div>
  )
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className={styles.bullets}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

function Decisions({ items }: { items: Decision[] }) {
  return (
    <ul className={styles.timed}>
      {items.map((d, i) => (
        <li key={i}>
          <TimeButton stamp={d.timestamp} />
          <p>{d.text}</p>
        </li>
      ))}
    </ul>
  )
}

function Tasks({ items }: { items: ActionItem[] }) {
  return (
    <ol className={styles.timed}>
      {items.map((a, i) => {
        const meta = [a.owner, a.due && (/^(до|к|в|на|через)\s/i.test(a.due) ? a.due : `срок: ${a.due}`)].filter(Boolean)
        return (
          <li key={i}>
            <TimeButton stamp={a.timestamp} />
            <div>
              <p>{a.task}</p>
              {meta.length > 0 && <p className={styles.meta}>{meta.join(' · ')}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Figures({ items }: { items: Figure[] }) {
  return (
    <dl className={styles.figures}>
      {items.map((f, i) => (
        <div key={i} className={styles.figure}>
          <dt className="tabular">{f.value}</dt>
          <dd>{capitalize(f.context)}</dd>
        </div>
      ))}
    </dl>
  )
}

function Participants({ items }: { items: Participant[] }) {
  return (
    <ul className={styles.people}>
      {items.map((p, i) => (
        <li key={i}>
          <span className={styles.person}>
            {p.name ? (
              <>
                <strong>{p.name}</strong>
                <span className={styles.role}> — {p.role}</span>
              </>
            ) : (
              <strong>{capitalize(p.role)}</strong>
            )}
          </span>
          {p.side && p.side !== 'не определено' && <span className={styles.tag}>{p.side}</span>}
        </li>
      ))}
    </ul>
  )
}

function Topics({ items }: { items: Topic[] }) {
  return (
    <ol className={styles.timed}>
      {items.map((t, i) => (
        <li key={i}>
          <TimeButton stamp={t.timestamp} />
          <div>
            <h3 className={styles.h3}>{t.title}</h3>
            <ul className={styles.points}>
              {t.points.map((p, j) => (
                <li key={j}>{p}</li>
              ))}
            </ul>
          </div>
        </li>
      ))}
    </ol>
  )
}

function ClientBlock({ d }: { d: ClientDetails }) {
  const empty = CLIENT_PARTS.filter(([key]) => d[key].length === 0).map(([, title]) => title.toLowerCase())
  return (
    <div className={styles.subsections}>
      {CLIENT_PARTS.filter(([key]) => d[key].length > 0).map(([key, title]) => (
        <div key={key}>
          <h3 className={styles.h3}>{title}</h3>
          <Bullets items={d[key]} />
        </div>
      ))}
      {empty.length > 0 && <p className={styles.meta}>Не обсуждали: {empty.join(', ')}.</p>}
    </div>
  )
}

// --- Interview ---

const VERDICT_LEVEL: Record<InterviewDetails['assessment']['verdict'], number> = {
  рекомендовать: 4,
  'скорее да': 3,
  'скорее нет': 2,
  'не рекомендовать': 1,
  'недостаточно данных': 0,
}

const COMPETENCY_LEVEL: Record<CompetencyAssessment, number> = {
  'сильная сторона': 3,
  достаточно: 2,
  'есть сомнения': 1,
  'не проверялось': 0,
}

/** A quiet neutral meter instead of traffic-light colors. */
function Meter({ level, of }: { level: number; of: number }) {
  return (
    <span className={styles.meter} data-none={level === 0 || undefined} aria-hidden>
      {Array.from({ length: of }, (_, i) => (
        <span key={i} data-on={i < level || undefined} />
      ))}
    </span>
  )
}

function Assessment({ d }: { d: InterviewDetails }) {
  const a = d.assessment
  return (
    <section className={styles.assessment} aria-labelledby="s-assessment-h">
      <h2 id="s-assessment-h" className={styles.eyebrow}>
        Предварительная оценка
      </h2>
      <p className={styles.verdict}>
        <Meter level={VERDICT_LEVEL[a.verdict]} of={4} />
        {capitalize(a.verdict)}
      </p>
      <p className={styles.rationale}>{a.rationale}</p>
      <p className={styles.disclaimer}>
        <Info size={14} strokeWidth={1.75} aria-hidden />
        Оценка составлена моделью по расшифровке и не заменяет решение интервьюера.
      </p>
    </section>
  )
}

function Candidate({ d }: { d: InterviewDetails }) {
  return (
    <>
      {d.position && (
        <p className={styles.position}>
          <span className={styles.meta}>Вакансия</span> {d.position}
        </p>
      )}
      <Bullets items={d.experience} />
    </>
  )
}

function Competencies({ items }: { items: Competency[] }) {
  return (
    <ul className={styles.timed}>
      {items.map((c, i) => (
        <li key={i}>
          <TimeButton stamp={c.timestamp} />
          <div>
            <div className={styles.competencyHead}>
              <h3 className={styles.h3}>{c.name}</h3>
              <span className={styles.assessmentLabel}>
                <Meter level={COMPETENCY_LEVEL[c.assessment]} of={3} />
                {c.assessment}
              </span>
            </div>
            {c.evidence.length > 0 && (
              <ul className={styles.points}>
                {c.evidence.map((e, j) => (
                  <li key={j}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
