import { urls } from '../api/client'

/**
 * Rich HTML from the rendered summary (so it pastes nicely into mail and docs) plus the
 * server's Markdown as plain text — the same format as the downloaded summary.md.
 */
function summaryHtml(article: HTMLElement): string {
  const clone = article.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[data-copy-skip], .visually-hidden').forEach((el) => el.remove())
  clone.querySelectorAll('button').forEach((button) => {
    const code = document.createElement('code')
    code.textContent = button.textContent
    button.replaceWith(code)
  })
  clone.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name !== 'href') el.removeAttribute(attr.name)
    }
  })
  return `<meta charset="utf-8">${clone.innerHTML}`
}

async function markdown(jobId: string): Promise<string> {
  const res = await fetch(urls.download(jobId, 'summary.md'))
  if (!res.ok) throw new Error('summary.md недоступен')
  return res.text()
}

export async function copySummary(article: HTMLElement, jobId: string): Promise<void> {
  const html = summaryHtml(article)
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      // Blobs as promises keep Safari's user-gesture requirement satisfied.
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': markdown(jobId).then((t) => new Blob([t], { type: 'text/plain' })),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ])
      return
    } catch {
      // fall through to plain text
    }
  }
  await navigator.clipboard.writeText(await markdown(jobId))
}
