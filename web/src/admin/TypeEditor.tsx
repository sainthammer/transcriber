import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { admin } from '../api/client'
import type { ApiError } from '../api/client'
import type { AdminSummaryType, BasePrompt, NewSummaryType, SectionDef, SummaryTypePatch } from '../api/types'
import { Button } from '../components/ui/Button'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { Field } from '../components/ui/Field'
import { Link } from '../components/ui/Link'
import { plural } from '../lib/format'
import { navigate, typePath } from '../lib/router'
import { useToast } from '../state/toastContext'
import { LoadError, Loading, Page, Section } from './Page'
import { MAX_SECTIONS, newSection, SectionsEditor } from './SectionsEditor'
import type { DraftSection, SectionErrors } from './SectionsEditor'
import { RESERVED_IDS, SECTION_KEY, slug, TYPE_ID } from './slug'
import { ModifiedBadge } from './Types'
import { useLeaveGuard } from './useLeaveGuard'
import { useResource } from './useResource'
import forms from '../components/forms.module.css'
import ui from './admin.module.css'
import styles from './TypeEditor.module.css'

const BACK = { href: '/admin/types', label: 'Типы встреч' }

const BASE_RULES_LINK = (
  <>
    Прибавляются к <Link href="/admin/base-prompt">общим правилам</Link>, которые действуют для всех типов.
  </>
)

function validateSections(sections: DraftSection[]): SectionErrors {
  const errors: SectionErrors = {}
  const seen = new Set<string>()
  for (const s of sections) {
    const e: SectionErrors[string] = {}
    if (!s.title.trim()) e.title = 'Укажите заголовок'
    if (!SECTION_KEY.test(s.key)) e.key = 'Латиница, цифры и «_», начинается с буквы'
    else if (seen.has(s.key)) e.key = 'Такой ключ уже есть'
    seen.add(s.key)
    if (Object.keys(e).length) errors[s.uid] = e
  }
  return errors
}

const toSectionDefs = (sections: DraftSection[]): SectionDef[] =>
  sections.map((s) => ({ key: s.key, title: s.title.trim(), description: s.description.trim() }))

// --- Editing an existing type ---

export function TypeEditor({ id }: { id: string }) {
  const types = useResource('types', admin.types)
  const type = types.data?.find((t) => t.id === id) ?? null

  if (types.error && !types.data) {
    return (
      <Page title="Тип встречи" back={BACK}>
        <LoadError error={types.error} onRetry={types.reload} />
      </Page>
    )
  }
  if (!types.data) {
    return (
      <Page title="" back={BACK}>
        <Loading />
      </Page>
    )
  }
  if (!type) {
    return (
      <Page title="Тип не найден" back={BACK}>
        <p className={ui.empty}>Возможно, ссылка устарела.</p>
      </Page>
    )
  }
  return (
    <TypeForm
      type={type}
      onChange={(next) => types.setData((prev) => prev.map((t) => (t.id === next.id ? next : t)))}
      onDelete={() => {
        types.setData((prev) => prev.filter((t) => t.id !== id))
        navigate(BACK.href, { force: true })
      }}
    />
  )
}

function toDraft(type: AdminSummaryType) {
  return {
    label: type.label,
    description: type.description,
    prompt: type.prompt,
    sections: (type.sections ?? []).map((s) => newSection(s)),
  }
}

