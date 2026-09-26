import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import type { Config } from '../api/types'
import { useAuth } from '../state/authContext'
import { SummaryOptions } from '../components/SummaryOptions'
import { Button } from '../components/ui/Button'
import { Sheet } from '../components/ui/Sheet'
import forms from '../components/forms.module.css'
import { InstructionsField } from './InstructionsField'
import { useSummaryForm } from './useSummaryForm'
import type { SummaryFormInit } from './useSummaryForm'

interface Props {
  jobId: string
  config: Config | null
  /** Values to start from; the dialog resets to them every time it opens. */
  init: SummaryFormInit | null
  onClose: () => void
  onRequested: (instructions: string) => void
}

/** A new version of a ready summary: type, model and what to change. */
export function RegenerateDialog({ jobId, config, init, onClose, onRequested }: Props) {
  const { isAdmin } = useAuth()
  const open = init !== null
  const form = useSummaryForm(jobId, config, init ?? { provider: 'auto', summaryType: 'auto' }, (wishes) => {
    onRequested(wishes)
    onClose()
  })

  // Reset to fresh values on each opening (render-time state adjustment, no effect needed).
  const [lastInit, setLastInit] = useState(init)
  if (init !== lastInit) {
    setLastInit(init)
    if (init) form.reset(init)
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !form.busy && onClose()}
      title="Пересобрать итог"
      description="Текущая версия сохранится — к ней можно будет вернуться."
      onSubmit={() => void form.submit()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" loading={form.busy} disabled={!form.provider}>
            Пересобрать
          </Button>
        </>
      }
    >
      {config && form.provider ? (
        <>
          <SummaryOptions
            config={config}
            provider={form.provider}
            onProvider={form.setProvider}
            summaryType={form.summaryType}
            onSummaryType={form.setSummaryType}
          />
          <InstructionsField
            value={form.instructions}
            onChange={form.setInstructions}
            error={form.instructionsError}
          />
        </>
      ) : (
        config && (
          <p className={forms.hint}>
            {isAdmin
              ? 'Нет доступной модели — добавьте ключ DeepSeek или проверьте Ollama в разделе «Модели и ключи».'
              : 'Нет доступной модели — сообщите администратору.'}
          </p>
        )
      )}
      {form.error && (
        <p className={forms.alert} role="alert">
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
          <span>{form.error}</span>
        </p>
      )}
    </Sheet>
  )
}
