import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Pause, Play } from 'lucide-react'
import { api, urls } from '../api/client'
import { clock } from '../lib/format'
import { isEditableTarget, isInteractiveTarget } from '../lib/hooks'
import { prefs } from '../lib/prefs'
import { usePlayer, usePlaying } from './store'
import styles from './Player.module.css'

const RATES = [1, 1.25, 1.5, 2]
const rateLabel = (r: number) => `${r.toLocaleString('ru-RU')}×`

interface Props {
  jobId: string
  title: string
  audioReady: boolean
  duration: number | null
  markers: { t: number; title: string }[]
  /** Seek here once loaded (from ?t=); otherwise the saved position is restored. */
  startAt: number | null
}

export function Player({ jobId, title, audioReady, duration, markers, startAt }: Props) {
  const store = usePlayer()
  const playing = usePlaying(store)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [ready, setReady] = useState(audioReady)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [time, setTime] = useState(0)
  const [total, setTotal] = useState(duration ?? 0)
  const [rate, setRate] = useState(prefs.rate)
  const startAtRef = useRef(startAt) // read once per recording
  const long = (total || duration || 0) >= 3600

  // A converted copy for the player may still be in progress (e.g. .ogg, .mp4 sources).
  useEffect(() => {
    if (ready || audioReady) return
    const id = setInterval(async () => {
      try {
        if ((await api.job(jobId)).audio_ready) setReady(true)
      } catch {
        // keep polling
      }
    }, 3000)
    return () => clearInterval(id)
  }, [ready, audioReady, jobId])

  const available = ready || audioReady

  useEffect(() => {
    const audio = audioRef.current
    if (!available || !audio) return
    store.attach(audio)
    const saved = startAtRef.current ?? prefs.position(jobId)
    if (saved) store.seek(saved)
    let lastSave = 0
    const unsubscribe = store.onTime((t) => {
      setTime(t)
      const now = Date.now()
      if (now - lastSave > 5000) {
        lastSave = now
        prefs.savePosition(jobId, t)
      }
    })
    const onPause = () => prefs.savePosition(jobId, audio.currentTime)
    audio.addEventListener('pause', onPause)
    return () => {
      prefs.savePosition(jobId, audio.currentTime)
      audio.removeEventListener('pause', onPause)
      unsubscribe()
      store.attach(null)
    }
  }, [available, jobId, store, attempt])

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [rate, available])

  // Keyboard: Space plays/pauses, ←/→ skip 5 s — unless focus is on a control that uses them.
  useEffect(() => {
    if (!available) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (e.key === ' ' && !isInteractiveTarget(e.target)) {
        e.preventDefault()
        store.toggle()
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !isEditableTarget(e.target)) {
        if (document.querySelector('[role="menu"], [role="dialog"]')) return
        if ((e.target as HTMLElement).closest?.('[role="tablist"]')) return
        e.preventDefault()
        store.skip(e.key === 'ArrowLeft' ? -5 : 5)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [available, store])

  // Media Session: hardware keys, lock screen, Control Center.
  useEffect(() => {
    if (!available || !('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.metadata = new MediaMetadata({ title, artist: 'Расшифровка' })
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => void audioRef.current?.play()],
      ['pause', () => audioRef.current?.pause()],
      ['seekbackward', (d) => store.skip(-(d.seekOffset ?? 15))],
      ['seekforward', (d) => store.skip(d.seekOffset ?? 15)],
      ['seekto', (d) => d.seekTime != null && store.seek(d.seekTime)],
    ]
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler)
      } catch {
        // action not supported
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null)
        } catch {
          // ignore
        }
      }
      ms.metadata = null
    }
  }, [available, title, store])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !total) return
    try {
      navigator.mediaSession.setPositionState({
        duration: total,
        position: Math.min(time, total),
        playbackRate: rate,
      })
    } catch {
      // ignore invalid states during loading
    }
  }, [time, total, rate])

  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]
    setRate(next)
    prefs.saveRate(next)
  }

  const disabled = !available || failed
  const status = failed
    ? 'Аудио не загрузилось'
    : !available
      ? 'Готовим аудио для прослушивания…'
      : null
  const max = total || duration || 0
  const progress = max ? Math.min(time / max, 1) : 0

  return (
    <div className={styles.bar} data-disabled={disabled || undefined}>
      {available && (
        <audio
          key={attempt}
          ref={audioRef}
          src={urls.audio(jobId)}
          preload="metadata"
          onLoadedMetadata={(e) => {
            setTotal(e.currentTarget.duration || duration || 0)
            e.currentTarget.playbackRate = rate
          }}
          onError={() => setFailed(true)}
        />
      )}

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.skip}
          onClick={() => store.skip(-15)}
          disabled={disabled}
          aria-label="Назад на 15 секунд"
          title="Назад на 15 с"
        >
          <span className="tabular" aria-hidden>
            −15
          </span>
        </button>
        <button
          type="button"
          className={styles.play}
          onClick={() => store.toggle()}
          disabled={disabled}
          aria-label={playing ? 'Пауза' : 'Слушать'}
          title={playing ? 'Пауза (пробел)' : 'Слушать (пробел)'}
        >
          {playing ? (
            <Pause size={20} strokeWidth={2} fill="currentColor" aria-hidden />
          ) : (
            <Play size={20} strokeWidth={2} fill="currentColor" aria-hidden className={styles.playIcon} />
          )}
        </button>
        <button
          type="button"
          className={styles.skip}
          onClick={() => store.skip(15)}
          disabled={disabled}
          aria-label="Вперёд на 15 секунд"
          title="Вперёд на 15 с"
        >
          <span className="tabular" aria-hidden>
            +15
          </span>
        </button>
      </div>

      {status ? (
        <p className={styles.status} role="status">
          {!failed && <span className={styles.spinner} aria-hidden />}
          {status}
          {failed && (
            <button
              type="button"
              className={styles.retry}
              onClick={() => {
                setFailed(false)
                setAttempt((n) => n + 1)
              }}
            >
              Повторить
            </button>
          )}
        </p>
      ) : (
        <div className={styles.timeline}>
          <span className={`${styles.time} tabular`}>{clock(time, long)}</span>
          <div className={styles.scrubber} style={{ '--progress': progress } as CSSProperties}>
            <div className={styles.track} aria-hidden>
              <div className={styles.fill} />
              {max > 0 &&
                markers.map((m) => (
                  <span
                    key={m.t}
                    className={styles.marker}
                    style={{ left: `${(m.t / max) * 100}%` }}
                    title={m.title}
                  />
                ))}
            </div>
            <input
              type="range"
              className={styles.range}
              min={0}
              max={Math.max(1, Math.floor(max))}
              step={1}
              value={Math.floor(time)}
              onChange={(e) => store.seek(Number(e.target.value))}
              aria-label="Позиция в записи"
              aria-valuetext={`${clock(time, long)} из ${clock(max, long)}`}
            />
          </div>
          <span className={`${styles.time} ${styles.total} tabular`}>{clock(max, long)}</span>
        </div>
      )}

      {!status && (
        <span className={`${styles.compactTime} tabular`} aria-hidden>
          {clock(time, long)} / {clock(max, long)}
        </span>
      )}

      <button
        type="button"
        className={styles.rate}
        onClick={cycleRate}
        disabled={disabled}
        aria-label={`Скорость ${rateLabel(rate)}`}
        title="Скорость воспроизведения"
      >
        <span className="tabular">{rateLabel(rate)}</span>
      </button>
    </div>
  )
}
