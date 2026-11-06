import assert from "node:assert/strict"

// Install Playwright separately or supply an existing module path. No wallet signs or chain writes.
const pw = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const chromium = pw.chromium || pw.default?.chromium
const baseUrl = process.env.UI_BASE_URL || "http://127.0.0.1:3005"
const browser = await chromium.launch()
const viewportWidth = Number(process.env.UI_VIEWPORT_WIDTH || 390)
const reports = []

async function scenario(name, run, fixture, pathname = "") {
  const context = await browser.newContext({ viewport: { width: viewportWidth, height: 844 } })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.stack || error.message))
  if (fixture) await page.addInitScript(fixture)
  try {
    await page.goto(new URL(pathname || "/", baseUrl).toString())
    await run(page)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "phone layout overflow")
    assert.deepEqual(errors, [], `${name}: uncaught browser errors`)
    reports.push({ name, passed: true, errors })
  } catch (error) {
    console.error(JSON.stringify({ name, errors, body: (await page.locator("body").innerText()).slice(-6500) }))
    throw error
  } finally { await context.close() }
}

async function dismiss(page) {
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
}

// Poll a browser-side value without depending on the Playwright test runner.
async function waitForValue(page, read, expected, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let actual
  while (Date.now() < deadline) {
    actual = await page.evaluate(read)
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual
    await page.waitForTimeout(100)
  }
  assert.deepEqual(actual, expected)
  return actual
}

// The Next.js development badge overlaps the left side of this button on narrow screens.
// This is a normal hit-tested click at its uncovered right edge, not a forced click.
const payments = page => page.getByRole("button", { name: "支付", exact: true }).click({ position: { x: 65, y: 8 } })

