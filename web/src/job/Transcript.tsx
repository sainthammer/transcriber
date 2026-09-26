import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronDown, ChevronUp, Locate, Search, X } from 'lucide-react'
import type { JobDetail, Phrase } from '../api/types'
import { clock, parseStamp, plural } from '../lib/format'
import { reducedMotion } from '../lib/hooks'
import { setTimeParam } from '../lib/router'
import { findMatches, phraseAt } from '../lib/text'
import type { Match } from '../lib/text'
import { usePlayer, usePlaying } from '../player/store'
import { useJobContext } from './context'
import styles from './Transcript.module.css'

interface IndexedMatch extends Match {
  index: number
}

const scrollOptions = (): ScrollIntoViewOptions => ({
  block: 'center',
  behavior: reducedMotion() ? 'auto' : 'smooth',
})

interface Props {
  job: JobDetail
  /** Recognition in progress: raw phrases stream in and the view sticks to the bottom. */
  live: boolean
}

export function Transcript({ job, live }: Props) {
  const store = usePlayer()
  const playing = usePlaying(store)
  const { long } = useJobContext()
  const phrases = job.transcript

  const rootRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const rows = useRef<(HTMLDivElement | null)[]>([])
  const current = useRef(-1)
  const following = useRef(true)
  const [detached, setDetached] = useState(false)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const matches = useMemo(() => findMatches(phrases, query), [phrases, query])
  const byPhrase = useMemo(() => {
    const map = new Map<number, IndexedMatch[]>()
    matches.forEach((m, index) => {
      const list = map.get(m.phrase) ?? []
      list.push({ ...m, index })
      map.set(m.phrase, list)
    })
    return map
  }, [matches])
  const activeMatch = matches.length ? Math.min(active, matches.length - 1) : -1

  // Topic titles from the summary, placed before the first phrase that starts at the topic's
  // moment (a second of slack for rounding) — topics begin at phrase boundaries.
  const headings = useMemo(() => {
    const map = new Map<number, string[]>()
    for (const topic of job.summary?.topics ?? []) {
      const t = parseStamp(topic.timestamp)
      let i = phrases.findIndex((p) => p.start_sec >= t - 1)
      if (i < 0) i = phrases.length - 1
      map.set(i, [...(map.get(i) ?? []), topic.title])
    }
    return map
  }, [job.summary, phrases])

  const setRow = useCallback((i: number, el: HTMLDivElement | null) => {
    rows.current[i] = el
  }, [])

  const detach = useCallback(() => {
    if (!following.current) return
    following.current = false
    setDetached(true)
  }, [])

  const follow = useCallback(() => {
    following.current = true
    setDetached(false)
    rows.current[current.current]?.scrollIntoView(scrollOptions())
  }, [])

  const seek = useCallback(
    (t: number) => {
      if (!store.audio) return
      following.current = true
      setDetached(false)
      store.seek(Math.max(0, t - 0.3), true)
      setTimeParam(t)
    },
    [store],
  )

  // Highlight the phrase being played by toggling an attribute: no re-render per tick.
  useEffect(() => {
    const apply = (t: number) => {
      if (!store.audio || (t === 0 && !store.playing)) return
      const idx = phraseAt(phrases, t + 0.15)
      if (idx === current.current) return
      rows.current[current.current]?.removeAttribute('data-current')
      current.current = idx
      const el = rows.current[idx]
      if (!el) return
      el.setAttribute('data-current', '')
      if (following.current && store.playing) el.scrollIntoView(scrollOptions())
    }
    current.current = -1
    rows.current.forEach((el) => el?.removeAttribute('data-current'))
    apply(store.time())
    return store.onTime(apply)
  }, [phrases, store])

  // Manual scrolling pauses following until «К текущему месту».
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) detach()
    }
    root.addEventListener('wheel', detach, { passive: true })
    root.addEventListener('touchmove', detach, { passive: true })
    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('wheel', detach)
      root.removeEventListener('touchmove', detach)
      root.removeEventListener('keydown', onKey)
    }
  }, [detach])

  // A timestamp in the summary was clicked: bring its phrase into view and flash it.
  useEffect(
    () =>
      store.onReveal((t) => {
        const el = rows.current[Math.max(0, phraseAt(phrases, t))]
        if (!el) return
        following.current = true
        setDetached(false)
        el.scrollIntoView(scrollOptions())
        el.removeAttribute('data-flash')
        void el.offsetWidth // restart the animation
        el.setAttribute('data-flash', '')
      }),
    [phrases, store],
  )

  useEffect(() => store.onFocusSearch(() => inputRef.current?.focus()), [store])

  // Search: keep the active match in view.
  useEffect(() => {
    if (activeMatch < 0) return
    const mark = rootRef.current?.querySelector(`mark[data-match="${activeMatch}"]`)
    if (!mark) return
    following.current = false
    mark.scrollIntoView(scrollOptions())
  }, [activeMatch, matches])

  // Live mode: stick to the bottom while the user hasn't scrolled up.
  const atBottom = useRef(true)
  useEffect(() => {
    const end = endRef.current
    if (!live || !end) return
    const observer = new IntersectionObserver(([entry]) => {
      atBottom.current = entry.isIntersecting
    })
    observer.observe(end)
    return () => observer.disconnect()
  }, [live])
  useEffect(() => {
    if (live && atBottom.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [live, phrases.length])

  const step = (delta: number) => {
    if (!matches.length) return
    setActive((a) => (Math.min(a, matches.length - 1) + delta + matches.length) % matches.length)
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) setQuery('')
      else e.currentTarget.blur()
    }
  }

  const count = phrases.length

  return (
    <section
      ref={rootRef}
      className={styles.root}
      data-long={long || undefined}
      aria-labelledby="transcript-h"
    >
      <div className={styles.head}>
        <div className={styles.headRow}>
          <h2 id="transcript-h" className={styles.title}>
            Расшифровка
          </h2>
          {count > 0 && (
            <span className={`${styles.count} tabular`}>
              {count} {plural(count, ['фраза', 'фразы', 'фраз'])}
            </span>
          )}
        </div>
        {live && count > 0 && <p className={styles.liveNote}>Обновляется по мере распознавания.</p>}
        {count > 0 && (
          <div className={styles.search}>
            <Search className={styles.searchIcon} size={16} strokeWidth={2} aria-hidden />
            <input
              ref={inputRef}
              type="search"
              className={styles.searchInput}
              placeholder="Поиск по расшифровке"
              aria-label="Поиск по расшифровке"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onSearchKey}
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
            />
            {query ? (
              <>
                <span className={`${styles.counter} tabular`} aria-live="polite">
                  {matches.length ? `${activeMatch + 1} из ${matches.length}` : 'Не найдено'}
                </span>
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={() => step(-1)}
                  disabled={!matches.length}
                  aria-label="Предыдущее совпадение"
                  title="Предыдущее (Shift+Enter)"
                >
                  <ChevronUp size={18} strokeWidth={2} aria-hidden />
                </button>
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={() => step(1)}
                  disabled={!matches.length}
                  aria-label="Следующее совпадение"
                  title="Следующее (Enter)"
                >
                  <ChevronDown size={18} strokeWidth={2} aria-hidden />
                </button>
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={() => {
                    setQuery('')
                    inputRef.current?.focus()
                  }}
                  aria-label="Очистить поиск"
                  title="Очистить (Esc)"
                >
                  <X size={16} strokeWidth={2} aria-hidden />
                </button>
              </>
            ) : (
              <kbd className={styles.kbd} aria-hidden title="Нажмите / для поиска">
                /
              </kbd>
            )}
          </div>
        )}
      </div>

      {count === 0 ? (
        <p className={styles.empty}>
          {live ? 'Фразы появятся здесь по мере распознавания.' : 'В расшифровке нет фраз.'}
        </p>
      ) : (
        <div className={styles.rows} data-live={live || undefined}>
          {phrases.map((p, i) => (
            <Row
              key={i}
              index={i}
              phrase={p}
              long={long}
              headings={headings.get(i)}
              marks={byPhrase.get(i)}
              activeMatch={byPhrase.get(i)?.some((m) => m.index === activeMatch) ? activeMatch : -1}
              setRow={setRow}
              onSeek={seek}
            />
          ))}
          <div ref={endRef} className={styles.end} aria-hidden />
        </div>
      )}

      {detached && playing && (
        <button type="button" className={styles.follow} onClick={follow}>
          <Locate size={16} strokeWidth={2} aria-hidden />К текущему месту
        </button>
      )}
    </section>
  )
}

