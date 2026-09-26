import { expect, test, type Page } from '@playwright/test'

/* Mobile guarantees.
 *
 * The driver app is the half of the product that is actually used on a phone,
 * in a windscreen mount, by someone driving. Two things must hold there and
 * are easy to break without noticing: nothing may push the page sideways, and
 * anything tappable has to be big enough to hit without looking at it.
 *
 * Desktop-only screens are excluded deliberately — the engineer console is a
 * desk tool that merely has to stay usable if it is opened on a phone.
 */

const PHONE_ROUTES = [
  { path: '/app', name: 'driver home' },
  { path: '/app/trip', name: 'trip' },
  { path: '/app/report', name: 'report' },
  { path: '/app/impact', name: 'impact' },
  { path: '/', name: 'landing' },
]

/** Minimum tap target on mobile (UI_DESIGN 7). */
const MIN_TAP_PX = 44

async function overflowing(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    return [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return false

        // A rotated element's bounding rect is its corners swept round, which
        // is wider than the box it actually occupies — the speed gauge is a
        // 160px square reporting 219px. Layout is what decides whether the page
        // scrolls, so transformed elements are not evidence of overflow.
        const own = getComputedStyle(el)
        if (own.transform !== 'none' || own.rotate !== 'none') return false

        // Something scrolling inside its own box is fine; the page moving is not.
        const style = getComputedStyle(el.parentElement ?? el)
        const parentScrolls =
          style.overflowX === 'auto' || style.overflowX === 'scroll'
        return !parentScrolls && (r.right > vw + 1 || r.left < -1)
      })
      .slice(0, 8)
      .map(
        (el) =>
          `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 24)}"`,
      )
  })
}

async function tinyTargets(page: Page) {
  return page.evaluate((min) => {
    return [
      ...document.querySelectorAll('button, a[href], input, [role=button]'),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return false
        if (getComputedStyle(el).visibility === 'hidden') return false
        if (r.height >= min) return false

        // A small checkbox inside a large label is fine: the label is the tap
        // target, and tapping anywhere on it toggles the control.
        const label = el.closest('label')
        if (label && label.getBoundingClientRect().height >= min) return false

        return true
      })
      .slice(0, 10)
      .map(
        (el) =>
          `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 20)}" ${Math.round(el.getBoundingClientRect().height)}px`,
      )
  }, min)
}

const min = MIN_TAP_PX

test.describe('on a phone', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) > 500,
    'Phone-width checks only',
  )

  for (const route of PHONE_ROUTES) {
    test(`${route.name} does not scroll sideways`, async ({ page }) => {
      await page.goto(route.path)
      await page.evaluate(() => document.fonts.ready)
      await expect(page.locator('#root')).not.toBeEmpty()

      // The authoritative check: does the page actually scroll sideways.
      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }))

      // Named offenders, so a failure says which element to look at rather
      // than just that the number is wrong.
      const offenders = await overflowing(page)

      expect(
        scrollW,
        `${route.path} scrolls horizontally${offenders.length ? `; suspects: ${offenders.join(', ')}` : ''}`,
      ).toBeLessThanOrEqual(clientW + 1)
      expect(offenders, `elements past the edge of ${route.path}`).toEqual([])
    })

    test(`${route.name} has thumb-sized controls`, async ({ page }) => {
      await page.goto(route.path)
      await page.evaluate(() => document.fonts.ready)

      const tiny = await tinyTargets(page)
      expect(tiny, `controls under ${MIN_TAP_PX}px on ${route.path}`).toEqual(
        [],
      )
    })
  }

  test('the landing headline fits the screen', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => document.fonts.ready)

    const size = await page
      .locator('h1')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

    // 64px is the desktop display size. On a 390px screen it eats the view.
    expect(size).toBeLessThan(44)
  })
})
