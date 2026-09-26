import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import type { Config, JobListItem } from '../api/types'
import { jobTitle, parseStamp } from '../lib/format'
import { isEditableTarget } from '../lib/hooks'
import { initialTime, navigate, setTimeParam } from '../lib/router'
import { phraseAt } from '../lib/text'
import { Player } from '../player/Player'
import { PlayerContext, PlayerStore } from '../player/store'
import { useDeletes } from '../state/deletesContext'
import { isFinal, useJob } from '../state/useJob'
import { Button } from '../components/ui/Button'
import { JobContext } from './context'
import { copySummary } from './copy'
import { JobHeader } from './JobHeader'
import { JobMain } from './JobMain'
import { Transcript } from './Transcript'
import styles from './JobScreen.module.css'

export type Layout = 'wide' | 'medium' | 'narrow'

interface Props {
  id: string
  listItem: JobListItem | undefined
  config: Config | null
  layout: Layout
  onOpenSidebar: () => void
  onPick: () => void
}

export function JobScreen({ id, listItem, config, layout, onOpenSidebar, onPick }: Props) {
  const { job, missing, reload, replace } = useJob(id)
  const [store] = useState(() => new PlayerStore())
  const [startAt] = useState(initialTime)
  const [titleVisible, setTitleVisible] = useState(true)
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary')
  const articleRef = useRef<HTMLElement>(null)
  const { remove } = useDeletes()

  const title = job ? (job.summary?.title ?? jobTitle(job)) : listItem ? jobTitle(listItem) : ''
  const transcript = useMemo(() => job?.transcript ?? [], [job?.transcript])
  const total = job?.duration_sec ?? 0
  const hasTranscript = transcript.length > 0
  const showTranscript = !!job && (hasTranscript || !isFinal(job.status))
  const live = !!job && !isFinal(job.status) && job.stages.transcribing.status !== 'done'

  // The list stream noticed the job went back into processing (summary requested) — resubscribe.
  const listStatus = listItem?.status
  const jobStatus = job?.status
  useEffect(() => {
    if (jobStatus && isFinal(jobStatus) && listStatus && !isFinal(listStatus)) reload()
  }, [listStatus, jobStatus, reload])

  // Opened with ?t=: show that phrase once the transcript is there.
  const revealed = useRef(false)
  useEffect(() => {
    if (revealed.current || startAt == null || !hasTranscript) return
    revealed.current = true
    requestAnimationFrame(() => store.reveal(startAt))
  }, [hasTranscript, startAt, store])

  const jump = useCallback(
    (t: number) => {
      const i = phraseAt(transcript, t)
      const start = i >= 0 ? transcript[i].start_sec : t
      if (store.audio) store.seek(Math.max(0, start - 2), true)
      store.reveal(start)
      setTimeParam(start)
    },
    [transcript, store],
  )

  const context = useMemo(() => ({ transcript, long: total >= 3600, jump }), [transcript, total, jump])

  // «/» focuses transcript search from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return
      if (!hasTranscript || document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      if (layout === 'narrow') setTab('transcript')
      requestAnimationFrame(() => store.focusSearch())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layout, hasTranscript, store])

  // Narrow layout: each tab keeps its own scroll position.
  const scrollByTab = useRef({ summary: 0, transcript: 0 })
  const changeTab = (next: string) => {
    scrollByTab.current[tab] = window.scrollY
    setTab(next as typeof tab)
    requestAnimationFrame(() => window.scrollTo(0, scrollByTab.current[next as typeof tab]))
  }

  const del = () => {
    remove(id, title || 'Запись')
    navigate('/', { replace: true })
  }

  const markers = useMemo(
    () => (job?.summary?.topics ?? []).map((t) => ({ t: parseStamp(t.timestamp), title: t.title })),
    [job?.summary],
  )

  const header = (
    <JobHeader
      job={job}
      title={title}
      showTitle={!titleVisible}
      layout={layout}
      onBack={() => navigate('/')}
      onOpenSidebar={onOpenSidebar}
      onCopy={() => copySummary(articleRef.current!, id)}
      onDelete={del}
    />
  )

  if (missing) {
    return (
      <div className={styles.screen} data-layout={layout}>
        {header}
        <div className={styles.missing}>
          <h1 className={styles.missingTitle}>Запись не найдена</h1>
          <p className={styles.missingText}>Возможно, её удалили в другой вкладке.</p>
          <Button variant="secondary" onClick={() => navigate('/', { replace: true })}>
            Ко всем записям
          </Button>
        </div>
      </div>
    )
  }

  const main = job && (
    <JobMain
      job={job}
      config={config}
      articleRef={articleRef}
      onTitleVisible={setTitleVisible}
      onRequested={reload}
      onRestored={replace}
      onDelete={del}
      onPick={onPick}
    />
  )
  const transcriptPane = job && showTranscript && <Transcript job={job} live={live} />
  const player = job && (
    <div className={styles.playerSlot}>
      <Player
        jobId={job.id}
        title={title}
        audioReady={job.audio_ready}
        duration={job.duration_sec}
        markers={markers}
        startAt={startAt}
      />
    </div>
  )

  return (
    <PlayerContext.Provider value={store}>
      <JobContext.Provider value={context}>
        {layout === 'narrow' ? (
          <Tabs.Root className={styles.screen} data-layout="narrow" value={tab} onValueChange={changeTab}>
            <div className={styles.stickyTop} data-scrolled={!titleVisible || undefined}>
              {header}
              {showTranscript && (
                <Tabs.List className={styles.tabs} aria-label="Раздел записи">
                  <Tabs.Trigger value="summary" className={styles.tab}>
                    Итог
                  </Tabs.Trigger>
                  <Tabs.Trigger value="transcript" className={styles.tab}>
                    Расшифровка
                    {live && hasTranscript && <span className={`${styles.tabCount} tabular`}>{transcript.length}</span>}
                  </Tabs.Trigger>
                </Tabs.List>
              )}
            </div>
            <Tabs.Content value="summary" forceMount className={styles.tabPanel}>
              <div className={styles.mainInner}>{main}</div>
            </Tabs.Content>
            {showTranscript && (
              <Tabs.Content value="transcript" forceMount className={styles.tabPanel}>
                {transcriptPane}
              </Tabs.Content>
            )}
            {player}
          </Tabs.Root>
        ) : (
          <div className={styles.screen} data-layout={layout}>
            {header}
            <div className={styles.columns} data-transcript={showTranscript || undefined}>
              <div className={styles.mainScroll}>
                <div className={styles.mainInner}>{main}</div>
              </div>
              {showTranscript && (
                <div className={styles.transcriptScroll}>{transcriptPane}</div>
              )}
            </div>
            {player}
          </div>
        )}
      </JobContext.Provider>
    </PlayerContext.Provider>
  )
}
