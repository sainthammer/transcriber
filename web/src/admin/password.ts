// Readable strong passwords in the style of "kfmTe4-pqrzua-Hw7nbc": three groups of six,
// no look-alike characters (0/O, 1/l/I), one digit and one capital guaranteed.
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'

function pick(alphabet: string, random: number) {
  return alphabet[random % alphabet.length]
}

export function generatePassword(): string {
  const r = crypto.getRandomValues(new Uint32Array(20))
  const chars = Array.from({ length: 18 }, (_, i) => pick(LOWER, r[i]))
  chars[r[18] % 18] = pick(UPPER, r[19])
  const digitAt = (r[18] + 7) % 18
  chars[digitAt] = pick(DIGITS, r[19] >>> 8)
  const s = chars.join('')
  return `${s.slice(0, 6)}-${s.slice(6, 12)}-${s.slice(12)}`
}
