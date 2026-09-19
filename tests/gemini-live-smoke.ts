import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const context = await browser.newContext({ permissions: ['microphone'] })
const page = await context.newPage()
page.on('console', message => { if (message.type() === 'error') console.error('Browser:', message.text()) })
try {
  await page.goto(process.env.HARBOR_URL || 'http://localhost:3000/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Start a conversation/ }).click()
  await page.getByText('Live conversation', { exact: true }).waitFor({ timeout: 30000 })
  console.log('Gemini Live connected')
  await page.getByRole('button', { name: 'End conversation' }).click()
  await page.getByText('Conversation saved', { exact: true }).first().waitFor({ timeout: 15000 })
  console.log('Gemini Live ended and saved')
} finally { await browser.close() }
