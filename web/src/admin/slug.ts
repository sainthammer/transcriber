// Latin keys from Russian titles: «Что улучшить» → "chto_uluchshit".
const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

export function slug(text: string, max = 32): string {
  const latin = [...text.toLowerCase()].map((c) => MAP[c] ?? c).join('')
  const s = latin
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
  return s.slice(0, max).replace(/_+$/, '')
}

export const TYPE_ID = /^[a-z][a-z0-9_]{1,31}$/
export const SECTION_KEY = /^[a-z][a-z0-9_]{0,31}$/
/** Words the URL scheme or the built-ins already use. */
export const RESERVED_IDS = ['new', 'auto', 'client', 'meeting', 'interview', 'one_on_one', 'highlights', 'freeform']
