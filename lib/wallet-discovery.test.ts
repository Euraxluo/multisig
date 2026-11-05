import assert from "node:assert/strict"
import { test } from "node:test"
import { connectWalletProvider, discoverWalletProviders, type RegisteredWallet, type SuiWalletFeatures } from "./wallet-discovery"

const address = `0x${"1".repeat(64)}`
/** The account fields the Wallet Standard requires beyond `address`/`chains`. */
const accountFields = { publicKey: new Uint8Array(32), features: [] }
const account = (accountAddress: string, chains: `${string}:${string}`[]) => ({ address: accountAddress, chains, ...accountFields })

/**
 * A wallet fixture shaped like a real Wallet Standard registration.
 *
 * `connect` is replaced by reassigning the whole feature object rather than
 * mutating it: the standard declares features readonly, and a test that mutates
 * them would stop compiling the day a wallet stops being a plain object.
 */
function wallet(name: string, overrides: Partial<RegisteredWallet> = {}): RegisteredWallet {
  return {
    name,
    chains: ["sui:testnet"],
    accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account(address, ["sui:testnet"])] }) },
      "sui:signTransaction": { version: "2.0.0", signTransaction: async () => ({ bytes: "", signature: "" }) },
    },
    ...overrides,
  }
}

/** Replaces one feature entry, preserving the rest. */
function withFeature(base: RegisteredWallet, feature: string, value: unknown): RegisteredWallet {
  return { ...base, features: { ...base.features, [feature]: value } as SuiWalletFeatures }
}

test("deduplicates repeated OKX registrations and aliases in one provider row", () => {
  const first = wallet("OKX Wallet")
  const providers = discoverWalletProviders([first, first, wallet(" OKX Wallet "), wallet("OKX"), wallet("Slush")])
  assert.equal(providers.length, 2)
  assert.equal(providers[0].id, "okx")
  assert.equal(providers[0].wallets.length, 3)
})

test("rejects connect-only and unrelated-chain registrations", () => {
  assert.deepEqual(discoverWalletProviders([
    wallet("MetaMask", { chains: ["eip155:1"] }),
    wallet("OKX Wallet", { chains: ["solana:mainnet"] }),
    withFeature(wallet("Sui looking name"), "sui:signTransaction", undefined),
    wallet("Mainnet only", { chains: ["sui:mainnet"] }),
  ]), [])
})

test("connects an explicitly Sui testnet account without choosing a multichain address", async () => {
  const selected = withFeature(wallet("OKX Wallet"), "standard:connect", {
    version: "1.0.0",
    connect: async () => ({ accounts: [
      account(`0x${"2".repeat(64)}`, ["solana:mainnet"]),
      account(address, ["sui:testnet"]),
    ] }),
  })
  const result = await connectWalletProvider(discoverWalletProviders([selected])[0])
  assert.equal(result.account.address, address)
  assert.equal(result.wallet, selected)
})

test("keeps compatible duplicates available when the first yields another chain", async () => {
  const first = withFeature(wallet("OKX"), "standard:connect", {
    version: "1.0.0",
    connect: async () => ({ accounts: [account(address, ["eip155:1"])] }),
  })
  const second = wallet("OKX Wallet")
  const result = await connectWalletProvider(discoverWalletProviders([first, second])[0])
  assert.equal(result.wallet, second)
})

test("does not prompt another registration after connection rejection", async () => {
  let calls = 0
  const first = withFeature(wallet("OKX"), "standard:connect", {
    version: "1.0.0",
    connect: async () => { throw new Error("User rejected") },
  })
  const second = withFeature(wallet("OKX Wallet"), "standard:connect", {
    version: "1.0.0",
    connect: async () => { calls++; return { accounts: [] } },
  })
  await assert.rejects(connectWalletProvider(discoverWalletProviders([first, second])[0]), /User rejected/)
  assert.equal(calls, 0)
})