interface RowProps {
  index: number
  phrase: Phrase
  long: boolean
  headings?: string[]
  marks?: IndexedMatch[]
  activeMatch: number
  setRow: (i: number, el: HTMLDivElement | null) => void
  onSeek: (t: number) => void
}

const Row = memo(function Row({ index, phrase, long, headings, marks, activeMatch, setRow, onSeek }: RowProps) {
  const label = clock(phrase.start_sec, long)
  return (
    <>
      {headings?.map((h) => (
        <h3 key={h} className={styles.topic}>
          {h}
        </h3>
      ))}
      <div ref={(el) => setRow(index, el)} className={styles.row}>
        <button
          type="button"
          className={`${styles.time} tabular`}
          onClick={() => onSeek(phrase.start_sec)}
          aria-label={`${label} — слушать с этой фразы`}
        >
          {label}
        </button>
        <p
          className={styles.text}
          onClick={() => {
            // Selecting text to copy shouldn't jump the audio.
            if (window.getSelection()?.isCollapsed !== false) onSeek(phrase.start_sec)
          }}
        >
          {highlight(phrase.text, marks, activeMatch)}
        </p>
      </div>
    </>
  )
})

function highlight(text: string, marks: IndexedMatch[] | undefined, active: number): ReactNode {
  if (!marks?.length) return text
  const out: ReactNode[] = []
  let pos = 0
  for (const m of marks) {
    out.push(text.slice(pos, m.start))
    out.push(
      <mark key={m.index} data-match={m.index} data-active={m.index === active ? '' : undefined}>
        {text.slice(m.start, m.end)}
      </mark>,
    )
    pos = m.end
  }
  out.push(text.slice(pos))
  return out
}
