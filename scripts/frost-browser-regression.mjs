import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// Real Chromium IndexedDB acceptance on an ephemeral local origin. This does not
// exercise a deployed transport, an extension wallet, or any chain transaction.
const require = createRequire(new URL("../package.json", import.meta.url))
const { build } = createRequire(require.resolve("tsx"))("esbuild")
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./frost-browser-fixture.ts", import.meta.url))],
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022",
  define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
})
const script = bundled.outputFiles[0].contents
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script)
  } else {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end('<!doctype html><meta charset="utf-8"><title>Local FROST acceptance</title><p>Local browser persistence acceptance</p><script src="/fixture.js"></script>')
  }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch()
const reports = []

async function run(page, action, input) {
  const result = await page.evaluate(({ action, input }) => window.frostBrowser.run(action, input), { action, input })
  assert.equal(result.ok, true, `${action}: ${JSON.stringify(result)}`)
  return result.counts
}
async function scenario(name, task) {
  const context = await browser.newContext()
  const errors = []
  context.on("page", page => page.on("pageerror", () => errors.push("uncaught-browser-error")))
  try {
    const keeper = await context.newPage()
    await keeper.goto(url)
    await keeper.waitForFunction(() => Boolean(window.frostBrowser), { timeout: 10_000 }).catch(() => { throw new Error(`Browser fixture startup failed: ${errors.join("; ")}`) })
    await run(keeper, "initialize")
    const tab = async () => {
      const popup = keeper.waitForEvent("popup")
      await keeper.evaluate(url => { window.open(url) }, url)
      const page = await popup
      await page.waitForFunction(() => Boolean(window.frostBrowser))
      return page
    }
    const first = await tab(), second = await tab()
    const prepare = async () => {
      await run(first, "prepare", { participant: 0 })
      await run(second, "prepare", { participant: 1 })
      await run(first, "transcript")
    }
    const counts = await task({ keeper, first, second, tab, prepare })
    assert.deepEqual(errors, [], `${name}: uncaught browser errors`)
    reports.push({ name, passed: true, counts })
  } finally { await context.close() }
}

try {
  await scenario("reload-and-page-recreation-restore-authenticated-public-progress", async ({ first, second, tab, prepare }) => {
    await prepare()
    await run(first, "produce", { participant: 0 })
    await run(second, "produce", { participant: 1 })
    await run(first, "rememberComplete")
    await first.reload()
    const reload = await run(first, "restoreAggregate")
    assert.equal(reload.additionalSignatures, 0)
    await first.close()
    const replacement = await tab()
    const counts = await run(replacement, "restoreAggregate")
    assert.equal(counts.ed25519Verified, 1)
    return { ...counts, reloads: 1, recreatedPages: 1 }
  })
  await scenario("recreated-page-recovers-expired-original-receipt-without-new-signing", async ({ first, second, tab, prepare }) => {
    await prepare()
    await run(first, "produce", { participant: 0 })
    await run(second, "produce", { participant: 1 })
    await run(first, "seedReceipt")
    await first.close()
    const replacement = await tab()
    const counts = await run(replacement, "recoverReceipt")
    assert.equal(counts.additionalSignatures, 0)
    assert.equal(counts.originalDigestsResumed, 1)
    assert.equal(counts.acknowledgedReceipts, 1)
    return { ...counts, recreatedPages: 1 }
  })
  await scenario("cached-round-two-after-reload-never-signs-again", async ({ first, second, prepare }) => {
    await prepare()
    await run(first, "produce", { participant: 0 })
    await run(second, "produce", { participant: 1 })
    await first.reload(); await second.reload()
    const a = await run(first, "cached", { participant: 0 })
    const b = await run(second, "cached", { participant: 1 })
    assert.equal(a.additionalSignatures + b.additionalSignatures, 0)
    return { cachedDevices: 2, usableNonceRecords: a.usableNonceRecords + b.usableNonceRecords, additionalSignatures: 0 }
  })
  await scenario("two-tabs-atomically-consume-one-nonce-and-recovery-cannot-revive-it", async ({ first, second, prepare }) => {
    await prepare()
    const race = await Promise.all([run(first, "raceConsume"), run(second, "raceConsume")])
    assert.equal(race.reduce((sum, result) => sum + result.freshConsumers, 0), 1)
    assert.equal(race.reduce((sum, result) => sum + result.rejectedConsumers, 0), 1)
    await first.reload()
    const recovered = await run(first, "recoverBurned")
    return { ...recovered, freshConsumers: 1, rejectedConsumers: 1, independentTabs: 2 }
  })
  await scenario("consumed-nonce-rejects-another-authenticated-transcript", async ({ first, prepare }) => {
    await prepare()
    await run(first, "produce", { participant: 0 })
    await run(first, "alternate")
    await first.reload()
    return run(first, "rejectAlternate")
  })
  await scenario("persisted-tampering-and-missing-transcript-rejected", async ({ first, second, prepare }) => {
    await prepare()
    await run(first, "produce", { participant: 0 })
    await run(second, "produce", { participant: 1 })
    return run(first, "tamperRecovery")
  })
  await scenario("injected-factory-denial-surfaces-before-signing", ({ first }) => run(first, "failedOpen"))
  await scenario("real-closed-idb-connection-surfaces-before-signing", ({ first }) => run(first, "closedConnection"))
  await scenario("injected-real-transaction-abort-rolls-back-and-surfaces-before-signing", async ({ first, prepare }) => {
    await prepare()
    return run(first, "abortWrite")
  })
  console.log(JSON.stringify({ scope: "LOCAL browser persistence; no network E2E or wallet transactions", passed: reports.length, reports }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
