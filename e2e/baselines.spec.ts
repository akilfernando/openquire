import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { openReport } from './fixtures'

for (const width of [1440, 390]) test(`workspace accessibility baseline ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 })
  await openReport(page)
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const evidence = { browser: page.context().browser()?.version(), width, violations: result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(n => n.target) })) }
  console.log(JSON.stringify(evidence))
  await info.attach('accessibility-baseline.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id)).toEqual([])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
