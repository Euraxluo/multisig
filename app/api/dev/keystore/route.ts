// Request headers cannot authenticate a local peer. Never read or export the
// host keystore from a web route, including when legacy dev flags are set.
//
// This source stays import-free by design: lib/dev-keystore.test.ts asserts
// this file imports nothing (an inertness gate — imports are how keystore-touching
// code could creep back in), so the disabled message is static and bilingual
// instead of going through the i18n runtime.
export async function GET(_request: Request) {
  return new Response(
    JSON.stringify({
      error: "Web keystore login is retired — use an extension wallet, Passkey or Google zkLogin. 网页 Keystore 登录已停用，请使用扩展钱包、Passkey 或 Google zkLogin。",
      accounts: [],
    }),
    { status: 410, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } },
  )
}
