import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button, IconButton } from '../components/ui/Button'
import { Field } from '../components/ui/Field'
import { slug } from './slug'
import forms from '../components/forms.module.css'
import styles from './SectionsEditor.module.css'

export const MAX_SECTIONS = 12

export interface DraftSection {
  uid: string
  key: string
  title: string
  description: string
  /** The key was typed by hand: stop deriving it from the title. */
  keyTouched: boolean
}

export type SectionErrors = Record<string, Partial<Record<'key' | 'title', string>>>

let seq = 0
export const newSection = (s?: { key: string; title: string; description: string }): DraftSection => ({
  uid: `s${++seq}`,
  key: s?.key ?? '',
  title: s?.title ?? '',
  description: s?.description ?? '',
  keyTouched: !!s,
})

interface Props {
  sections: DraftSection[]
  onChange: (sections: DraftSection[]) => void
  errors: SectionErrors
  /** Existing type: renaming a key orphans it in summaries made before. */
  existing: boolean
}

export function SectionsEditor({ sections, onChange, errors, existing }: Props) {
  const update = (uid: string, patch: Partial<DraftSection>) =>
    onChange(sections.map((s) => (s.uid === uid ? { ...s, ...patch } : s)))

  const move = (index: number, delta: -1 | 1) => {
    const next = [...sections]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item)
    onChange(next)
    // Keep focus on the arrow that was pressed; at the edge, on the other arrow.
    const to = index + delta
    const edge = delta === -1 ? to === 0 : to === next.length - 1
    requestAnimationFrame(() =>
      document.getElementById(`${item.uid}-${edge ? (delta === -1 ? 'down' : 'up') : delta === -1 ? 'up' : 'down'}`)?.focus(),
    )
  }

  const remove = (index: number) => {
    const next = sections.filter((_, i) => i !== index)
    onChange(next)
    const neighbour = next[Math.min(index, next.length - 1)]
    requestAnimationFrame(() => neighbour && document.getElementById(`${neighbour.uid}-title`)?.focus())
  }

  const add = () => {
    const s = newSection()
    onChange([...sections, s])
    requestAnimationFrame(() => document.getElementById(`${s.uid}-title`)?.focus())
  }

  return (
    <div className={styles.editor}>
      <ol className={styles.list}>
        {sections.map((s, i) => {
          const e = errors[s.uid] ?? {}
          return (
            <li key={s.uid} className={styles.card}>
              <div className={styles.head}>
                <span className={styles.number}>Раздел {i + 1}</span>
                <span className={styles.tools}>
                  <IconButton
                    id={`${s.uid}-up`}
                    label="Выше"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={18} strokeWidth={1.75} />
                  </IconButton>
                  <IconButton
                    id={`${s.uid}-down`}
                    label="Ниже"
                    disabled={i === sections.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={18} strokeWidth={1.75} />
                  </IconButton>
                  <IconButton
                    label={sections.length === 1 ? 'Нужен хотя бы один раздел' : 'Удалить раздел'}
                    disabled={sections.length === 1}
                    onClick={() => remove(i)}
                    className={styles.delete}
                  >
                    <Trash2 size={18} strokeWidth={1.75} />
                  </IconButton>
                </span>
              </div>
              <div className={styles.fields}>
                <Field label="Заголовок" error={e.title} className={styles.title}>
                  <input
                    id={`${s.uid}-title`}
                    className={forms.input}
                    value={s.title}
                    placeholder="Например, «Что улучшить»"
                    onChange={(ev) => {
                      const title = ev.target.value
                      update(s.uid, s.keyTouched ? { title } : { title, key: slug(title) })
                    }}
                  />
                </Field>
                <Field label="Ключ" error={e.key} className={styles.key}>
                  <input
                    id={`${s.uid}-key`}
                    className={`${forms.input} ${forms.mono}`}
                    value={s.key}
                    placeholder="to_improve"
                    spellCheck={false}
                    autoCapitalize="off"
                    maxLength={32}
                    onChange={(ev) => update(s.uid, { key: ev.target.value, keyTouched: true })}
                  />
                </Field>
                <Field label="Что сюда писать" className={styles.description}>
                  <textarea
                    className={forms.textarea}
                    rows={2}
                    value={s.description}
                    placeholder="Например: что мешало работать и что команда хочет изменить в следующем спринте"
                    onChange={(ev) => update(s.uid, { description: ev.target.value })}
                  />
                </Field>
              </div>
            </li>
          )
        })}
      </ol>
      <div className={styles.footer}>
        <Button
          variant="secondary"
          icon={<Plus size={18} strokeWidth={2} />}
          onClick={add}
          disabled={sections.length >= MAX_SECTIONS}
        >
          Добавить раздел
        </Button>
        <p className={forms.hint}>
          {sections.length >= MAX_SECTIONS
            ? `Больше ${MAX_SECTIONS} разделов не получится.`
            : `Ключ — имя поля в ответе модели: латиница, цифры и «_».${existing ? ' Если переименовать ключ, в готовых итогах старый раздел покажется в конце под прежним ключом.' : ''}`}
        </p>
      </div>
    </div>
  )
}
