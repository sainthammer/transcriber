import * as Tooltip from '@radix-ui/react-tooltip'
import { clock, parseStamp } from '../lib/format'
import { phraseAt, truncate } from '../lib/text'
import { useJobContext } from './context'
import styles from './TimeButton.module.css'

/** A summary timestamp: plays the recording from that moment; the tooltip quotes the phrase. */
export function TimeButton({ stamp }: { stamp: string }) {
  const { transcript, long, jump } = useJobContext()
  const t = parseStamp(stamp)
  const label = clock(t, long)
  const index = phraseAt(transcript, t)
  const phrase = index >= 0 ? transcript[index].text : null

  const button = (
    <button
      type="button"
      className={`${styles.time} tabular`}
      onClick={() => jump(t)}
      aria-label={`${label} — слушать с этого места`}
    >
      {label}
    </button>
  )

  if (!phrase) return button
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.tooltip} side="top" sideOffset={6} collisionPadding={12}>
          {truncate(phrase, 180)}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
