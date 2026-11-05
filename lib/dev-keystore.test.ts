import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { GET } from "../app/api/dev/keystore/route"
import { clearLegacyDevKeys } from "./dev-keystore"

test("keystore HTTP export is retired regardless of Host, origin, fetch metadata or old flags", async () => {
  const previous = process.env
  process.env = { ...previous }
  try {
    for (const mode of ["development", "production", "test"]) {
      Object.assign(process.env, { NODE_ENV: mode, ENABLE_DEV_KEYSTORE: "true", NEXT_PUBLIC_ENABLE_DEV_KEYSTORE: "true" })
      const variants: Record<string, string>[] = [{}, { Host: "localhost", "sec-fetch-site": "same-origin", Origin: "http://localhost" }, { Host: "127.0.0.1", "sec-fetch-site": "cross-site", Origin: "https://remote.example" }]
      for (const headers of variants) {
        const response = await GET(new Request("http://localhost/api/dev/keystore", { headers }))
        assert.equal(response.status, 410)
        assert.equal(response.headers.get("cache-control"), "no-store")
        const body = await response.json()
        assert.deepEqual(body.accounts, [])
        assert.match(body.error, /已停用/)
        for (const field of ["privateKey", "secretKey", "suiprivkey"]) assert.equal(JSON.stringify(body).includes(field), false)
      }
    }
  } finally { process.env = previous }
})

test("the retired route cannot read the host filesystem or instantiate keystore keypairs", () => {
  const source = readFileSync(new URL("../app/api/dev/keystore/route.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /^import\s/m)
  assert.doesNotMatch(source, /readFile|homedir|getSecretKey|fromSecretKey/)
})

test("legacy key cleanup removes secrets without reading values or deleting account and receipt recovery metadata", () => {
  const stored = new Map([
    ["sui_dev_accounts", "synthetic-private-account-list"],
    ["sui_active_dev_privkey", "synthetic-retired-key"],
    ["sui_active_account", JSON.stringify({ type: "keystore", address: "0x1" })],
    ["sui_pending_tx_fixture", "public-receipt"],
  ])
  const storage = {
    getItem: () => assert.fail("Cleanup must never read a secret"),
    setItem: () => assert.fail("Cleanup must never persist a secret"),
    removeItem: (key: string) => { stored.delete(key) },
  }
  clearLegacyDevKeys(storage)
  clearLegacyDevKeys(storage)
  assert.deepEqual([...stored.keys()], ["sui_active_account", "sui_pending_tx_fixture"])
})

test("cleanup attempts both legacy keys even if storage is blocked", () => {
  const attempts: string[] = []
  assert.doesNotThrow(() => clearLegacyDevKeys({ removeItem(key) { attempts.push(key); throw new Error("Storage blocked") } }))
  assert.deepEqual(attempts, ["sui_dev_accounts", "sui_active_dev_privkey"])
})
