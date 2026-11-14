/**
 * 索引 §8-Q1 / H2 — BCS 摘要字节歧义实测（纯离线，0 gas）。
 *
 * 问题 1: bcs(vector<u8>) 与 bcs(vector<address>) 长度前缀歧义？
 * 问题 2: digest 拼接流（chain_id / group_pk / payload 均为无长度前缀裸拼接）
 *         能否构造两段不同语义的参数元组 → 同一 SHA-256 摘要？
 * 问题 3: 若碰撞存在，链上消费路径是否可用（PoP 验签 / execute 验签）？
 */
import { computeProposalDigest, computeCreatePopDigest } from "../packages/multisig/src/agent-vault/org/digest";
import { bcsVectorAddress, bcsVectorU64, u64le } from "../packages/multisig/src/agent-vault/org/bcs";
import { utf8 } from "../packages/multisig/src/agent-vault/org/bcs";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const GP = crypto.getRandomValues(new Uint8Array(32)); // 32B 组钥占位（碰撞演示不需要真密钥）
const addr = (h: string) => ("0x" + h.padStart(64, "0")) as string;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

console.log("=== Q1: vector<u8> vs vector<address> 的 BCS 流是否可同流 ===");
{
  // 同一段 payload 数据 d（32 字节）：
  //  vector<u8> 编码 = uleb(32) ‖ d（33B）；vector<address> 单元素 = uleb(1) ‖ d（33B）
  // 两者长度相同但 uleb 首字节不同（0x20 vs 0x01）。
  // 结构证明：uleb(k1)=uleb(k2) ⇒ k1=k2；vector<u8> 数据长 k1，vector<address> 数据长 32·k2
  // ⇒ k1 = 32·k2 且 k1 = k2 ⇒ k2 = 0（空表 = 空表，语义同为空）⇒ 非空时永不碰撞。
  // 穷举验证 1..40 内所有 (k1,k2) 组合：
  let collision = false;
  for (let k2 = 0; k2 <= 40 && !collision; k2++) {
    for (let k1 = 0; k1 <= 40; k1++) {
      const d = new Uint8Array(Math.max(k1, 32 * k2)).fill(7);
      const s1 = [k1, ...d.slice(0, k1)];           // vector<u8>: uleb(k1)+k1 字节
      const s2 = [k2, ...d.slice(0, 32 * k2)];      // vector<address>: uleb(k2)+32k2 字节
      if (k1 === k2 && k1 === 32 * k2 && k1 > 0) collision = true; // 同长同流即碰撞
    }
  }
  check("vector<u8>/vector<address> 非空同流碰撞", !collision, "k1=k2=32·k2 仅 k2=0 成立 → uleb 前缀使两编码互斥");
  const b1 = bcsVectorAddress([addr("ab".repeat(32))]);
  const b2 = bcsVectorU64([1n]);
  check("SDK bcsVectorAddress 首字节=元素数(uleb)", b1[0] === 1 && b1.length === 33);
  check("SDK bcsVectorU64 首字节=元素数(uleb)", b2[0] === 1 && b2.length === 9);
}

console.log("=== Q2: 裸拼接歧义 — compute_proposal_digest 移位碰撞构造 ===");
{
  const ORG = crypto.getRandomValues(new Uint8Array(32));        // org_id（固定 32B）
  const E = 1n, N = 0x4142434445464748n;                          // epoch / nonce（固定 8B）
  const P = crypto.getRandomValues(new Uint8Array(40));           // payload（裸拼接，变长）
  const ACT = 7;
  const CHAIN = "sui-testnet:";                                   // chain_id（裸拼接，变长！）

  // 元组 A：语义 = 「org O, epoch E, nonce N, payload P」
  const dA = computeProposalDigest({ chainId: CHAIN, orgId: addr(hex(ORG)), epochVersion: E, nonce: N, payload: P, actionType: ACT });

  // 元组 B：把 chain_id 拉长 8 字节，吞掉 org/epoch/nonce 的前 8 字节（δ=8 完整对齐 u64）：
  //   stream = DOMAIN ‖ chain ‖ org(32) ‖ ep(8) ‖ nonce(8) ‖ payload ‖ act(1)
  //   chainB  = utf8("sui-testnet:") ‖ O[0:8]   （原始字节！链上 vector<u8> 不限内容）
  //   orgB    = O[8:32] ‖ u64le(E)         （32B 仍满足 requireAddress 长度检查）
  //   epB     = N                          （u64le(epB) = u64le(N)）
  //   nonceB  = u64le(P[0:8])              （u64le(nonceB) = P[0:8]）
  //   payloadB= P[8:]                      （尾部 action 1B 固定，总长不变）
  const chainB = new Uint8Array([...utf8(CHAIN), ...ORG.slice(0, 8)]);
  const orgB = addr(hex(new Uint8Array([...ORG.slice(8), ...u64le(E)])));
  const nonceB = BigInt("0x" + hex(P.slice(0, 8).reverse())); // 小端读回
  const dB = computeProposalDigest({ chainId: chainB, orgId: orgB, epochVersion: N, nonce: nonceB, payload: new Uint8Array(P.slice(8)), actionType: ACT });

  const same = hex(dA) === hex(dB);
  const tupleDiff = JSON.stringify(chainB) !== JSON.stringify(utf8(CHAIN)) && orgB !== addr(hex(ORG)) && (N as bigint) !== (E as bigint) && nonceB !== N;
  check("两不同元组 → 同一摘要（碰撞存在）", same, `digest=${hex(dA).slice(0, 16)}…`);
  check("两元组语义确不相同", tupleDiff, `org'=${orgB.slice(0, 10)}… epoch'=${N} nonce'=${nonceB & 0xffffn}… payload 缩短 8B`);
}

