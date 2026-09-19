import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

await mkdir('tmp', { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
try {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch()
    const body = await response.json() as { conversations: unknown[]; visitorId: string; providers?: unknown }
    await route.fulfill({ response, json: { ...body, providers: { openai: false, gemini: false } } })
  })
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' })
  await page.screenshot({ path: 'tmp/home.png', fullPage: true })
  await page.getByRole('button', { name: /Open text sandbox/ }).click()
  await page.getByLabel('Explore with text while live voice is being connected').fill(
    'I help my dad, Daniel. My sister Nina helps on weekends. Dad needs a ride to Tuesday appointment, and I am exhausted.',
  )
  await page.getByRole('button', { name: 'Send text' }).click()
  await page.getByRole('tab', { name: /Live workspace/ }).click()
  await page.locator('.widget-blue .fact').first().waitFor({ timeout: 10000 })
  await page.screenshot({ path: 'tmp/workspace.png', fullPage: true })
  assert.equal(await page.locator('.transcript-turn').count(), 1)
  assert.equal(await page.locator('.widget').count(), 4)
  await page.locator('.widget-blue .fact-actions button').first().click()
  assert.equal(await page.locator('.transcript-turn.highlighted').count(), 1)
  await page.locator('.widget-blue .fact-actions button').last().click()
  await page.getByLabel('Correct Person mentioned').fill('My sister Nina cannot help on weekends.')
  await page.getByRole('button', { name: 'Save correction' }).click()
  await page.getByText('My sister Nina cannot help on weekends.', { exact: true }).waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Conversations' }).click()
  await page.locator('.history-list button').first().click()
  await page.getByRole('tab', { name: /Live workspace/ }).click()
  await page.getByText('My sister Nina cannot help on weekends.', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'End conversation' }).click()
  await page.getByText('Conversation saved', { exact: true }).first().waitFor()
  await page.getByRole('tab', { name: /Live workspace/ }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'tmp/mobile.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true)
  await page.getByRole('button', { name: 'Back home' }).click()
  await page.getByRole('button', { name: 'Explore a fictional sample conversation' }).click()
  await page.getByText('Corrected to Thursday; the earlier Tuesday date was mistaken.').waitFor()
  assert.equal(await page.locator('.widget').count(), 4)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: 'tmp/sample.png', fullPage: true })
  console.log('Browser smoke passed')
} finally { await browser.close() }
