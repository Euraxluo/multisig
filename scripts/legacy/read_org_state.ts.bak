/**
 * 组织状态 / nonce 台账读取（只读，无秘密）
 *
 * 委员会每次发起门限提案（authorize_upgrade / governed_transfer_cap / 名册
 * 更新）前，用本工具读取链上组织的 last_nonce，取 next = last_nonce + 1。
 * 提案 nonce 单调燃烧，撞号会直接 abort（E_INVALID_NONCE）且白费一轮签名。
 *
 *   pnpm exec tsx scripts/read_org_state.ts <org-id>
 */
import { SuiGrpcClient } from "@mysten/sui/grpc"

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

/** BCS 读取器：地址(32B)/u64(LE)/vector(uleb128 长度前缀) */
class BcsReader {
  private off = 0
  constructor(private readonly b: Uint8Array) {}
  private take(n: number): Uint8Array {
    if (this.off + n > this.b.length) throw new Error(`BCS 越界: 需要 ${this.off + n}，共 ${this.b.length}`)
    const out = this.b.slice(this.off, this.off + n)
    this.off += n
    return out
  }
  address(): string { return "0x" + hex(this.take(32)) }
  u64(): bigint {
    let v = 0n
    const b = this.take(8)
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i])
    return v
  }
  uleb(): number {
    let v = 0
    let shift = 0
    for (;;) {
      const byte = this.take(1)[0]
      v |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return v
      shift += 7
    }
  }
  vector(): Uint8Array { return this.take(this.uleb()) }
  /** Table BCS = { id: address, size: u64 } */
  table(): { id: string; size: bigint } { return { id: this.address(), size: this.u64() } }
}

/** Organization BCS: uid(32) || group_pk vec || threshold u64 || epoch u64 ||
 *  last_nonce u64 || chain_id vec || members_weight Table || executed_proposals Table */
function parseOrganization(b: Uint8Array) {
  const r = new BcsReader(b)
  const id = r.address()
  const groupPk = r.vector()
  const thresholdWeight = r.u64()
  const epochVersion = r.u64()
  const lastNonce = r.u64()
  const chainId = r.vector()
  const membersWeight = r.table()
  const executedProposals = r.table()
  return { id, groupPk, thresholdWeight, epochVersion, lastNonce, chainId, membersWeight, executedProposals }
}

async function main() {
  const orgId = process.argv[2]
  if (!orgId || !/^0x[0-9a-fA-F]{64}$/.test(orgId)) {
    console.error("用法: pnpm exec tsx scripts/read_org_state.ts <org-id>")
    process.exit(2)
  }
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
  const res: any = await client.getObject({ objectId: orgId, include: { content: true } } as any)
  const obj = res?.object ?? res
  const raw = obj?.content
  if (!raw) throw new Error("对象不存在或无 content: " + JSON.stringify(obj).slice(0, 200))
  const b = Uint8Array.from(Array.isArray(raw) ? raw : Buffer.from(raw, "base64"))
  const s = parseOrganization(b)
  console.log("org:            ", s.id)
  console.log("group_pk:       ", "0x" + hex(s.groupPk))
  console.log("threshold_weight:", s.thresholdWeight.toString())
  console.log("epoch_version:  ", s.epochVersion.toString())
  console.log("last_nonce:     ", s.lastNonce.toString(), " → 下一提案 nonce =", (s.lastNonce + 1n).toString())
  console.log("chain_id:       ", new TextDecoder().decode(s.chainId))
  console.log("members_weight: ", s.membersWeight.size.toString(), "名成员")
  console.log("executed_props: ", s.executedProposals.size.toString(), "条已执行（重放表）")
}

main().catch((e) => { console.error("FAILED:", e.message || String(e)); process.exit(1) })
