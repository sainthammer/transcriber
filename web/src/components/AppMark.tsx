/** The app icon (same drawing as favicon.svg). */
export function AppMark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <g stroke="#fff" strokeWidth="2.4" strokeLinecap="round" transform="translate(-1 0)">
        <path d="M8 13v6M12.5 10v12M17 14v4M21.5 11v10M26 15v2" />
      </g>
    </svg>
  )
}
