import type { Phrase } from '../api/types'

/**
 * Lowercase and ё → е. Both are one-to-one per UTF-16 unit for Cyrillic and Latin,
 * so match offsets in the normalized string are valid in the original.
 */
export function normalize(s: string): string {
  return s.toLowerCase().replaceAll('ё', 'е')
}

export interface Match {
  phrase: number
  start: number
  end: number
}

export function findMatches(phrases: Phrase[], query: string): Match[] {
  const q = normalize(query.trim())
  if (!q) return []
  const out: Match[] = []
  phrases.forEach((p, phrase) => {
    const text = normalize(p.text)
    let from = 0
    for (;;) {
      const at = text.indexOf(q, from)
      if (at < 0) break
      out.push({ phrase, start: at, end: at + q.length })
      from = at + q.length
    }
  })
  return out
}

/** Index of the last phrase starting at or before `t` (binary search), or -1. */
export function phraseAt(phrases: Phrase[], t: number): number {
  let lo = 0
  let hi = phrases.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (phrases[mid].start_sec <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${cut.slice(0, space > max * 0.6 ? space : max).trimEnd()}…`
}
