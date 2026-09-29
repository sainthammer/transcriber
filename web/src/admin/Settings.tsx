import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, CircleCheck } from 'lucide-react'
import { admin } from '../api/client'
import type { ApiError } from '../api/client'
import type { AdminSettings, LlmProvider, ProviderTest, SettingItem, SettingKey, SettingsPatch } from '../api/types'
import { Button } from '../components/ui/Button'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { Field } from '../components/ui/Field'
import { PasswordInput } from '../components/ui/PasswordInput'
import { fileSize } from '../lib/format'
import { useToast } from '../state/toastContext'
import { LoadError, Loading, Page, Section } from './Page'
import { useLeaveGuard } from './useLeaveGuard'
import { useResource } from './useResource'
import forms from '../components/forms.module.css'
import styles from './Settings.module.css'

type Group = SettingItem['group']

const GROUPS: { id: Group; title: string; description: string; test?: LlmProvider }[] = [
  {
    id: 'deepseek',
    title: 'DeepSeek',
    description: 'Облачная модель: точнее локальной, но текст расшифровки уходит на серверы DeepSeek. Оплата по токенам.',
    test: 'deepseek',
  },
  {
    id: 'ollama',
    title: 'Ollama',
    description: 'Локальная модель на этом сервере: бесплатно, запись никуда не уходит.',
    test: 'ollama',
  },
  {
    id: 'yandex',
    title: 'YandexGPT',
    description:
      'Облачная модель: текст расшифровки уходит в Yandex Cloud, оплата по токенам. Режим «Авто» её не выбирает — только явно. Ключ и ID каталога — у сервисного аккаунта в консоли Yandex Cloud.',
    test: 'yandex',
  },
  {
    id: 'whisper',
    title: 'Распознавание речи',
    description: 'Работает локально для всех записей.',
  },
]

const SOURCE: Record<SettingItem['source'], string> = {
  db: 'Задано здесь',
  env: 'Из .env',
  default: 'По умолчанию',
}

const asText = (v: SettingItem['value']) => (v === null ? '' : String(v))

/** Numeric settings and their bounds (the server checks them too). */
const NUMBERS: Partial<Record<SettingKey, { min: number; max?: number; step: number }>> = {
  ollama_max_context: { min: 2048, step: 1024 },
  yandex_max_context: { min: 2048, max: 1_000_000, step: 1024 },
}

const isNumber = (i: SettingItem) => typeof i.default === 'number' || i.key in NUMBERS

/** What the value looks like, inside an empty field that has no default to show. */
const PLACEHOLDER: Partial<Record<SettingKey, string>> = {
  deepseek_api_key: 'sk-…',
  yandex_api_key: 'AQVN…',
  yandex_folder_id: 'b1g…',
}

