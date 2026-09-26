import { expect, test } from '@playwright/test'

/* The demo flow, run three times back to back (CLAUDE.md phase 8). Running it
 * repeatedly is the point: the first pass proves it works, the second and third
 * prove that "Reset demo" really returns the app to its starting state rather
 * than leaving work orders, budget plans or a half-finished tour behind. */

async function openDemoControls(page: import('@playwright/test').Page) {
  await page.goto('/command?demo=1')
  await page.getByRole('button', { name: 'Show demo controls' }).click()
  await expect(page.getByRole('button', { name: 'Reset demo' })).toBeVisible()
}

test.describe('demo flow', () => {
  // The engineer console is a desktop screen: below 1024px the priority rails
  // collapse behind a toggle and the presenter remote is not how anyone would
  // drive a phone. The driver routes are covered in routes.spec.ts at 390px.
  test.beforeEach(({ viewport }) => {
    test.skip(
      (viewport?.width ?? 0) < 1024,
      'Engineer console flow is desktop-only',
    )
  })

  test('runs start to finish three times without errors', async ({ page }) => {
    // Three full passes over a 1,108-segment map; the default 30s is not enough
    // when the suite runs its workers in parallel.
    test.slow()

    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))

    for (let run = 1; run <= 3; run++) {
      await openDemoControls(page)

      // The map and its overlays are up.
      await expect(page.getByLabel('City statistics')).toBeVisible()

      // A drive puts bumps on the map and into the feed.
      await page.getByRole('button', { name: 'Simulate drive' }).click()
      await expect(
        page.getByText('Simulating a drive', { exact: false }),
      ).toBeVisible()

      // The city can be projected forward and brought back.
      await page.getByRole('button', { name: /Fast-forward 30 days/ }).click()
      await expect(
        page.getByRole('button', { name: /back to today/ }),
      ).toBeVisible()

      // A repair gets verified, which moves a card and updates the KPI.
      await page.getByRole('button', { name: 'Verify a repair' }).click()
      await expect(page).toHaveURL(/work-orders/)
      await expect(page.getByRole('heading', { name: 'Work orders' })).toBeVisible()

      // And reset puts everything back.
      await page.getByRole('button', { name: 'Reset demo' }).click()
      await expect(page.getByText('Demo reset')).toBeVisible()

      expect(errors, `console errors on demo run ${run}`).toEqual([])
    }
  })

  test('the segment drawer deep-links and closes', async ({ page }) => {
    await page.goto('/command')

    const firstPriority = page
      .getByLabel('Fix these first')
      .getByRole('button')
      .first()
    await firstPriority.click()

    await expect(page).toHaveURL(/segment=\d+/)
    const drawer = page.getByLabel(/^Segment /)
    await expect(drawer).toBeVisible()

    // The same URL brings the drawer back after a reload. A cold load refetches
    // the road network and re-simulates 1,108 segments before the drawer can
    // render, so this needs more than the default timeout.
    const url = page.url()
    await page.reload()
    await expect(page.getByLabel(/^Segment /)).toBeVisible({ timeout: 20_000 })
    expect(page.url()).toBe(url)

    await page.getByRole('button', { name: 'Close segment details' }).click()
    await expect(page).not.toHaveURL(/segment=/)
  })

  test('work orders survive a reload', async ({ page }) => {
    await page.goto('/work-orders')
    const open = page.getByLabel('Open', { exact: true })
    await expect(open).toBeVisible()

    const card = open.getByRole('listitem').first()
    const id = await card.getByText(/^WO-/).first().innerText()

    await card.getByRole('button', { name: /Move .* right/ }).click()
    await expect(
      page.getByLabel('In progress').getByText(id, { exact: true }),
    ).toBeVisible()

    await page.reload()
    await expect(
      page.getByLabel('In progress').getByText(id, { exact: true }),
    ).toBeVisible()
  })
})
