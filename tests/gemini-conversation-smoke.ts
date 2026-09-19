import { resolve } from 'node:path'
import { chromium } from 'playwright'

const audioFile = resolve('tmp/fictional-call.wav')
const browser = await chromium.launch({ headless: true, args: [
  '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${audioFile}`,
] })
const context = await browser.newContext({ permissions: ['microphone'] })
const page = await context.newPage()
await page.addInitScript(() => {
  const original = WebSocket.prototype.send
  ;(window as Window & { __audioBytes?: number }).__audioBytes = 0
  WebSocket.prototype.send = function (data) {
    if (data instanceof ArrayBuffer) (window as Window & { __audioBytes?: number }).__audioBytes! += data.byteLength
    return original.call(this, data)
  }
})
try {
  await page.goto(process.env.HARBOR_URL || 'http://localhost:3000/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Start a conversation/ }).click()
  await page.getByText('Live conversation', { exact: true }).waitFor({ timeout: 30000 })
  await page.getByRole('tab', { name: /Live workspace/ }).click()
  await page.locator('.transcript-turn.user').first().waitFor({ timeout: 25000 }).catch(async () => {
    console.log('Audio bytes sent:', await page.evaluate(() => (window as Window & { __audioBytes?: number }).__audioBytes))
    console.log('Visible page:', (await page.locator('body').innerText()).slice(-600))
    throw new Error('No user transcript after 25 seconds')
  })
  await page.locator('.widget .fact').first().waitFor({ timeout: 30000 })
  console.log('Gemini Live transcript:', (await page.locator('.transcript-turn.user').first().innerText()).slice(0, 250))
  console.log('Widget facts:', await page.locator('.widget .fact').count())
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'End conversation' }).click()
  await page.getByText('Conversation saved', { exact: true }).first().waitFor({ timeout: 15000 })
} finally { await browser.close() }