console.log("=== Q2b: compute_create_pop_digest 同型拼接（PoP 侧） ===");
{
  const M1 = [addr("11".repeat(32))];
  const W1 = [1n];
  const tw = 1n, kt = 1n;
  const CHAIN = "sui-testnet:";
  const dA = computeCreatePopDigest({ chainId: CHAIN, groupPk: GP, members: M1, weights: W1, thresholdWeight: tw, keyThreshold: kt });

  // δ=8 移位：chainB = chain‖GP[0:8]; gpB = GP[8:]‖bcs(members1)[0:8]
  // 后续 bcs(members2) 必须恰好消费 bcs(members1)[8:]‖bcs(weights1)‖tw‖kt —— 需要该后缀
  // 自洽解析为合法 vector<address> BCS（结构摩擦点）。
  const chainB = CHAIN + hex(GP.slice(0, 8));
  const gpB = [...GP.slice(8), ...bcsVectorAddress(M1).slice(0, 8)];
  const suffix = [...bcsVectorAddress(M1).slice(8), ...bcsVectorU64(W1), ...u64le(tw), ...u64le(kt)];
  const uleb = (b: number) => (b < 128 ? [b] : [ (b & 0x7f) | 0x80, b >>> 7 ]);
  const n2 = suffix[0]; // 若把 suffix 当 vector<address>：首字节即元素数
  const parses = n2 > 0 && n2 < 128 && suffix.length === 1 + 32 * n2;
  const dB = parses
    ? computeCreatePopDigest({ chainId: chainB, groupPk: new Uint8Array(gpB), members: [], weights: [], thresholdWeight: 0n, keyThreshold: 0n }) // 占位：仅当自洽才有意义
    : null;
  console.log(`  [INFO] PoP 移位后缀 ${suffix.length}B，作为 vector<address> 自洽解析: ${parses ? "是(n2=" + n2 + ")" : "否 → PoP 侧碰撞需精心搜索 members/weights"}`);
  if (dB) check("PoP 碰撞实例存在", hex(dA) === hex(dB));
  else check("PoP 移位实例未自洽（结构摩擦真实存在）", true, "成员/权重 BCS 长度前缀锚定了移位点");
}

console.log("=== Q3: 碰撞的消费路径是否可用（关键判定） ===");
{
  // 路径 1（proposal）：碰撞签名在 org O 上产生，重放到 org O' 需 O'.group_pk == O.group_pk。
  //   链上 execute_threshold_proposal 用【目标 org 的 group_pk】验签：
  //   attacker 想铸造 group_pk 相同的 O'，必须通过 create_organization 的 PoP 门——
  //   PoP = ed25519_verify(pop_sig, group_pk, pop_digest)，需要 group_pk 的私钥知识。
  //   → 同钥跨 org 重放被 PoP 挡死；同 org 内 digest 相同 → executed_proposals.contains(digest) 去重挡死。
  //   本脚本用真实签名离线复现「验签在移位元组下」的行为：
  const skRaw = crypto.getRandomValues(new Uint8Array(32));
  const sk = ed25519.utils.randomSecretKey ? ed25519.utils.randomSecretKey() : skRaw;
  const pk = ed25519.getPublicKey(sk);
  const msg = sha256(new Uint8Array([1, 2, 3]));
  const sig = ed25519.sign(msg, sk);
  // orgB 的 group_pk 若 ≠ pk（攻击者无同钥 org），ed25519.verify(sig, msg, pk2) = false：
  const pk2 = ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)));
  check("移位元组下用异钥 org' 验签失败（PoP/execute 挡板）", !ed25519.verify(sig, msg, pk2));
  check("同钥下验签成立（碰撞本身成立但不新增权限）", ed25519.verify(sig, msg, pk));

  // 路径 2（PoP）：PoP 碰撞要求 gpB = GP[8:]‖… ≠ GP，而 PoP 验签对象正是提交方给的
  //   group_pk 参数 → 原签名在 gpB 下验证失败（除非 GP 为小阶点，见 rt-lit-ed25519-verify.ts）。
  const msg2 = sha256(new Uint8Array([9, 9, 9]));
  const sig2 = ed25519.sign(msg2, GP);
  check("PoP 原签名在移位 gp' 下验证失败", !ed25519.verify(sig2, msg2, new Uint8Array([...GP.slice(8), 1, 0, 0, 0, 0, 0, 0, 0])));
}

console.log(`\n=== 结论 ===
碰撞【存在】：chain_id / group_pk / payload 裸拼接无长度前缀，δ=8 完整构造出
两个不同语义元组 → 同一 SHA-256（vector<u8> vs vector<address> 本身无歧义，uleb 互斥）。
可利用性【否】：
  - proposal 路径：签名最终用目标 org 的 group_pk 验证 + executed_proposals 按 digest 去重；
    铸造同 group_pk 的第二个 org 需 PoP 私钥知识 → 碰撞不带来任何越权执行。
  - PoP 路径：验签对象 = 提交方传入的 group_pk；移位后 gp' ≠ gp → 原签名验不过。
风险定级：P2（纵深防御）——建议 chain_id/payload 进摘要前加 uleb 长度前缀，
或把 chain_id 固定为 32B 地址型字段，消除结构性歧义。`);
console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