try {
  await scenario("profile-navigation", async page => {
    await page.getByRole("button", { name: "我的", exact: true }).click()
    await page.getByText("钱包地址与二维码", { exact: true }).waitFor()
    assert.equal(await page.getByRole("heading", { name: "个人活动", exact: true }).count(), 1)
    assert.equal(await page.getByRole("heading", { name: "个人资产", exact: true }).count(), 1)
    // The privacy panel is the only place that states the whole data-flow
    // picture; if it stops rendering, users lose it silently. Since the
    // profile refactor it lives on the /trust page, reached through the
    // "更多 · 信任中心" entry — walk the real user path instead of assuming
    // it renders inline on the profile tab.
    await page.getByRole("link", { name: "信任中心", exact: false }).click()
    await page.getByRole("heading", { name: "数据去向说明", exact: true }).waitFor()
    // The two tone labels are rendered by the same panel on the trust page.
    assert.equal(await page.getByText("链上公开", { exact: true }).count() > 0, true)
    assert.equal(await page.getByText("仅本机", { exact: true }).count() > 0, true)
    await page.goBack()
    // Returning lands on the default tab (tab state is component state, not
    // URL state), so go back to the profile tab explicitly.
    await page.getByRole("button", { name: "我的", exact: true }).click()
    await page.getByText("钱包地址与二维码", { exact: true }).waitFor()
    await page.getByRole("button", { name: "连接你的钱包", exact: false }).click()
    await page.getByRole("menuitem", { name: "连接或切换钱包" }).click()
    await page.locator("#tab-wallet").waitFor()
    await dismiss(page)
    await page.getByRole("button", { name: "群组", exact: true }).first().click()
    await page.getByRole("heading", { name: "我的群组", exact: true }).waitFor()
    await payments(page)
    await page.getByRole("button", { name: "创建账单", exact: true }).click()
    await page.getByRole("dialog").waitFor()
    await dismiss(page)
    await page.getByRole("button", { name: "待办", exact: true }).click()
    await page.getByRole("tab", { name: "投票", exact: true }).click()
  })

  await scenario("wallet-discovery", async page => {
    await page.locator("#btn-nav-wallet").click()
    await page.locator('[data-wallet-provider="okx"]').waitFor()
    assert.equal(await page.locator('[data-wallet-provider="okx"]').count(), 1)
    assert.equal(await page.getByRole("dialog").getByText("OKX Wallet", { exact: true }).count(), 1)
    assert.equal(await page.getByRole("dialog").getByText("MetaMask", { exact: true }).count(), 0)
    assert.equal(await page.locator("#tab-keystore").count(), 0)
    assert.deepEqual(await page.evaluate(() => ["sui_dev_accounts", "sui_active_dev_privkey"].map(key => localStorage.getItem(key))), [null, null])
    await page.locator('[data-wallet-provider="okx"]').click()
    await page.getByRole("alert").getByText("User rejected", { exact: false }).waitFor()
    await page.locator("#tab-passkey").click()
    // Passkey is a real login path now; in headless Chromium without a platform
    // authenticator it must fail closed with a message instead of a fake account.
    assert.equal(await page.locator("#btn-login-passkey").isDisabled(), false)
    assert.equal(await page.getByRole("button", { name: "从本机设备恢复 Passkey", exact: true }).isDisabled(), false)
    assert.equal(await page.getByText("本机已保存的 Passkey 账户", { exact: true }).count(), 0)
    await page.locator("#btn-login-passkey").click()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem("sui_active_account")), null)
    assert.equal(await page.evaluate(() => localStorage.getItem("sui_passkey_credentials_v1")), null)
    await page.locator("#tab-wallet").click()
  }, () => {
    localStorage.setItem("sui_dev_accounts", "synthetic-retired-list")
    localStorage.setItem("sui_active_dev_privkey", "synthetic-retired-key")
    const icon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4="
    const make = (name, chains, sign = true) => ({
      version: "1.0.0", name, icon, chains, accounts: [], features: {
        "standard:connect": { version: "1.0.0", connect: async () => { throw new Error("User rejected") } },
        ...(sign ? { "sui:signTransaction": { version: "2.0.0", signTransaction: async () => { throw new Error("No signing in UI test") } } } : {}),
      },
    })
    window.addEventListener("wallet-standard:app-ready", event => event.detail.register(
      make("OKX Wallet", ["sui:testnet"]), make("OKX Wallet", ["sui:testnet"]), make("OKX Wallet", ["solana:mainnet"]),
      make("MetaMask", ["eip155:1"], false), make("Slush", ["sui:testnet"]),
    ))
  })

  await scenario("payment-tools-and-group-history", async page => {
    await payments(page)
    await page.getByText("周期付款", { exact: true }).click()
    await page.getByRole("heading", { name: "Create Funded Recurring Payment", exact: true }).waitFor()
    await page.getByRole("dialog").getByText("请先连接 Sui testnet 钱包。", { exact: true }).first().waitFor()
    assert.equal(await page.locator("#recipient").count(), 1)
    await dismiss(page)
    await page.getByText("流支付", { exact: true }).click()
    await page.getByRole("heading", { name: "Create Funded Stream Payment", exact: true }).waitFor()
    await page.getByRole("dialog").getByText("请先连接 Sui testnet 钱包。", { exact: true }).first().waitFor()
    assert.equal(await page.getByRole("slider").count(), 1)
    await dismiss(page)
    await page.getByRole("button", { name: "群组", exact: true }).first().click()
    await page.getByRole("button", { name: "查看详情" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("tab", { name: "文件", exact: true }).click()
    await dialog.getByText("历史记录保留验证", { exact: true }).waitFor()
    await dialog.getByText("未核验的历史文件", { exact: true }).waitFor()
    assert.equal(await dialog.getByRole("button", { name: "上传文件", exact: true }).isEnabled(), true)
    await dialog.getByRole("tab", { name: "群聊", exact: true }).click()
    await dialog.getByText("尚未配置链上频道", { exact: true }).waitFor()
    assert.equal(await dialog.getByRole("tab").count(), 8)
    await dialog.getByRole("tab", { name: "收款", exact: true }).click()
    await dialog.getByText("组织金库", { exact: true }).waitFor()
    await dialog.getByRole("button", { name: "创建组织金库", exact: true }).click()
    await dialog.getByRole("alert").getByText("请先创建并核验链上组织。", { exact: true }).waitFor()
    // The AI tab is a real chain view now: without a verified org it must say so
    // rather than list an invented assistant.
    await dialog.getByRole("tab", { name: "AI", exact: true }).click()
    await dialog.getByText("群代理协签授权", { exact: true }).waitFor()
    await dialog.getByText("此群尚无已核验的链上组织，无法读取群代理授权。", { exact: true }).waitFor()
    assert.equal(await dialog.getByRole("button", { name: "签发协签授权", exact: true }).isDisabled(), true)
    assert.equal(await dialog.getByText(/Sentinel-AI|DeepSeek-Reasoner/).count(), 0)
    await dialog.getByRole("tab", { name: "群聊", exact: true }).click()
    await dialog.getByRole("button", { name: /^快捷/ }).click()
    await dialog.locator("#btn-slash-app").click()
    const app = page.getByRole("dialog").last()
    await app.getByRole("heading", { name: "群投票", exact: true }).waitFor()
    await app.getByText("此群组尚未关联链上组织", { exact: false }).waitFor()
    assert.equal(await app.getByRole("button", { name: "发起投票", exact: true }).count(), 0)
    assert.equal(await app.getByText("投票成功！", { exact: true }).count(), 0)
  }, () => {
    // Browser-only historical fixtures: no fake wallet, organization, channel, or transaction.
    localStorage.setItem("user_groups", JSON.stringify([{ id: "ui-acceptance-group", name: "UI 验收群组", network: "Sui Testnet", members: [], threshold: 1, totalWeight: 1 }]))
    localStorage.setItem("walrus_files_ui-acceptance-group", JSON.stringify([null, { id: "legacy-file", name: "历史记录保留验证", blobId: "walrus_blob_old", size: 1234 }]))
  })

  await scenario("ssm-channel-states-configuration-gap", async page => {
    await page.getByRole("button", { name: "群组", exact: true }).first().click()
    await page.getByRole("button", { name: "查看详情" }).click()
    const dialog = page.getByRole("dialog")
    // One conversation, two transports: the encrypted channel is a switch in
    // the same chat tab, not a second panel with its own list and composer.
    await dialog.getByText("尚未配置链上频道", { exact: true }).waitFor()
    assert.equal(await dialog.getByLabel("群消息内容").count(), 1)
    assert.equal(await dialog.getByLabel("加密消息内容").count(), 0)
    const encrypted = dialog.getByRole("button", { name: /端到端加密/ })
    await encrypted.waitFor()
    await encrypted.click()
    await dialog.getByText("端到端加密 · 未配置 relayer", { exact: true }).waitFor()
    // The same single composer is now bound to the encrypted transport and is
    // disabled; no message row and no signature badge is invented.
    assert.equal(await dialog.getByLabel("群消息内容").count(), 0)
    assert.equal(await dialog.getByLabel("加密消息内容").count(), 1)
    assert.equal(await dialog.getByLabel("加密消息内容").isDisabled(), true)
    assert.equal(await dialog.getByLabel("加密消息内容").getAttribute("placeholder"), "端到端加密未配置 relayer")
    assert.equal(await dialog.getByLabel("发送者签名已验证").count(), 0)
    assert.equal(await dialog.getByLabel("发送者签名未通过验证").count(), 0)
    // Settings hold the relayer config and group management for this transport.
    await dialog.getByRole("button", { name: "设置", exact: true }).click()
    await dialog.getByText("先配置并检查 relayer", { exact: false }).waitFor()
    assert.equal(await dialog.getByRole("button", { name: "创建", exact: true }).isDisabled(), true)
    // Saving a non-HTTPS remote relayer is refused instead of being stored.
    await dialog.locator("#ssm-relayer").fill("http://relay.example.com")
    await dialog.getByRole("button", { name: "保存", exact: true }).click()
    await dialog.getByText("relayer 必须使用 HTTPS", { exact: false }).waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem("sui_ssm_relayer_v1")), null)
    assert.equal(await dialog.getByText("未配置 relayer", { exact: true }).count(), 1)
    // Switching back restores the on-chain composer and its empty state.
    await dialog.getByRole("button", { name: "链上频道", exact: true }).click()
    await dialog.getByText("尚未配置链上频道", { exact: true }).waitFor()
    await dialog.getByLabel("群消息内容").waitFor()
    assert.equal(await dialog.getByText("暂无链上消息。输入内容将发送给频道成员；使用 /note 保存本机笔记。", { exact: true }).count(), 1)
    // The on-chain-only tools come back with it (label text is hidden at phone width).
    assert.equal(await dialog.getByTitle("发红包", { exact: true }).count(), 1)
    assert.equal(await dialog.getByTitle("快捷功能", { exact: true }).count(), 1)
    // Tools that only exist on-chain must be absent while the encrypted
    // transport is selected, and vice versa.
    await encrypted.click()
    assert.equal(await dialog.getByTitle("发红包", { exact: true }).count(), 0)
    assert.equal(await dialog.getByTitle("快捷功能", { exact: true }).count(), 0)
  }, () => {
    localStorage.setItem("user_groups", JSON.stringify([{ id: "ui-acceptance-group", name: "UI 验收群组", network: "Sui Testnet", members: [], threshold: 1, totalWeight: 1 }]))
  })

  await scenario("ssm-keeps-every-registered-group-reachable", async page => {
    await page.getByRole("button", { name: "群组", exact: true }).first().click()
    await page.getByRole("button", { name: "查看详情" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: /端到端加密/ }).click()
    await dialog.getByRole("button", { name: "设置", exact: true }).click()
    // The registry keeps up to 20 registrations newest-first. Only rendering
    // the newest one would hide every earlier on-chain group from the UI.
    const picker = dialog.locator("#ssm-active-group")
    await picker.waitFor()
    assert.equal(await picker.locator("option").count(), 2)
    await dialog.getByText("uuid newer-uuid", { exact: false }).waitFor()
    await picker.selectOption(`0x${"1".repeat(64)}`)
    await dialog.getByText("uuid older-uuid", { exact: false }).waitFor()
    assert.equal(await dialog.getByText("uuid newer-uuid", { exact: false }).count(), 0)
    // The composer is bound to the selected encrypted group, never to the
    // on-chain channel.
    assert.equal(await dialog.getByLabel("群消息内容").count(), 0)
    assert.equal(await dialog.getByLabel("加密消息内容").isDisabled(), true)
    assert.equal(await dialog.getByLabel("加密消息内容").getAttribute("placeholder"), "端到端加密未配置 relayer")
  }, () => {
    localStorage.setItem("user_groups", JSON.stringify([{ id: "ui-acceptance-group", name: "UI 验收群组", network: "Sui Testnet", members: [], threshold: 1, totalWeight: 1 }]))
    localStorage.setItem("sui_ssm_groups_v1:ui-acceptance-group", JSON.stringify([
      { groupId: `0x${"2".repeat(64)}`, uuid: "newer-uuid", name: "新加密群", createdAt: 2 },
      { groupId: `0x${"1".repeat(64)}`, uuid: "older-uuid", name: "旧加密群", createdAt: 1 },
    ]))
  })

  await scenario("invoice-drafts-reopen-and-delete", async page => {
    await payments(page)
    await page.getByRole("heading", { name: "本机发票草稿", exact: true }).waitFor()
    await page.getByText("#INV-UI-001", { exact: false }).waitFor()
    await page.getByText("本机草稿", { exact: true }).first().waitFor()
    // A legacy draft without a payment link is labelled instead of silently
    // presented as shareable.
    await page.getByText("#INV-UI-LEGACY", { exact: false }).waitFor()
    await page.getByText("缺收款链接", { exact: true }).waitFor()
    // The unsupported legacy record is excluded from the list but kept in storage.
    assert.equal(await page.getByText("#INV-UNREADABLE", { exact: false }).count(), 0)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("sui_invoices") || "[]").length), 3)
    // No paid/verified state may be implied for a browser-local draft.
    assert.equal(await page.getByText(/已支付|已核验收款/).count(), 0)

    await page.getByRole("button", { name: "编辑发票 INV-UI-001", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("heading", { name: "Invoice Preview", exact: true }).waitFor()
    await dialog.getByText("#INV-UI-001", { exact: false }).waitFor()
    await dialog.getByText("UI 验收客户", { exact: true }).waitFor()
    await dialog.getByText("12.50 SUI", { exact: false }).first().waitFor()
    // The reopened draft keeps its original payee rather than the connected wallet.
    await dialog.getByText("0x1111111111111111111111111111111111111111111111111111111111111111", { exact: false }).first().waitFor()
    await dismiss(page)

    // Two-step delete: the first click only arms the confirmation.
    await page.getByRole("button", { name: "删除发票 INV-UI-001", exact: true }).click()
    await page.getByText("#INV-UI-001", { exact: false }).waitFor()
    await page.getByRole("button", { name: "确认删除发票 INV-UI-001", exact: true }).click()
    await page.getByText("#INV-UI-001", { exact: false }).waitFor({ state: "detached" })
    // Deleting one draft leaves the other records, including unreadable ones, untouched.
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("sui_invoices") || "[]").length), 2)
  }, () => {
    localStorage.setItem("sui_invoices", JSON.stringify([
      {
        invoiceNumber: "INV-UI-001", recipient: "UI 验收客户", recipientEmail: "client@example.com",
        token: "SUI", items: [{ id: "1", description: "设计工作", quantity: "5", price: "2.5" }],
        total: "12.50", paymentAddress: "0x" + "1".repeat(64),
        paymentUri: "sui:0x" + "1".repeat(64) + "?amount=12.50", source: "local",
      },
      {
        invoiceNumber: "INV-UI-LEGACY", recipient: "旧草稿客户",
        token: "SUI", items: [{ id: "1", description: "旧项目", quantity: "1", price: "1" }],
        total: "1.00", paymentAddress: "0x" + "2".repeat(64), source: "local",
      },
      { invoiceNumber: "INV-UNREADABLE", total: 42 },
    ]))
  })

  await scenario("agent-vault-no-account-and-legacy-history", async page => {
    await page.getByRole("button", { name: "AI副卡", exact: true }).click()
    await page.getByRole("heading", { name: "AI Agent 虚拟副卡", exact: true }).waitFor()
    // No connected account: nothing may be fabricated as a balance or a card.
    await page.getByText("请先在右上角连接 Sui 钱包；没有账户时不会显示任何金库或副卡。", { exact: true }).waitFor()
    assert.equal(await page.getByText("—", { exact: true }).count(), 3)
    assert.equal(await page.getByText(/金库总资产/).count(), 1)
    assert.equal(await page.getByText(/正在从链上核验/).count(), 0)
    // Old browser-only records stay visible but explicitly unverified and out of totals.
    await page.getByText("旧版本地记录（不在链上）", { exact: true }).waitFor()
    await page.getByText("2 张卡 · 1 条日志", { exact: true }).waitFor()
    assert.equal(await page.getByText("历史副卡 A", { exact: true }).count(), 0)
    // The create dialog opens but cannot claim to sign without an identity.
    await page.getByRole("button", { name: "签发副卡", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText("请先在右上角连接钱包，才能签名签发交易。", { exact: true }).waitFor()
    assert.equal(await dialog.getByRole("button", { name: "签名并签发 AgentCap", exact: true }).isDisabled(), true)
    assert.equal(await dialog.getByText(/已成功签发/).count(), 0)
    await dismiss(page)
    assert.equal(await page.evaluate(() => localStorage.getItem("sui_agent_cap_index_v1")), null)
  }, () => {
    localStorage.setItem("sui_agent_cards", JSON.stringify([
      { id: "legacy-1", name: "历史副卡 A", address: "0x" + "1".repeat(64), dailyBudget: 5, spentToday: 0.5, status: "ACTIVE" },
      { id: "legacy-2", name: "历史副卡 B", address: "0x" + "2".repeat(64), dailyBudget: 2 },
    ]))
    localStorage.setItem("sui_agent_logs", JSON.stringify([{ id: "log-1", agentName: "历史副卡 A", amount: 0.05, status: "SUCCESS" }]))
  })

  await scenario("group-ai-tab-reads-chain-delegations", async page => {
    await page.getByRole("button", { name: "群组", exact: true }).first().click()
    await page.getByRole("button", { name: "查看详情" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("tab", { name: "AI", exact: true }).click()
    await dialog.getByText("群代理协签授权", { exact: true }).waitFor()
    await dialog.getByText("频道代发凭证", { exact: true }).waitFor()
    // The old placeholder fabricated a Sentinel-AI assistant and a fake budget.
    // It must never come back in any form.
    assert.equal(await dialog.getByText(/Sentinel-AI|DeepSeek-Reasoner|运行中/).count(), 0)
    // Without a connected account no delegation may be issued.
    assert.equal(await dialog.getByRole("button", { name: "签发协签授权", exact: true }).isDisabled(), true)
    assert.equal(await dialog.getByRole("button", { name: "签发频道代发凭证", exact: true }).isDisabled(), true)
    // This group has no on-chain channel in the fixture, so the messaging
    // section must say the channel is missing instead of listing fake agents.
    await dialog.getByText("此群尚未关联链上聊天频道，无法签发频道代发凭证；请先在群聊中创建或加入频道。", { exact: true }).waitFor()
    // The delegation scan resolves the real organization or reports the exact
    // read error; either way it must finish instead of staying "loading".
    await dialog.getByText("正在读取链上协签凭证与当前名册…", { exact: true }).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {})
    const settled = await dialog.getByText(/当前名册成员尚未签发任何链上协签凭证。|此群尚无已核验的链上组织/).count()
      + await dialog.locator('[role="alert"]').count()
    assert.ok(settled > 0, "the delegation scan must settle with a real result or a visible error")
  }, () => {
    localStorage.setItem("user_groups", JSON.stringify([{
      id: "ui-acceptance-group", name: "UI 验收群组", network: "Sui Testnet", members: [], threshold: 1, totalWeight: 1,
      // A real on-chain organization, so the AI tab performs a real roster read.
      orgObjectId: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
    }]))
  })

  await scenario("group-roster-change-requires-committee-shares", async page => {
    await page.getByRole("button", { name: "群组", exact: true }).first().click()
    await page.getByRole("button", { name: "查看详情" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("tab", { name: "成员", exact: true }).click()
    // The fixture org is a real testnet object from a superseded package
    // lineage. The verified read must reject it (type origin no longer matches
    // the current package), and the members tab must fail closed: say so in the
    // amber note, keep the local-record framing, and never render the DAO
    // banner or its roster entry without a chain-verified organization.
    await dialog.getByText(/本机记录了组织对象 0xaf0806fa…，但本次未能从链上读取到有效组织/).waitFor({ timeout: 30_000 })
    assert.equal(await dialog.getByText("已固化为密码学组织 (DAO)", { exact: true }).count(), 0)
    assert.equal(await dialog.getByRole("button", { name: "名册换届", exact: true }).count(), 0)
    await dialog.getByText("当前为多签群组", { exact: true }).waitFor()
    await dialog.getByText("以下为本机成员记录，链上组织成员尚未核验。", { exact: true }).waitFor()
    // The only offered path is the honest one: run a fresh DKG ceremony to
    // finalize a real organization; the button must open the real ceremony
    // dialog rather than dead-end.
    await dialog.getByRole("button", { name: "固化为 DAO", exact: true }).click()
    await page.getByRole("heading", { name: "升级为链上组织 (DAO)", exact: true }).waitFor()
  }, () => {
    localStorage.setItem("user_groups", JSON.stringify([{
      id: "ui-acceptance-group", name: "UI 验收群组", network: "Sui Testnet", members: [], threshold: 1, totalWeight: 1,
      // A real testnet organization object from a superseded package lineage:
      // the type-origin check must reject it and the UI must fail closed
      // instead of trusting the local orgObjectId note.
      orgObjectId: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
    }]))
  })

  await scenario("notification-unread-badge", async page => {
    const badge = page.getByRole("button", { name: "通知，1 条未读", exact: true })
    await badge.waitFor()
    await badge.click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText("有提案等待你审批", { exact: false }).first().waitFor()
    await dialog.getByText("1 条未读", { exact: false }).waitFor()
    await dialog.getByRole("button", { name: "全部已读", exact: true }).click()
    await dialog.getByText("0 条未读", { exact: false }).waitFor()
    await dismiss(page)
    // Once read, the badge must disappear rather than keep claiming unread work.
    await page.getByRole("button", { name: "通知", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: /条未读/ }).count(), 0)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("sui_notifications_read:" + "0x" + "a".repeat(64)) || "[]").length >= 1), true)
  }, () => {
    const address = "0x" + "a".repeat(64)
    const linked = { provider: "Google", type: "zklogin", address }
    // Only the connected account matters; the proposal must still be a chain-synced shared record.
    localStorage.setItem("sui_active_account", JSON.stringify(linked))
    localStorage.setItem("sui_proposals", JSON.stringify([{
      id: "notify-1", onChainId: "0x" + "9".repeat(64), orgId: "org", title: "通知验收提案", description: "",
      amount: 1, amountMist: "1000000000", token: "SUI", groupId: "g1", groupName: "UI 验收群组", recipient: "0x2",
      status: "pending", approvals: 1, requiredApprovals: 2, createdAt: "", expiresAt: "",
      deadlineMs: Date.now() + 3_600_000, type: "transfer", color: "from-primary to-purple-500", voters: [],
      chainSyncedAt: new Date().toISOString(), memberWeights: { [address]: 1 }, sourceStatus: "chain-confirmed",
    }]))
  })

  await scenario("shared-person-never-fabricates-a-profile", async page => {
    // A shared profile link is read-only and, without a deployed identity
    // package, must say so instead of rendering an invented name, avatar or
    // follow state.
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("heading", { name: "查看个人身份", exact: true }).waitFor()
    await dialog.getByText("身份协议尚未配置", { exact: false }).first().waitFor({ timeout: 30_000 })
    assert.equal(await dialog.getByText("互相关注", { exact: true }).count(), 0)
    assert.equal(await dialog.getByText("已关注", { exact: true }).count(), 0)
    // Follow and DM entries require a minted identity and stay disabled rather
    // than simulating a signed action.
    for (const name of ["关注", "回关", "取消关注", "发私信"]) assert.equal(await dialog.getByRole("button", { name, exact: true }).count(), 0, `${name} must not be offered without an identity`)
    // Followers are a projection of on-chain events; with no identity there is
    // nothing to project and no placeholder fan list may appear.
    assert.equal(await dialog.getByText("我的粉丝", { exact: false }).count(), 0)
    assert.equal(await dialog.getByText("暂无粉丝", { exact: false }).count(), 0)
  }, undefined, "/?person=0x" + "7".repeat(64))

  await scenario("shared-group-read-only", async page => {
    await page.getByRole("heading", { name: "UI 只读群组", exact: true }).waitFor()
    await page.getByRole("button", { name: "只读查看群投票", exact: true }).click()
    const app = page.getByRole("dialog").last()
    await app.getByRole("heading", { name: "群投票", exact: true }).waitFor()
    await app.getByText("只读查看", { exact: true }).waitFor()
    await app.getByRole("alert").waitFor()
    assert.equal(await app.getByRole("button", { name: "发起投票", exact: true }).count(), 0)
    assert.equal(await app.getByRole("button", { name: "选择选项并签名投票", exact: true }).count(), 0)
    assert.equal(await app.getByText("投票成功！", { exact: true }).count(), 0)
  }, () => {
    localStorage.setItem("user_groups", JSON.stringify([{ id: "ui-read-only-group", name: "UI 只读群组", network: "Sui Testnet", members: [], threshold: 1, totalWeight: 1 }]))
  }, "/?group=ui-read-only-group")

  await scenario("shared-treasury-read-only", async page => {
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("heading", { name: "组织金库与充值码", exact: true }).waitFor()
    await dialog.getByRole("alert").waitFor()
    assert.equal(await dialog.getByRole("button", { name: "确认金额并请求钱包签名", exact: true }).count(), 0)
    assert.equal(await dialog.getByRole("button", { name: "准备充值", exact: true }).count(), 0)
    assert.equal(await page.locator("#tab-wallet").count(), 0)
  }, undefined, "/?treasury=invalid&org=invalid")

  await scenario("group-discovery-membership-scan", async page => {
    // When an account is connected, the group list must run chain discovery,
    // surface the scan boundary honestly, and never invent membership.
    await page.getByRole("button", { name: "群组", exact: true }).first().click()
    await page.getByRole("heading", { name: "我的群组", exact: true }).waitFor()
    // The refresh button is available to re-run the discovery scan.
    await page.getByRole("button", { name: "刷新链上组织", exact: true }).waitFor()
    // The scan must settle. Testnet prunes its event log aggressively, so both
    // settled outcomes are honest: a checked-note with a result count, or a
    // failure note that names the RPC error. Either way no membership may be
    // fabricated.
    await page.getByText(/按链上建组事件核对了|已扫描最近|链上组织发现失败/, { exact: false }).first().waitFor({ timeout: 30_000 })
    assert.equal(await page.getByText("链上发现 · 本机无备注", { exact: true }).count(), 0)
    const scanSettledChecked = await page.getByText(/按链上建组事件核对了|已扫描最近/, { exact: false }).count()
    if (scanSettledChecked > 0) {
      // An outsider account sees 0 chain groups.
      assert.equal(await page.getByText("此账户没有已发现的群组", { exact: true }).count(), 1)
    } else {
      // The failure path shows the undecided state, not a fake "no groups".
      await page.getByText("无法确认你的群组", { exact: true }).waitFor()
    }
    // Profile menu reflects the exact same group count (0 here).
    await page.getByRole("button", { name: "我的", exact: true }).click()
    await page.getByRole("button", { name: "个人账户", exact: true }).click()
    await page.getByText("我的群组 · 0", { exact: true }).waitFor()
    await dismiss(page)
  }, () => {
    const address = "0x" + "9".repeat(64)
    localStorage.setItem("sui_active_account", JSON.stringify({ provider: "Mock", type: "keystore", address }))
    localStorage.setItem("user_groups", "[]")
  })

  await scenario("theme-switch-applies-and-persists", async page => {
    // next-themes was mounted in the layout from 2026-10-21; before that the
    // app shipped a provider nobody rendered and `.dark` CSS never applied.
    const before = await page.evaluate(() => document.documentElement.className)
    assert.match(before, /light|dark/, "layout must resolve an initial theme class")
    await page.getByRole("button", { name: "我的", exact: true }).click()
    await page.getByRole("button", { name: "个人账户", exact: true }).click()
    const control = page.getByRole("group", { name: "外观主题" })
    await control.waitFor()
    await control.getByRole("button", { name: "深色", exact: true }).click()
    await waitForValue(page, () => ({
      cls: document.documentElement.className,
      bg: getComputedStyle(document.body).backgroundColor,
      stored: localStorage.getItem("theme"),
    }), { cls: "dark", bg: "rgb(13, 17, 28)", stored: "dark" })
    // Reload: the choice is this browser's, not a session default.
    await page.reload()
    await page.getByRole("button", { name: "我的", exact: true }).click()
    await page.getByRole("button", { name: "个人账户", exact: true }).click()
    await control.waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.className), "dark")
    assert.equal(await control.getByRole("button", { name: "深色", exact: true }).getAttribute("aria-pressed"), "true")
    // Back to light and the original surface returns; nothing stays inverted.
    await control.getByRole("button", { name: "浅色", exact: true }).click()
    await waitForValue(page, () => getComputedStyle(document.body).backgroundColor, "rgb(249, 250, 251)")
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "dark theme must not overflow the phone layout")
  }, () => {
    if (!localStorage.getItem("sui_active_account")) localStorage.setItem("sui_active_account", JSON.stringify({ provider: "Regression", type: "keystore", address: "0x" + "9".repeat(64) }))
  })

  // The Walrus panel is its own route now (/walrus); the profile tab links to
  // it, so the scenario walks the real user path through the entry card.
  await scenario("walrus-policy-registry-and-interface-status", async page => {
    await page.getByRole("button", { name: "我的", exact: true }).click()
    await page.getByRole("link", { name: "Walrus 付费策略", exact: false }).click()
    const heading = page.getByRole("heading", { name: "Walrus 付费策略", exact: true })
    await heading.waitFor()
    assert.equal(await heading.count(), 1)
    assert.equal(await page.getByRole("heading", { name: "Walrus 应用策略", exact: true }).count(), 0)
    assert.equal(await page.getByText(/Walrus 付款策略 V2|v8 入口已核验|旧版策略仅供读取/).count(), 0)
    await page.getByText("交易操作 · 由连接的钱包签名执行", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "初始化注册表", exact: true }).count(), 1)
    assert.equal(await page.getByRole("button", { name: /^(登记付款应用|凭证付款|暂停|恢复)/ }).count(), 0)
    assert.equal(await page.getByText(/已创建注册表|钱包拒绝了签名/).count(), 0)
    assert.equal(await page.getByText("链上对象已读取", { exact: true }).count(), 0)
    // A blank id stays local, including the keyboard submission path.
    assert.equal(await page.getByRole("button", { name: "读取注册表", exact: true }).isDisabled(), true)
    const field = page.getByLabel("Walrus 付款策略注册表 ID")
    await field.focus()
    await field.press("Enter")
    await page.getByText("请输入注册表对象 ID。", { exact: true }).waitFor()
    await field.fill("0x" + "1".repeat(64))
    await page.getByRole("button", { name: "读取注册表", exact: true }).click()
    await page.getByText(/该对象不是当前包定义的付款注册表|notFound|not found/i).first().waitFor({ timeout: 30_000 })
    assert.equal(await page.getByText("该注册表已读取成功，但尚未登记任何付款应用。", { exact: true }).count(), 0)
  }, () => {
    localStorage.setItem("sui_active_account", JSON.stringify({ provider: "Mock", type: "keystore", address: "0x" + "9".repeat(64) }))
    localStorage.removeItem("sui_walrus_policy_registry")
    localStorage.removeItem("sui_walrus_policy_registry_admin_cap")
  })

  console.log(JSON.stringify({ viewport: { width: viewportWidth, height: 844 }, reports }))
} finally { await browser.close() }
