import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { PanelLeft, Plus, X } from 'lucide-react'
import type { JobListItem } from './api/types'
import { AccountMenu } from './components/AccountMenu'
import { ConnectionBanner } from './components/ConnectionBanner'
import { DropOverlay } from './components/DropOverlay'
import { JobList } from './components/JobList'
import { NewJobDialog } from './components/NewJobDialog'
import { Offline } from './components/Offline'
import { Welcome } from './components/Welcome'
import { Button, IconButton } from './components/ui/Button'
import { JobScreen } from './job/JobScreen'
import type { Layout } from './job/JobScreen'
import { useMediaQuery } from './lib/hooks'
import { jobPath, navigate, useRoute } from './lib/router'
import { useDeletes } from './state/deletesContext'
import { useConfig } from './state/useConfig'
import { useJobs } from './state/useJobs'
import styles from './App.module.css'

export default function App() {
  const { config, reloadConfig } = useConfig()
  const { jobs, connection } = useJobs()
  const route = useRoute()
  const { pending } = useDeletes()
  const wide = useMediaQuery('(min-width: 1280px)')
  const split = useMediaQuery('(min-width: 1024px)')
  const layout: Layout = wide ? 'wide' : split ? 'medium' : 'narrow'

  const [file, setFile] = useState<File | null>(null)
  const [drawer, setDrawer] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const pick = useCallback(() => fileInput.current?.click(), [])
  const openFile = useCallback(
    (f: File) => {
      setFile(f)
      void reloadConfig() // provider availability may have changed since the page loaded
    },
    [reloadConfig],
  )

  const visible = jobs?.filter((j) => !pending.has(j.id)) ?? null
  const activeId = route.name === 'job' ? route.id : null
  const listItem = visible?.find((j) => j.id === activeId)

  useEffect(() => {
    if (route.name === 'home') document.title = 'Расшифровки'
  }, [route])

  useEffect(() => {
    if (!listItem) return
    document.title = listItem.title || listItem.filename
  }, [listItem])

  const jobScreen = activeId && (
    <JobScreen
      key={activeId}
      id={activeId}
      listItem={listItem}
      config={config}
      layout={layout}
      onOpenSidebar={() => setDrawer(true)}
      onPick={pick}
    />
  )

  let body
  if (visible === null) {
    body = connection === 'lost' ? <Offline /> : <div className={styles.loading} />
  } else if (route.name === 'home' && visible.length === 0) {
    body = (
      <main className={styles.first}>
        <div className={styles.corner}>
          <AccountMenu />
        </div>
        <Welcome variant="first" config={config} onPick={pick} />
      </main>
    )
  } else if (layout === 'narrow') {
    body = <main>{jobScreen || <ListScreen jobs={visible} onPick={pick} />}</main>
  } else {
    body = (
      <div className={styles.shell} data-layout={layout}>
        {layout === 'wide' && (
          <Sidebar jobs={visible} activeId={activeId} onPick={pick} />
        )}
        <main className={styles.workspace}>
          {jobScreen || (
            <div className={styles.home}>
              {layout === 'medium' && (
                <div className={styles.homeBar}>
                  <IconButton label="Показать записи" onClick={() => setDrawer(true)}>
                    <PanelLeft size={20} strokeWidth={1.75} />
                  </IconButton>
                  <AccountMenu />
                </div>
              )}
              <Welcome variant="home" config={config} onPick={pick} />
            </div>
          )}
        </main>
        {layout === 'medium' && (
          <Dialog.Root open={drawer} onOpenChange={setDrawer}>
            <Dialog.Portal>
              <Dialog.Overlay className={styles.drawerOverlay} />
              <Dialog.Content className={styles.drawer} aria-describedby={undefined}>
                <Dialog.Title className="visually-hidden">Записи</Dialog.Title>
                <Sidebar
                  jobs={visible}
                  activeId={activeId}
                  onPick={() => {
                    setDrawer(false)
                    pick()
                  }}
                  onOpen={() => setDrawer(false)}
                  close={
                    <Dialog.Close asChild>
                      <IconButton label="Скрыть записи">
                        <X size={20} strokeWidth={1.75} />
                      </IconButton>
                    </Dialog.Close>
                  }
                />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </div>
    )
  }

  return (
    <>
      {body}
      <ConnectionBanner lost={connection === 'lost' && visible !== null} />
      <DropOverlay onFile={openFile} />
      <NewJobDialog
        file={file}
        config={config}
        onClose={() => setFile(null)}
        onPickAnother={pick}
        onCreated={(id) => {
          setFile(null)
          navigate(jobPath(id))
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,video/*,.mp3,.m4a,.wav,.ogg,.opus,.flac,.aac,.mp4,.mov,.webm,.mkv"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) openFile(f)
          e.target.value = ''
        }}
      />
    </>
  )
}

interface SidebarProps {
  jobs: JobListItem[]
  activeId: string | null
  onPick: () => void
  onOpen?: () => void
  close?: ReactNode
}

function Sidebar({ jobs, activeId, onPick, onOpen, close }: SidebarProps) {
  return (
    <nav className={styles.sidebar} aria-labelledby="sidebar-h">
      <div className={styles.sidebarHeader}>
        {close}
        <h2 id="sidebar-h" className={styles.sidebarTitle}>
          Записи
        </h2>
        <IconButton label="Новая запись" onClick={onPick}>
          <Plus size={20} strokeWidth={1.75} />
        </IconButton>
        <AccountMenu />
      </div>
      <div className={styles.sidebarScroll}>
        <JobList jobs={jobs} activeId={activeId} onOpen={onOpen} />
      </div>
    </nav>
  )
}

function ListScreen({ jobs, onPick }: { jobs: JobListItem[]; onPick: () => void }) {
  return (
    <div className={styles.listScreen}>
      <header className={styles.listHeader}>
        <h1 className={styles.listTitle}>Записи</h1>
        <div className={styles.listActions}>
          <Button variant="primary" icon={<Plus size={18} strokeWidth={2} />} onClick={onPick}>
            Новая
          </Button>
          <AccountMenu />
        </div>
      </header>
      <nav aria-label="Записи">
        <JobList jobs={jobs} activeId={null} />
      </nav>
      <p className={styles.listHint}>Файл можно просто перетащить в окно.</p>
    </div>
  )
}