function TypeForm({
  type,
  onChange,
  onDelete,
}: {
  type: AdminSummaryType
  onChange: (type: AdminSummaryType) => void
  onDelete: () => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState(() => toDraft(type))
  const [base, setBase] = useState(type)
  const [errors, setErrors] = useState<SectionErrors>({})
  const [busy, setBusy] = useState(false)
  const [enabledPending, setEnabledPending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (base !== type) {
    setBase(type)
    setDraft(toDraft(type))
    setErrors({})
  }

  const sectionsChanged =
    !type.builtin &&
    (draft.sections.length !== (type.sections?.length ?? 0) ||
      draft.sections.some(
        (s, i) => s.key !== type.sections?.[i]?.key || s.title !== type.sections[i].title || s.description !== type.sections[i].description,
      ))
  const dirty =
    draft.label.trim() !== type.label ||
    draft.description.trim() !== type.description ||
    draft.prompt !== type.prompt ||
    sectionsChanged
  const leaveDialog = useLeaveGuard(dirty, 'Изменения в типе встречи не сохранены.')

  const toggleEnabled = async (enabled: boolean) => {
    setEnabledPending(true)
    const prev = type
    onChange({ ...type, enabled })
    try {
      onChange(await admin.updateType(type.id, { enabled }))
    } catch (e) {
      onChange(prev)
      toast((e as ApiError).message)
    } finally {
      setEnabledPending(false)
    }
  }

  const save = async () => {
    // The server only accepts `prompt`/`enabled` for a built-in type — its label,
    // description and sections are fixed in code.
    const patch: SummaryTypePatch = { prompt: draft.prompt }
    if (!type.builtin) {
      const sectionErrors = validateSections(draft.sections)
      if (Object.keys(sectionErrors).length) {
        setErrors(sectionErrors)
        return
      }
      patch.label = draft.label.trim()
      patch.description = draft.description.trim()
      patch.sections = toSectionDefs(draft.sections)
    }
    setBusy(true)
    try {
      onChange(await admin.updateType(type.id, patch))
      toast('Сохранено')
    } catch (e) {
      toast((e as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  const resetPrompt = async () => {
    setBusy(true)
    try {
      onChange(await admin.updateType(type.id, { prompt: null }))
      toast('Правила сброшены к исходным')
    } catch (e) {
      toast((e as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setConfirmDelete(false)
    try {
      await admin.deleteType(type.id)
      onDelete()
      toast('Тип удалён')
    } catch (e) {
      toast((e as ApiError).message)
    }
  }

  const subtitle = `${type.builtin ? 'Стандартный тип' : 'Свой тип'} · ${
    type.jobs_count ? `${type.jobs_count} ${plural(type.jobs_count, ['запись', 'записи', 'записей'])}` : 'ещё не использовался'
  }`

  return (
    <Page
      title={type.label}
      back={BACK}
      subtitle={subtitle}
      actions={
        !type.builtin && (
          <Button variant="danger" icon={<Trash2 size={18} strokeWidth={1.75} />} onClick={() => setConfirmDelete(true)}>
            Удалить
          </Button>
        )
      }
    >
      <Section title="Общее">
        <div className={ui.group}>
          <label className={ui.row}>
            <span className={ui.rowLabel}>
              <span className={ui.rowTitle}>Предлагать при загрузке</span>
              <span className={ui.rowHint}>Выключенный тип нельзя выбрать для новой записи; готовые итоги не меняются.</span>
            </span>
            <span className={ui.rowControl}>
              <input
                type="checkbox"
                role="switch"
                className={forms.switch}
                checked={type.enabled}
                disabled={enabledPending}
                onChange={(e) => void toggleEnabled(e.target.checked)}
              />
            </span>
          </label>
        </div>
        {type.builtin ? (
          <p className={ui.rowHint}>
            Название и описание встроенного типа заданы в коде и не редактируются здесь. Описание используется
            моделью в режиме «Определить автоматически»: <em>{type.description}</em>
          </p>
        ) : (
          <div className={`${styles.fields} ${styles.groupFields}`}>
            <Field label="Название">
              <input
                className={forms.input}
                value={draft.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              />
            </Field>
            <Field label="Описание" hint="Помогает модели выбрать тип автоматически (режим «Определить автоматически»).">
              <textarea
                className={forms.textarea}
                rows={2}
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </Field>
          </div>
        )}
      </Section>

      <Section
        title="Правила для модели"
        description={
          <>
            {BASE_RULES_LINK}
            {type.prompt_modified && (
              <>
                {' '}
                <ModifiedBadge />
              </>
            )}
          </>
        }
        actions={
          type.prompt_modified && (
            <Button variant="secondary" onClick={() => void resetPrompt()} disabled={busy}>
              Восстановить исходные
            </Button>
          )
        }
      >
        <textarea
          className={`${forms.textarea} ${styles.prompt}`}
          rows={16}
          value={draft.prompt}
          spellCheck={false}
          onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
        />
      </Section>

      {!type.builtin && (
        <Section title="Разделы итога" description={`До ${MAX_SECTIONS} штук — каждый становится отдельным списком пунктов в итоге.`}>
          <SectionsEditor
            sections={draft.sections}
            onChange={(sections) => setDraft((d) => ({ ...d, sections }))}
            errors={errors}
            existing
          />
        </Section>
      )}

      {dirty && (
        <div className={styles.saveBar}>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(toDraft(type))
              setErrors({})
            }}
            disabled={busy}
          >
            Отменить
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Сохранить
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Удалить «${type.label}»?`}
        description={
          type.jobs_count
            ? `Уже использован в ${type.jobs_count} ${plural(type.jobs_count, ['записи', 'записях', 'записях'])} — они останутся, но тип будет недоступен для повторного выбора.`
            : 'Тип пока не использовался ни в одной записи.'
        }
        confirm="Удалить"
        danger
        onConfirm={remove}
      />

      {leaveDialog}
    </Page>
  )
}

// --- Creating a new type ---

export function NewTypeEditor() {
  const toast = useToast()
  const types = useResource('types', admin.types)
  const [label, setLabel] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [sections, setSections] = useState<DraftSection[]>(() => [newSection()])
  const [idError, setIdError] = useState<string | null>(null)
  const [sectionErrors, setSectionErrors] = useState<SectionErrors>({})
  const [busy, setBusy] = useState(false)

  const dirty =
    label.trim() !== '' ||
    description.trim() !== '' ||
    prompt.trim() !== '' ||
    sections.some((s) => s.title.trim() || s.key.trim() || s.description.trim())
  const leaveDialog = useLeaveGuard(dirty)

  const save = async () => {
    const trimmedLabel = label.trim()
    const trimmedId = id.trim()
    const existing = new Set([...RESERVED_IDS, ...(types.data?.map((t) => t.id) ?? [])])
    let nextIdError: string | null = null
    if (!TYPE_ID.test(trimmedId)) nextIdError = 'Латиница, цифры и «_», начинается с буквы, минимум 2 символа'
    else if (existing.has(trimmedId)) nextIdError = 'Такой идентификатор уже есть'
    setIdError(nextIdError)

    const nextSectionErrors = validateSections(sections)
    setSectionErrors(nextSectionErrors)

    if (nextIdError || Object.keys(nextSectionErrors).length || !trimmedLabel) return

    const type: NewSummaryType = {
      id: trimmedId,
      label: trimmedLabel,
      description: description.trim(),
      prompt,
      sections: toSectionDefs(sections),
    }
    setBusy(true)
    try {
      const created = await admin.createType(type)
      types.setData((prev) => [...prev, created])
      toast('Тип создан')
      navigate(typePath(created.id), { force: true })
    } catch (e) {
      const err = e as ApiError
      if (err.fields.id) setIdError(err.fields.id)
      else toast(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page title="Новый тип" back={BACK}>
      <Section title="Общее">
        <div className={styles.fields}>
          <Field label="Название">
            <input
              className={forms.input}
              value={label}
              autoFocus
              placeholder="Например, «Ретроспектива»"
              onChange={(e) => {
                const v = e.target.value
                setLabel(v)
                if (!idTouched) setId(slug(v))
              }}
            />
          </Field>
          <Field label="Идентификатор" error={idError} hint="Латиница: используется в ссылках и в ответе модели, менять после создания нельзя.">
            <input
              className={`${forms.input} ${forms.mono}`}
              value={id}
              spellCheck={false}
              autoCapitalize="off"
              maxLength={32}
              onChange={(e) => {
                setId(e.target.value)
                setIdTouched(true)
              }}
            />
          </Field>
          <Field label="Описание" hint="Помогает модели выбрать тип автоматически (режим «Определить автоматически»).">
            <textarea
              className={forms.textarea}
              rows={2}
              value={description}
              placeholder="Например: обсуждение прошедшего спринта — что получилось, что мешало, что изменить"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section title="Правила для модели" description={BASE_RULES_LINK}>
        <textarea
          className={`${forms.textarea} ${styles.prompt}`}
          rows={12}
          value={prompt}
          spellCheck={false}
          placeholder="Например: фиксируй, что решили изменить в процессе, и кто отвечает за следующий шаг."
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Section>

      <Section title="Разделы итога" description={`До ${MAX_SECTIONS} штук — каждый становится отдельным списком пунктов в итоге.`}>
        <SectionsEditor sections={sections} onChange={setSections} errors={sectionErrors} existing={false} />
      </Section>

      <div className={styles.saveBar}>
        <Button variant="secondary" onClick={() => navigate(BACK.href)} disabled={busy}>
          Отменить
        </Button>
        <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={() => void save()}>
          Создать
        </Button>
      </div>

      {leaveDialog}
    </Page>
  )
}

// --- Base prompt (shared by every type) ---

export function BasePromptEditor() {
  const { data, error, reload, setData } = useResource('base-prompt', admin.basePrompt)

  if (error && !data) {
    return (
      <Page title="Общие правила" back={BACK}>
        <LoadError error={error} onRetry={reload} />
      </Page>
    )
  }
  if (!data) {
    return (
      <Page title="" back={BACK}>
        <Loading />
      </Page>
    )
  }
  return <BasePromptForm data={data} onChange={setData} />
}

function BasePromptForm({ data, onChange }: { data: BasePrompt; onChange: (b: BasePrompt) => void }) {
  const toast = useToast()
  const [prompt, setPrompt] = useState(data.prompt)
  const [base, setBase] = useState(data)
  const [busy, setBusy] = useState(false)

  if (base !== data) {
    setBase(data)
    setPrompt(data.prompt)
  }

  const dirty = prompt !== data.prompt
  const leaveDialog = useLeaveGuard(dirty, 'Изменения в общих правилах не сохранены.')

  const save = async (value: string | null) => {
    setBusy(true)
    try {
      onChange(await admin.saveBasePrompt(value))
      toast(value === null ? 'Правила сброшены к исходным' : 'Сохранено')
    } catch (e) {
      toast((e as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page
      title="Общие правила"
      back={BACK}
      subtitle="Формат ответа и правила, общие для всех типов встреч."
      actions={
        data.modified && (
          <Button variant="secondary" onClick={() => void save(null)} disabled={busy}>
            Восстановить исходные
          </Button>
        )
      }
    >
      <textarea
        className={`${forms.textarea} ${styles.prompt}`}
        rows={20}
        value={prompt}
        spellCheck={false}
        onChange={(e) => setPrompt(e.target.value)}
      />
      {dirty && (
        <div className={styles.saveBar}>
          <Button variant="secondary" onClick={() => setPrompt(data.prompt)} disabled={busy}>
            Отменить
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save(prompt)}>
            Сохранить
          </Button>
        </div>
      )}
      {leaveDialog}
    </Page>
  )
}
