// Screenshots for visual review: every page × width × color scheme.
//   npm run screenshots -- [--base=http://localhost:5173] [--widths=375,1280] [--schemes=dark] name=/path ...
//   --admin-fixtures: answer /api/* from scripts/admin-fixtures.mjs (admin pages without a backend)
//   --click=<selector>: click it before the shot (open a menu or a dialog); may be repeated
// Output: .screenshots/<name>-<width>-<scheme>.png
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { installAdminFixtures } from './admin-fixtures.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const base = opt('base', 'http://localhost:5173')
const widths = opt('widths', '375,768,1280,1920').split(',').map(Number)
const schemes = opt('schemes', 'light,dark').split(',')
const wait = Number(opt('wait', '1200'))
const full = args.includes('--full')
const scrollTo = opt('scrollTo', null) // CSS selector to scroll to the top of the view
const suffix = opt('suffix', '')
const clicks = args.filter((a) => a.startsWith('--click=')).map((a) => a.slice('--click='.length))
const adminFixtures = args.includes('--admin-fixtures')
const pages = args.filter((a) => !a.startsWith('--')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)])
const heights = { 375: 812, 768: 1024, 1280: 800, 1920: 1080 }

await mkdir('.screenshots', { recursive: true })
const browser = await chromium.launch()
for (const scheme of schemes) {
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: heights[width] ?? 900 },
      colorScheme: scheme,
      deviceScaleFactor: 1,
    })
    if (adminFixtures) await installAdminFixtures(context)
    for (const [name, path] of pages) {
      const page = await context.newPage()
      page.on('console', (m) => m.type() === 'error' && console.log(`  console error [${name}]: ${m.text()}`))
      page.on('pageerror', (e) => console.log(`  page error [${name}]: ${e.message}`))
      await page.goto(base + path)
      await page.waitForTimeout(wait)
      for (const selector of clicks) {
        await page.click(selector)
        await page.waitForTimeout(400)
      }
      if (scrollTo) {
        await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), scrollTo)
        await page.waitForTimeout(400)
      }
      const file = `.screenshots/${name}${suffix}-${width}-${scheme}.png`
      await page.screenshot({ path: file, fullPage: full })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      console.log(file + (overflow ? '  ⚠ horizontal overflow' : ''))
      await page.close()
    }
    await context.close()
  }
}
await browser.close()
