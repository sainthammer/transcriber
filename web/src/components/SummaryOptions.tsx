import { useId } from 'react'
import { ChevronDown, ShieldCheck } from 'lucide-react'
import type { Config, Provider, SummaryTypeChoice } from '../api/types'
import { capitalize } from '../lib/format'
import { joinOr, PRIVATE_TYPES, providerReason } from '../lib/providers'
import { useAuth } from '../state/authContext'
import styles from './forms.module.css'

interface Props {
  config: Config
  provider: Provider
  onProvider: (p: Provider) => void
  summaryType: SummaryTypeChoice
  onSummaryType: (t: SummaryTypeChoice) => void
}

export function SummaryOptions({
  config,
  provider,
  onProvider,
  summaryType,
  onSummaryType,
}: Props) {
  const id = useId()
  const { isAdmin } = useAuth()
  const { deepseek, ollama } = config.providers
  const type = config.summary_types.find((t) => t.id === summaryType)
  const builtin = config.summary_types.filter((t) => t.builtin !== false)
  const custom = config.summary_types.filter((t) => t.builtin === false)
  const option = (t: (typeof builtin)[number]) => (
    <option key={t.id} value={t.id}>
      {t.label}
    </option>
  )

  const choices: { value: Provider; label: string; available: boolean }[] = [
    {
      value: 'auto',
      label: 'Авто',
      available: deepseek.available || ollama.available,
    },
    { value: 'ollama', label: 'Локально', available: ollama.available },
    { value: 'deepseek', label: 'DeepSeek', available: deepseek.available },
  ]

  const explanation = {
    auto: 'Локально, если запись не очень большая, иначе DeepSeek.',
    ollama: `Качество ниже, но запись никуда не уходит.`,
    deepseek: 'Точнее, но запись отправляется на серверы DeepSeek.',
  }[provider]

  const reasons = [
    ['ollama', providerReason('ollama', ollama, isAdmin)],
    ['deepseek', providerReason('deepseek', deepseek, isAdmin)],
  ].filter(([, r]) => r) as [string, string][]

  const privateHint =
    provider === 'deepseek' && PRIVATE_TYPES.includes(summaryType)

  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-type`}>
          Тип записи
        </label>
        <div className={styles.selectWrap}>
          <select
            id={`${id}-type`}
            className={styles.select}
            value={summaryType}
            onChange={(e) => onSummaryType(e.target.value as SummaryTypeChoice)}
            aria-describedby={`${id}-type-hint`}
          >
            <option value="auto">Определить автоматически</option>
            {custom.length > 0 ? (
              <>
                <optgroup label="Стандартные">{builtin.map(option)}</optgroup>
                <optgroup label="Свои">{custom.map(option)}</optgroup>
              </>
            ) : (
              builtin.map(option)
            )}
          </select>
          <ChevronDown
            className={styles.selectIcon}
            size={16}
            strokeWidth={2}
            aria-hidden
          />
        </div>
        <p className={styles.hint} id={`${id}-type-hint`}>
          {type
            ? `${capitalize(type.description)}.`
            : `Модель сама поймёт, что это: ${joinOr(config.summary_types.map((t) => t.label.toLowerCase()))}.`}
        </p>
      </div>

      <fieldset className={styles.field}>
        <legend className={styles.label}>Как делать итог</legend>
        <div className={styles.segmented}>
          {choices.map((c) => (
            <label
              key={c.value}
              className={styles.segment}
              data-disabled={!c.available || undefined}
            >
              <input
                type="radio"
                className="visually-hidden"
                name={`${id}-provider`}
                value={c.value}
                checked={provider === c.value}
                disabled={!c.available}
                onChange={() => onProvider(c.value)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
        <p className={styles.hint} aria-live="polite">
          {explanation}
        </p>
        {privateHint && (
          <p className={styles.note}>
            <ShieldCheck size={16} strokeWidth={1.75} aria-hidden />
            Разговор личный — локальная модель не отправляет запись на сторонние
            серверы.
          </p>
        )}
        {reasons.map(([name, reason]) => (
          <p key={name} className={styles.unavailable}>
            {reason}
          </p>
        ))}
      </fieldset>
    </>
  )
}