export function Settings() {
  const { data, error, reload, setData } = useResource('settings', admin.settings)
  const [dirtyGroups, setDirtyGroups] = useState<Set<Group>>(new Set())
  const leaveDialog = useLeaveGuard(dirtyGroups.size > 0, 'Изменённые настройки не сохранены.')

  const setDirty = useCallback((group: Group, dirty: boolean) => {
    setDirtyGroups((prev) => {
      if (prev.has(group) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(group)
      else next.delete(group)
      return next
    })
  }, [])

  return (
    <Page
      title="Модели и ключи"
      subtitle="Значения отсюда важнее, чем в .env. «Сбросить» возвращает значение из .env или стандартное."
      width="text"
    >
      {error && !data ? (
        <LoadError error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : (
        GROUPS.map((g) => (
          <GroupForm
            key={g.id}
            group={g}
            settings={data}
            onSaved={setData}
            onDirty={(d) => setDirty(g.id, d)}
          />
        ))
      )}
      {leaveDialog}
    </Page>
  )
}

interface GroupProps {
  group: (typeof GROUPS)[number]
  settings: AdminSettings
  onSaved: (s: AdminSettings) => void
  onDirty: (dirty: boolean) => void
}

function GroupForm({ group, settings, onSaved, onDirty }: GroupProps) {
  const toast = useToast()
  const items = settings.items.filter((i) => i.group === group.id)
  // Secrets start empty: an empty draft means "keep the stored key".
  const initial = () => Object.fromEntries(items.map((i) => [i.key, i.secret ? '' : asText(i.value)]))
  const [draft, setDraft] = useState<Record<string, string>>(initial)
  const [base, setBase] = useState(settings)
  const [errors, setErrors] = useState<Partial<Record<SettingKey | 'form', string>>>({})
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<(ProviderTest & { pending?: boolean }) | null>(null)
  const [replacingKey, setReplacingKey] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<SettingItem | null>(null)

  if (base !== settings) {
    setBase(settings)
    setDraft(initial())
  }

  // The group's fields as the user sees them (their order comes from the server).
  const changed = items.filter((i) => (i.secret ? draft[i.key] !== '' : draft[i.key] !== asText(i.value)))
  const dirty = changed.length > 0
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const put = async (patch: SettingsPatch) => {
    setBusy(true)
    setErrors({})
    try {
      const next = await admin.saveSettings(patch)
      onSaved(next)
      setReplacingKey(false)
      setTest(null)
      return next
    } catch (e) {
      const err = e as ApiError
      const fieldErrors = Object.fromEntries(
        Object.entries(err.fields).filter(([k]) => items.some((i) => i.key === k)),
      )
      setErrors(Object.keys(fieldErrors).length ? fieldErrors : { form: err.message })
      return null
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    const patch: SettingsPatch = {}
    for (const i of changed) {
      const v = draft[i.key].trim()
      patch[i.key] = v === '' ? null : isNumber(i) ? Number(v) : v
    }
    if (await put(patch)) toast('Настройки сохранены')
  }

  const reset = async (item: SettingItem) => {
    const next = await put({ [item.key]: null })
    const now = next?.items.find((i) => i.key === item.key)
    if (!now) return
    if (item.secret) toast(now.value === null ? 'Ключ удалён' : 'Ключ удалён — используется ключ из .env')
    else toast(`${item.label}: ${now.value ?? 'не задано'} (${SOURCE[now.source].toLowerCase()})`)
  }

  const runTest = async () => {
    if (!group.test) return
    setTest({ ok: true, message: '', pending: true })
    try {
      setTest(await admin.testProvider(group.test))
    } catch (e) {
      setTest({ ok: false, message: (e as ApiError).message })
    }
  }

  const set = (key: string, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined }))
  }

  return (
    <Section
      title={group.title}
      description={group.description}
      actions={
        group.test && (
          <Button
            variant="secondary"
            onClick={runTest}
            loading={test?.pending}
            disabled={dirty}
            title={dirty ? 'Сначала сохраните изменения' : undefined}
          >
            Проверить
          </Button>
        )
      }
    >
      {test && !test.pending && (
        <p className={styles.test} data-ok={test.ok || undefined} role="status">
          {test.ok ? (
            <CircleCheck size={16} strokeWidth={1.75} aria-hidden />
          ) : (
            <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
          )}
          <span>{test.message || (test.ok ? 'Работает' : 'Не отвечает')}</span>
        </p>
      )}

      <form
        className={styles.fields}
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty) void save()
        }}
        noValidate
      >
        {items.map((item) => (
          <Field
            key={item.key}
            label={item.label}
            error={errors[item.key]}
            hint={item.help}
            aside={
              <span className={styles.aside}>
                <span className={styles.source} data-source={item.source}>
                  {SOURCE[item.source]}
                </span>
                {item.source === 'db' && !item.secret && (
                  <button type="button" className={styles.reset} onClick={() => void reset(item)} disabled={busy}>
                    Сбросить
                  </button>
                )}
              </span>
            }
          >
            {item.secret ? (
              <SecretControl
                item={item}
                value={draft[item.key]}
                onChange={(v) => set(item.key, v)}
                replacing={replacingKey || item.value === null}
                onReplace={setReplacingKey}
                onDelete={() => setConfirmDelete(item)}
              />
            ) : item.key === 'ollama_model' ? (
              <OllamaModel item={item} settings={settings} value={draft[item.key]} onChange={(v) => set(item.key, v)} />
            ) : item.key === 'whisper_language' ? (
              <Language value={draft[item.key]} onChange={(v) => set(item.key, v)} />
            ) : isNumber(item) ? (
              <input
                className={`${forms.input} ${styles.input}`}
                type="number"
                inputMode="numeric"
                min={NUMBERS[item.key]?.min}
                max={NUMBERS[item.key]?.max}
                step={NUMBERS[item.key]?.step}
                placeholder={item.default === null ? undefined : String(item.default)}
                value={draft[item.key]}
                onChange={(e) => set(item.key, e.target.value)}
              />
            ) : (
              <input
                className={`${forms.input} ${styles.input}`}
                data-mono=""
                type={item.key === 'ollama_host' ? 'url' : 'text'}
                placeholder={item.default === null ? PLACEHOLDER[item.key] : String(item.default)}
                spellCheck={false}
                autoCapitalize="off"
                value={draft[item.key]}
                onChange={(e) => set(item.key, e.target.value)}
              />
            )}
          </Field>
        ))}

        {errors.form && (
          <p className={forms.alert} role="alert">
            <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
            <span>{errors.form}</span>
          </p>
        )}

        {dirty && (
          <div className={styles.saveRow}>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(initial())
                setReplacingKey(false)
                setErrors({})
              }}
              disabled={busy}
            >
              Отменить
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Сохранить
            </Button>
          </div>
        )}
      </form>

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Удалить ключ ${group.title}?`}
        description={
          confirmDelete?.default
            ? 'Будет использоваться ключ из .env.'
            : `Итоги через ${group.title} перестанут работать, пока не добавите новый ключ.`
        }
        confirm="Удалить"
        danger
        onConfirm={async () => {
          const item = confirmDelete
          setConfirmDelete(null)
          if (item) await reset(item)
        }}
      />
    </Section>
  )
}

// --- Controls ---

function SecretControl({
  item,
  value,
  onChange,
  replacing,
  onReplace,
  onDelete,
  ...aria
}: {
  item: SettingItem
  value: string
  onChange: (v: string) => void
  replacing: boolean
  onReplace: (r: boolean) => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  if (replacing) {
    return (
      <div className={styles.secretEdit}>
        <PasswordInput
          {...aria}
          ref={ref}
          className={styles.input}
          data-mono=""
          autoComplete="off"
          placeholder={item.value === null ? PLACEHOLDER[item.key] : 'Новый ключ'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={item.value !== null}
        />
        {item.value !== null && (
          <Button
            variant="plain"
            onClick={() => {
              onChange('')
              onReplace(false)
            }}
          >
            Отмена
          </Button>
        )}
      </div>
    )
  }
  return (
    <div className={styles.secret} {...aria}>
      <code className={styles.mask}>{item.value}</code>
      <span className={styles.secretActions}>
        <Button variant="secondary" onClick={() => onReplace(true)}>
          Заменить
        </Button>
        {item.source === 'db' && (
          <Button variant="danger" onClick={onDelete}>
            Удалить
          </Button>
        )}
      </span>
    </div>
  )
}

function OllamaModel({
  item,
  settings,
  value,
  onChange,
  ...aria
}: {
  item: SettingItem
  settings: AdminSettings
  value: string
  onChange: (v: string) => void
}) {
  const models = settings.ollama_models
  if (!models) {
    return (
      <div className={styles.stack}>
        <input
          {...aria}
          className={`${forms.input} ${styles.input}`}
          data-mono=""
          spellCheck={false}
          autoCapitalize="off"
          placeholder={item.default === null ? 'qwen3.5:4b' : String(item.default)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <p className={styles.unreachable}>
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden />
          <span>
            Ollama не отвечает{settings.ollama_error ? `: ${settings.ollama_error}` : ''}. Список установленных моделей
            появится, когда она заработает, — пока имя можно вписать вручную.
          </span>
        </p>
      </div>
    )
  }
  const known = models.some((m) => m.name === value)
  return (
    <div className={`${forms.selectWrap} ${styles.input}`}>
      <select {...aria} className={forms.select} value={value} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={value}>{value ? `${value} — не установлена` : 'Не выбрана'}</option>}
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name} — {fileSize(m.size_bytes)}
          </option>
        ))}
      </select>
      <ChevronDown className={forms.selectIcon} size={16} strokeWidth={2} aria-hidden />
    </div>
  )
}

const LANGUAGES = [
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'Английский' },
  { value: 'auto', label: 'Определять автоматически' },
]

function Language({ value, onChange, ...aria }: { value: string; onChange: (v: string) => void }) {
  const codeId = useId()
  const preset = LANGUAGES.some((l) => l.value === value)
  const [other, setOther] = useState(!preset && value !== '')
  const codeRef = useRef<HTMLInputElement>(null)
  const selected = other || (!preset && value !== '') ? 'other' : value
  return (
    <div className={styles.language}>
      <div className={`${forms.selectWrap} ${styles.input}`}>
        <select
          {...aria}
          className={forms.select}
          value={selected}
          onChange={(e) => {
            if (e.target.value === 'other') {
              setOther(true)
              requestAnimationFrame(() => codeRef.current?.focus())
            } else {
              setOther(false)
              onChange(e.target.value)
            }
          }}
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
          <option value="other">Другой язык…</option>
        </select>
        <ChevronDown className={forms.selectIcon} size={16} strokeWidth={2} aria-hidden />
      </div>
      {selected === 'other' && (
        <input
          ref={codeRef}
          id={codeId}
          className={`${forms.input} ${styles.code}`}
          data-mono=""
          aria-label="Код языка, например de или uk"
          placeholder="de"
          maxLength={8}
          spellCheck={false}
          autoCapitalize="off"
          value={preset ? '' : value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
        />
      )}
    </div>
  )
}
