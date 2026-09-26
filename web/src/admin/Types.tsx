import { useState } from 'react'
import { ChevronRight, Plus, ScrollText } from 'lucide-react'
import { admin } from '../api/client'
import type { ApiError } from '../api/client'
import type { AdminSummaryType } from '../api/types'
import { Button } from '../components/ui/Button'
import { Link } from '../components/ui/Link'
import { plural } from '../lib/format'
import { navigate, typePath } from '../lib/router'
import { useToast } from '../state/toastContext'
import { LoadError, Loading, Page, Section } from './Page'
import { useResource } from './useResource'
import forms from '../components/forms.module.css'
import ui from './admin.module.css'
import styles from './Types.module.css'

export function Types() {
  const types = useResource('types', admin.types)
  const base = useResource('base-prompt', admin.basePrompt)
  const toast = useToast()
  const [pending, setPending] = useState<string | null>(null)

  const toggle = async (t: AdminSummaryType, enabled: boolean) => {
    setPending(t.id)
    types.setData((prev) => prev.map((x) => (x.id === t.id ? { ...x, enabled } : x)))
    try {
      const next = await admin.updateType(t.id, { enabled })
      types.setData((prev) => prev.map((x) => (x.id === t.id ? next : x)))
    } catch (e) {
      types.setData((prev) => prev.map((x) => (x.id === t.id ? t : x)))
      toast((e as ApiError).message)
    } finally {
      setPending(null)
    }
  }

  const builtin = types.data?.filter((t) => t.builtin) ?? []
  const custom = types.data?.filter((t) => !t.builtin) ?? []

  return (
    <Page
      title="Типы встреч"
      subtitle="От типа зависят правила для модели и разделы итога. Выключенные типы не предлагаются при загрузке."
      actions={
        <Button variant="primary" icon={<Plus size={18} strokeWidth={2} />} onClick={() => navigate('/admin/types/new')}>
          Новый тип
        </Button>
      }
    >
      {types.error && !types.data ? (
        <LoadError error={types.error} onRetry={types.reload} />
      ) : !types.data ? (
        <Loading />
      ) : (
        <>
          <ul className={ui.group}>
            <li>
              <Link href="/admin/base-prompt" className={ui.linkRow}>
                <span className={styles.icon} aria-hidden>
                  <ScrollText size={18} strokeWidth={1.75} />
                </span>
                <span className={`${ui.linkText} ${styles.wrap}`}>
                  <span className={ui.linkTitle}>
                    <span>Общие правила</span>
                    {base.data?.modified && <ModifiedBadge />}
                  </span>
                  <span className={ui.linkMeta}>Формат ответа и правила, общие для всех типов</span>
                </span>
                <ChevronRight size={18} strokeWidth={2} className={ui.chevron} aria-hidden />
              </Link>
            </li>
          </ul>

          <Section title="Стандартные">
            <TypeList types={builtin} pending={pending} onToggle={toggle} />
          </Section>

          <Section title="Свои">
            {custom.length ? (
              <TypeList types={custom} pending={pending} onToggle={toggle} />
            ) : (
              <div className={`${ui.empty} ${styles.empty}`}>
                <p>
                  Свой тип — например, ретроспектива или разбор инцидента: свои разделы итога и свои правила для
                  модели.
                </p>
                <Button variant="secondary" onClick={() => navigate('/admin/types/new')}>
                  Создать тип
                </Button>
              </div>
            )}
          </Section>
        </>
      )}
    </Page>
  )
}

export function ModifiedBadge() {
  return (
    <span className={ui.badge} data-tone="accent">
      Изменён
    </span>
  )
}

function TypeList({
  types,
  pending,
  onToggle,
}: {
  types: AdminSummaryType[]
  pending: string | null
  onToggle: (t: AdminSummaryType, enabled: boolean) => void
}) {
  return (
    <ul className={ui.group}>
      {types.map((t) => (
        <li key={t.id} className={styles.item} data-off={!t.enabled || undefined}>
          <Link href={typePath(t.id)} className={`${ui.linkRow} ${styles.link}`}>
            <span className={`${ui.linkText} ${styles.wrap}`}>
              <span className={ui.linkTitle}>
                <span>{t.label}</span>
                {t.prompt_modified && <ModifiedBadge />}
                {!t.enabled && <span className={ui.badge}>Выключен</span>}
              </span>
              <span className={ui.linkMeta}>{t.description}</span>
              <span className={`${styles.count} tabular`}>
                {t.jobs_count
                  ? `${t.jobs_count} ${plural(t.jobs_count, ['запись', 'записи', 'записей'])}`
                  : 'Ещё не использовался'}
                {!t.builtin && t.sections && ` · ${t.sections.length} ${plural(t.sections.length, ['раздел', 'раздела', 'разделов'])}`}
              </span>
            </span>
            <ChevronRight size={18} strokeWidth={2} className={ui.chevron} aria-hidden />
          </Link>
          <span className={styles.toggle}>
            <input
              type="checkbox"
              role="switch"
              className={forms.switch}
              aria-label={`${t.label}: ${t.enabled ? 'включён' : 'выключен'}`}
              checked={t.enabled}
              disabled={pending === t.id}
              onChange={(e) => onToggle(t, e.target.checked)}
            />
          </span>
        </li>
      ))}
    </ul>
  )
}
