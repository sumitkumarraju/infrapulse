import { expect, test } from '@playwright/test'

/* One screenshot per route at both sizes, plus the check that matters most in
   every phase: the page rendered something and the console stayed clean. */

const ROUTES = [
  { path: '/', name: 'landing' },
  { path: '/styleguide', name: 'styleguide' },
  { path: '/command', name: 'command' },
  { path: '/forecast', name: 'forecast' },
  { path: '/budget', name: 'budget' },
  { path: '/work-orders', name: 'work-orders' },
  { path: '/reports', name: 'reports' },
  { path: '/escalations', name: 'escalations' },
  { path: '/app', name: 'driver-home' },
  { path: '/app/trip', name: 'driver-trip' },
  { path: '/app/report', name: 'driver-report' },
  { path: '/app/impact', name: 'driver-impact' },
]

for (const route of ROUTES) {
  test(`${route.name} renders and screenshots`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto(route.path)

    // Fonts settle before capture, otherwise the metric text reflows.
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('#root')).not.toBeEmpty()

    await page.screenshot({
      path: testInfo.outputPath(`${route.name}.png`),
      fullPage: true,
    })
    await testInfo.attach(`${route.name}.png`, {
      path: testInfo.outputPath(`${route.name}.png`),
      contentType: 'image/png',
    })

    expect(errors, `console errors on ${route.path}`).toEqual([])
  })
}

test('styleguide shows the tokens it claims to', async ({ page }) => {
  await page.goto('/styleguide')

  await expect(
    page.getByRole('heading', { name: 'InfraPulse styleguide' }),
  ).toBeVisible()

  for (const section of [
    'Base and surfaces',
    'Accent — cyan',
    'Text',
    'Road health',
    'Typography',
    'Buttons',
    'Badges',
    'Glass',
  ]) {
    await expect(page.getByRole('heading', { name: section })).toBeVisible()
  }

  // The glass panel is a real frosted surface, not a flat box.
  const glass = page.locator('.glass').first()
  await expect(glass).toBeVisible()
  const filter = await glass.evaluate(
    (el) => getComputedStyle(el).backdropFilter,
  )
  expect(filter).toContain('blur')
})

test('the focus ring is visible on keyboard navigation', async ({ page }) => {
  await page.goto('/styleguide')
  await page.keyboard.press('Tab')

  const outline = await page.evaluate(() => {
    const el = document.activeElement
    if (!el) return null
    const s = getComputedStyle(el)
    return { width: s.outlineWidth, style: s.outlineStyle }
  })

  expect(outline?.style).not.toBe('none')
  expect(parseFloat(outline?.width ?? '0')).toBeGreaterThanOrEqual(2)
})
