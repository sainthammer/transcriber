import { createContext, useContext, useSyncExternalStore } from 'react'

type Listener = () => void

/**
 * Shared audio state for a recording. Time updates go to subscribers directly,
 * so the transcript can highlight the current phrase without re-rendering.
 */
export class PlayerStore {
  audio: HTMLAudioElement | null = null
  private timeListeners = new Set<(t: number) => void>()
  private stateListeners = new Set<Listener>()
  private revealListeners = new Set<(t: number) => void>()
  private searchListeners = new Set<Listener>()
  private pendingTime: number | null = null
  private cleanup: (() => void) | null = null
  playing = false

  attach(audio: HTMLAudioElement | null) {
    this.cleanup?.()
    this.cleanup = null
    this.audio = audio
    if (!audio) return
    const onTime = () => this.emitTime()
    const onState = () => {
      this.playing = !audio.paused
      this.stateListeners.forEach((l) => l())
    }
    const onMeta = () => {
      if (this.pendingTime !== null) {
        audio.currentTime = this.pendingTime
        this.pendingTime = null
      }
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('seeked', onTime)
    audio.addEventListener('play', onState)
    audio.addEventListener('pause', onState)
    audio.addEventListener('ended', onState)
    audio.addEventListener('loadedmetadata', onMeta)
    this.cleanup = () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('seeked', onTime)
      audio.removeEventListener('play', onState)
      audio.removeEventListener('pause', onState)
      audio.removeEventListener('ended', onState)
      audio.removeEventListener('loadedmetadata', onMeta)
    }
  }

  time(): number {
    return this.audio ? (this.pendingTime ?? this.audio.currentTime) : 0
  }

  private emitTime() {
    const t = this.time()
    this.timeListeners.forEach((l) => l(t))
  }

  seek(t: number, play = false) {
    const audio = this.audio
    if (!audio) return
    const target = Math.max(0, t)
    if (audio.readyState >= 1) audio.currentTime = target
    else this.pendingTime = target
    this.emitTime()
    if (play) void audio.play().catch(() => {})
  }

  toggle() {
    const audio = this.audio
    if (!audio) return
    if (audio.paused) void audio.play().catch(() => {})
    else audio.pause()
  }

  skip(delta: number) {
    if (this.audio) this.seek(this.time() + delta)
  }

  onTime(fn: (t: number) => void) {
    this.timeListeners.add(fn)
    return () => void this.timeListeners.delete(fn)
  }

  onState(fn: Listener) {
    this.stateListeners.add(fn)
    return () => void this.stateListeners.delete(fn)
  }

  /** Ask the transcript to scroll to and flash the phrase at `t`. */
  reveal(t: number) {
    this.revealListeners.forEach((l) => l(t))
  }

  onReveal(fn: (t: number) => void) {
    this.revealListeners.add(fn)
    return () => void this.revealListeners.delete(fn)
  }

  focusSearch() {
    this.searchListeners.forEach((l) => l())
  }

  onFocusSearch(fn: Listener) {
    this.searchListeners.add(fn)
    return () => void this.searchListeners.delete(fn)
  }
}

export const PlayerContext = createContext<PlayerStore | null>(null)

export function usePlayer(): PlayerStore {
  const store = useContext(PlayerContext)
  if (!store) throw new Error('usePlayer outside PlayerContext')
  return store
}

export function usePlaying(store: PlayerStore): boolean {
  return useSyncExternalStore(
    (cb) => store.onState(cb),
    () => store.playing,
  )
}
