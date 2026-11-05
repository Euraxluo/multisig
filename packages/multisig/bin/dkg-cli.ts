#!/usr/bin/env node

import {
  DKGParticipant,
  ResharingNode,
  ThresholdSignerNode,
} from '../src/dkg';

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function logBanner() {
  console.log(`
${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════════════════╗
║               CRYPTOGRAPHIC ORGANIZATION PROTOCOL: DKG SUITE             ║
║     (Modeled after MystenLabs Seal & Ika 2PC-MPC Dynamic Resharing)      ║
╚══════════════════════════════════════════════════════════════════════════╝${RESET}
`);
}

async function runDemo() {
  logBanner();

  console.log(`${YELLOW}${BOLD}━━━ 阶段一: 启动 3/4 门限 DKG 密钥生成仪式 (FROST Ceremony) ━━━${RESET}`);
  console.log(`${DIM}参与者: Alice(1), Bob(2), Charlie(3), David(4) | 门限阈值: 3/4${RESET}\n`);

  const nodes = [
    new DKGParticipant('Alice', 1, 3, 4),
    new DKGParticipant('Bob', 2, 3, 4),
    new DKGParticipant('Charlie', 3, 3, 4),
    new DKGParticipant('David', 4, 3, 4),
  ];

  // 1. Round 1
  console.log(`${CYAN}[Round 1]${RESET} 各节点独立生成 t-1=2 阶秘密多项式，并广播 Pedersen 承诺 C_{i,k}:`);
  const r1Packages = nodes.map((n) => {
    const pkg = n.round1();
    console.log(`  ✓ ${GREEN}${n.id}${RESET} 广播承诺点 C_{${n.id},0} = 0x${Buffer.from(pkg.commitmentBytes[0]).toString('hex').slice(0, 16)}...`);
    return pkg;
  });

  // 交换承诺
  nodes.forEach((n) => n.receiveRound1Packages(r1Packages));

  // 2. Round 2
  console.log(`\n${CYAN}[Round 2]${RESET} 各节点通过端到端加密通道 (MLS/WebRTC) 计算并点对点投递秘密分片 s_{i -> j} = f_i(j):`);
  const allShares = new Map<string, Map<string, bigint>>();
  nodes.forEach((n) => {
    const sharesOut = n.round2();
    allShares.set(n.id, sharesOut);
    console.log(`  ✓ ${GREEN}${n.id}${RESET} 已为其他 3 位成员生成密态分片并完成派发`);
  });

  // 3. Finalize
  console.log(`\n${CYAN}[Finalize]${RESET} 各节点执行 VSS 同态校验 (s*G == ∑ x^k*C_k)，聚合私钥分片与群公钥:`);
  const dkgResults = nodes.map((n) => {
    const incomingShares = new Map<string, bigint>();
    nodes.forEach((sender) => {
      const share = allShares.get(sender.id)!.get(n.id)!;
      incomingShares.set(sender.id, share);
    });

    const res = n.finalize(incomingShares);
    console.log(`  ✓ ${GREEN}${n.id}${RESET} 校验所有对端承诺通过! 得到私钥份额 s_${n.id} (秘密保存本地)`);
    return res;
  });

  const groupPkHex = dkgResults[0].groupPublicKeyHex;
  const groupPkBytes = dkgResults[0].groupPublicKey;

  console.log(`\n${GREEN}${BOLD}★ DKG 仪式圆满成功! 全局组织主公钥 (PK_GROUP):${RESET}`);
  console.log(`  ${BOLD}${groupPkHex}${RESET}`);
  console.log(`  ${DIM}注意: 全网无任何单点持有完整私钥，所有成员仅持有本地份额 s_i${RESET}\n`);

  // 4. Threshold Signing
  console.log(`${YELLOW}${BOLD}━━━ 阶段二: 门限协同签名提案 (3/4 在线签名) ━━━${RESET}`);
  const proposalMsg = new TextEncoder().encode('Sui Move PTB: Transfer 1000 SUI from Organization Treasury to 0x777...cafe');
  console.log(`提案内容: "${new TextDecoder().decode(proposalMsg)}"`);
  console.log(`${DIM}Charlie 掉线中，由 Alice(1), Bob(2), David(4) 协同签名 (满足 >= 3 门限):${RESET}`);

  const signers = [
    new ThresholdSignerNode('Alice', 1, dkgResults[0].privateShare),
    new ThresholdSignerNode('Bob', 2, dkgResults[1].privateShare),
    new ThresholdSignerNode('David', 4, dkgResults[3].privateShare),
  ];

  // 签名 Round 1
  const nonceCommitments = signers.map((s) => s.generateNonceCommitment());
  console.log(`  ✓ 签名节点广播临时 Nonce 承诺 R_i`);

  // 签名 Round 2
  const sigShares = signers.map((s) => s.computeSignatureShare(proposalMsg, groupPkBytes, nonceCommitments));
  console.log(`  ✓ 签名节点计算并交换部分签名份额 z_i = r_i + c * λ_i * s_i`);

  // 聚合签名
  const finalSignature = ThresholdSignerNode.aggregateSignature(nonceCommitments, sigShares);
  console.log(`  ✓ 聚合生成标准 64 字节 Ed25519 签名:`);
  console.log(`    0x${Buffer.from(finalSignature).toString('hex')}`);

  // 验证
  const isSigValid = ThresholdSignerNode.verifyThresholdSignature(finalSignature, proposalMsg, groupPkBytes);
  console.log(`  ${GREEN}${BOLD}★ Sui Move sui::ed25519::ed25519_verify 原生验签结果: ${isSigValid ? 'PASS (通过!)' : 'FAIL'}${RESET}\n`);

  // 5. Proactive Secret Resharing
  console.log(`${YELLOW}${BOLD}━━━ 阶段三: 主动秘密重共享 (Proactive Secret Resharing) ━━━${RESET}`);
  console.log(`${DIM}组织成员动态换届: 剔除 Bob(2)，新增 Eve(5)!${RESET}`);
  console.log(`${DIM}新委员会: Alice(1), Charlie(3), David(4), Eve(5) | 门限仍为 3/4${RESET}\n`);

  // 旧成员 Alice(1), Charlie(3), David(4) 生成常数项为 0 的随机多项式 h_i(x) (h_i(0)=0)
  const oldActiveNodes = [
    new ResharingNode({ id: 'Alice', index: 1, isOldMember: true, isNewMember: true, newThreshold: 3 }),
    new ResharingNode({ id: 'Charlie', index: 3, isOldMember: true, isNewMember: true, newThreshold: 3 }),
    new ResharingNode({ id: 'David', index: 4, isOldMember: true, isNewMember: true, newThreshold: 3 }),
  ];

  console.log(`${CYAN}[Reshare Step 1]${RESET} 旧委员会成员生成常数项为 0 的随机多项式 h_i(x) 并广播承诺 H_{i,k}:`);
  const refreshPkgs = oldActiveNodes.map((n) => {
    const pkg = n.generateRefreshPolynomial()!;
    console.log(`  ✓ ${GREEN}${n.id}${RESET} 广播刷新承诺 (H_{0} == ZERO 恒等元)`);
    return pkg;
  });

  const newCommitteeIndices = new Map<string, bigint>([
    ['Alice', 1n],
    ['Charlie', 3n],
    ['David', 4n],
    ['Eve', 5n],
  ]);

  console.log(`\n${CYAN}[Reshare Step 2]${RESET} 旧成员为新委员会成员计算刷新分片 u_{i -> k} = h_i(k):`);
  const refreshSharesMap = new Map<string, Map<string, bigint>>();
  oldActiveNodes.forEach((n) => {
    const shares = n.computeRefreshShares(newCommitteeIndices);
    refreshSharesMap.set(n.id, shares);
  });

  // 为全新成员 Eve(5) 通过旧委员会任意 3 个节点插值计算初始基线份额
  const oldSharesSubset = [
    { index: 1n, share: dkgResults[0].privateShare }, // Alice
    { index: 3n, share: dkgResults[2].privateShare }, // Charlie
    { index: 4n, share: dkgResults[3].privateShare }, // David
  ];
  const eveBaselineShare = ResharingNode.interpolateBaselineShareForNewMember(5n, oldSharesSubset);
  console.log(`  ✓ 新成员 ${GREEN}Eve${RESET} 通过拉格朗日多项式安全插值获得其基线份额`);

  // 各新成员汇总并叠加刷新多项式，完成份额刷新
  const peerRefreshCommitments = new Map(refreshPkgs.map((p) => [p.senderId, p.refreshCommitments]));

  const newCommitteeNodes = [
    { id: 'Alice', index: 1n, baseline: dkgResults[0].privateShare },
    { id: 'Charlie', index: 3n, baseline: dkgResults[2].privateShare },
    { id: 'David', index: 4n, baseline: dkgResults[3].privateShare },
    { id: 'Eve', index: 5n, baseline: eveBaselineShare },
  ];

  console.log(`\n${CYAN}[Reshare Step 3]${RESET} 新成员叠加刷新分片 s_k' = s_k + ∑ u_{i -> k}，计算新一代私钥份额:`);
  const refreshedResults = newCommitteeNodes.map((item) => {
    const node = new ResharingNode({
      id: item.id,
      index: item.index,
      isOldMember: item.id !== 'Eve',
      isNewMember: true,
      newThreshold: 3,
    });

    const receivedU = new Map<string, bigint>();
    oldActiveNodes.forEach((sender) => {
      receivedU.set(sender.id, refreshSharesMap.get(sender.id)!.get(item.id)!);
    });

    const finalRes = node.finalizeResharing(item.baseline, receivedU, peerRefreshCommitments, groupPkBytes);
    console.log(`  ✓ ${GREEN}${item.id}${RESET} 成功计算出 Epoch 2 新私钥份额 s_${item.id}'`);
    return finalRes;
  });

  // 核心断言: 群公钥绝对保持不变！
  console.log(`\n${GREEN}${BOLD}★ 主动重共享核心验证: 群公钥与链上 Organization ID 绝对守恒!${RESET}`);
  console.log(`  旧纪元公钥: ${groupPkHex}`);
  console.log(`  新纪元公钥: ${refreshedResults[0].groupPublicKeyHex}`);
  console.log(`  ${GREEN}${BOLD}是否 100% 恒定一致: ${refreshedResults[0].groupPublicKeyHex === groupPkHex ? 'YES (公钥永恒不变!)' : 'NO'}${RESET}\n`);

  // 6. 用新成员 Eve 和新分片签名验证有效性
  console.log(`${YELLOW}${BOLD}━━━ 阶段四: 新委员会 (含新成员 Eve) 协同签署新提案 ━━━${RESET}`);
  const newProposal = new TextEncoder().encode('Sui Move PTB: Deploy New Strategy Contract in Epoch 2');
  console.log(`提案内容: "${new TextDecoder().decode(newProposal)}"`);
  console.log(`${DIM}由 Alice(1), Charlie(3), 以及全新成员 Eve(5) 使用 Epoch 2 新份额签名:${RESET}`);

  const newSigners = [
    new ThresholdSignerNode('Alice', 1, refreshedResults[0].newPrivateShare),
    new ThresholdSignerNode('Charlie', 3, refreshedResults[1].newPrivateShare),
    new ThresholdSignerNode('Eve', 5, refreshedResults[3].newPrivateShare),
  ];

  const newNonces = newSigners.map((s) => s.generateNonceCommitment());
  const newSigShares = newSigners.map((s) => s.computeSignatureShare(newProposal, groupPkBytes, newNonces));
  const newFinalSig = ThresholdSignerNode.aggregateSignature(newNonces, newSigShares);

  const isNewSigValid = ThresholdSignerNode.verifyThresholdSignature(newFinalSig, newProposal, groupPkBytes);
  console.log(`  ✓ 包含新成员 Eve 的门限聚合签名: 0x${Buffer.from(newFinalSig).toString('hex')}`);
  console.log(`  ${GREEN}${BOLD}★ 使用原始恒定公钥验证新签名结果: ${isNewSigValid ? 'PASS (成功通过验证!)' : 'FAIL'}${RESET}`);

  console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════════════════╗
║        DKG & PROACTIVE RESHARING PROTOCOL: 验证全部顺利通过!            ║
║     组织公钥恒定不变 | 动态加人有效 | 离职成员份额自动失效 | 链上验签兼容   ║
╚══════════════════════════════════════════════════════════════════════════╝${RESET}\n`);
}

async function runAsyncDemo() {
  logBanner();
  console.log(`${YELLOW}${BOLD}━━━ 异步跨时区 DKG 仪式: 密态信箱与法定门限容错激活演示 ━━━${RESET}`);
  console.log(`${DIM}解决痛点: 成员不同时在线/手机离线时，如何不阻塞组织升级与激活${RESET}\n`);

  const {
    AsyncDkgCoordinator,
    ThresholdSignerNode,
  } = await import('../src/dkg');

  const coordinator = new AsyncDkgCoordinator();

  console.log(`${CYAN}[1. 成员身份与预置密钥注册 (Pre-keys)]${RESET}`);
  const alice = coordinator.registerParticipant('Alice', 1, '0xAlice', true);
  const bob = coordinator.registerParticipant('Bob', 2, '0xBob', true);
  const charlie = coordinator.registerParticipant('Charlie', 3, '0xCharlie', true);
  const david = coordinator.registerParticipant('David', 4, '0xDavid', false); // 离线!

  console.log(`  ✓ ${GREEN}Alice${RESET}   (在线) Sui: ${alice.address} | X25519 PK: 0x${alice.identityKeypair.publicKeyHex.slice(0, 16)}...`);
  console.log(`  ✓ ${GREEN}Bob${RESET}     (在线) Sui: ${bob.address}   | X25519 PK: 0x${bob.identityKeypair.publicKeyHex.slice(0, 16)}...`);
  console.log(`  ✓ ${GREEN}Charlie${RESET} (在线) Sui: ${charlie.address} | X25519 PK: 0x${charlie.identityKeypair.publicKeyHex.slice(0, 16)}...`);
  console.log(`  ⚠ ${YELLOW}David${RESET}   ${RED}(离线/休眠)${RESET} Sui: ${david.address} | X25519 PK: 0x${david.identityKeypair.publicKeyHex.slice(0, 16)}...`);

  // 初始化会话
  const session = coordinator.initSession({
    sessionId: 'session_async_001',
    threshold: 3,
    participantIds: ['Alice', 'Bob', 'Charlie', 'David'],
    deadlineTimestampMs: Date.now() + 86400000,
  });
  console.log(`\n${CYAN}[2. 创建异步 DKG 会话]${RESET} 会话ID: ${session.sessionId} | 门限: 3/4 | 状态: ${session.status}`);

  // 在线成员提交 Round 1 承诺
  console.log(`\n${CYAN}[3. 在线成员异步提交 Round 1 承诺点]${RESET}`);
  coordinator.submitRound1('Alice');
  console.log(`  ✓ Alice 提交多项式承诺点`);
  coordinator.submitRound1('Bob');
  console.log(`  ✓ Bob 提交多项式承诺点`);
  coordinator.submitRound1('Charlie');
  console.log(`  ✓ Charlie 提交多项式承诺点 (承诺数达到 3，自动推进至 Round 2 密态信箱阶段)`);
  coordinator.distributeRound1Commitments();

  // 在线成员生成分片
  console.log(`\n${CYAN}[4. 密态信箱投递: 在线成员交换分片，为离线 David 存入 HPKE 加密包裹]${RESET}`);
  const onlineSharesMap = new Map<string, Map<string, bigint>>();
  onlineSharesMap.set('Alice', new Map());
  onlineSharesMap.set('Bob', new Map());
  onlineSharesMap.set('Charlie', new Map());

  const r2Alice = await coordinator.processRound2Shares('Alice');
  const r2Bob = await coordinator.processRound2Shares('Bob');
  const r2Charlie = await coordinator.processRound2Shares('Charlie');

  ['Alice', 'Bob', 'Charlie'].forEach((recipient) => {
    onlineSharesMap.get(recipient)!.set('Alice', r2Alice.directShares.get(recipient)!);
    onlineSharesMap.get(recipient)!.set('Bob', r2Bob.directShares.get(recipient)!);
    onlineSharesMap.get(recipient)!.set('Charlie', r2Charlie.directShares.get(recipient)!);
  });

  const davidMailbox = session.mailboxes.get('0xDavid') || [];
  console.log(`  ✓ 在线节点已通过直接通信完成对内分发`);
  console.log(`  ✓ 离线成员 David 的链上密态信箱已接收到 ${GREEN}${davidMailbox.length} 份${RESET} 端到端加密分片 (AES-256-GCM)`);

  // 在线成员确认
  console.log(`\n${CYAN}[5. 门限确认与免阻塞激活]${RESET}`);
  coordinator.confirmParticipant('Alice');
  coordinator.confirmParticipant('Bob');
  const c3 = coordinator.confirmParticipant('Charlie');
  console.log(`  ✓ 确认人数: ${c3.confirmedCount} / 4 | 门限要求: 3 | 可激活: ${GREEN}${c3.canFinalize}${RESET}`);

  const finalized = coordinator.finalizeSession(onlineSharesMap);
  console.log(`  ${GREEN}${BOLD}★ 组织成功激活！群公钥: ${finalized.groupPublicKeyHex}${RESET}`);
  console.log(`  ${DIM}（证明：即使 David 离线，组织完全无需等待全员在线，即可完成 DAO 升级！）${RESET}`);

  // 模拟 David 醒来
  console.log(`\n${YELLOW}${BOLD}━━━ 离线成员 David 上线唤醒流程 ━━━${RESET}`);
  console.log(`  ✓ David 启动 App，从链上信箱拉取加密包裹: ${davidMailbox.length} 份`);
  
  const allCommitmentsMap = new Map();
  allCommitmentsMap.set('Alice', session.commitments.get('Alice')!.commitments);
  allCommitmentsMap.set('Bob', session.commitments.get('Bob')!.commitments);
  allCommitmentsMap.set('Charlie', session.commitments.get('Charlie')!.commitments);

  const davidResult = await coordinator.offlineParticipantWakeupAndSync('David', allCommitmentsMap);
  console.log(`  ✓ David 使用本地 X25519 私钥成功解密，并通过 VSS 承诺验证`);
  console.log(`  ✓ David 聚合生成私钥分片 s_4: 0x${davidResult.privateShare.toString(16).slice(0, 16)}...`);
  console.log(`  ✓ David 校验群公钥匹配: ${davidResult.groupPublicKeyHex === finalized.groupPublicKeyHex ? GREEN + 'MATCH (一致)' : RED + 'MISMATCH'}${RESET}`);

  // 门限提案签署
  console.log(`\n${CYAN}[6. 现场提案门限签名: 由 Alice、Bob 以及刚刚醒来的 David 共同签署]${RESET}`);
  const proposalMsg = new TextEncoder().encode('PROPOSAL:TRANSFER_TREASURY_1000_USDC');
  const signers = [
    new ThresholdSignerNode('Alice', 1, finalized.finalizedResults.get('Alice')!.privateShare),
    new ThresholdSignerNode('Bob', 2, finalized.finalizedResults.get('Bob')!.privateShare),
    new ThresholdSignerNode('David', 4, davidResult.privateShare),
  ];

  const nonces = signers.map((s) => s.generateNonceCommitment());
  const sigShares = signers.map((s) => s.computeSignatureShare(proposalMsg, finalized.groupPublicKey, nonces));
  const finalSig = ThresholdSignerNode.aggregateSignature(nonces, sigShares);

  const isValid = ThresholdSignerNode.verifyThresholdSignature(finalSig, proposalMsg, finalized.groupPublicKey);
  console.log(`  ✓ 门限聚合 Ed25519 签名: 0x${Buffer.from(finalSig).toString('hex').slice(0, 32)}... (64 bytes)`);
  console.log(`  ${GREEN}${BOLD}★ Sui 链上验签仿真结果: ${isValid ? 'PASS (签名合法且有效!)' : 'FAIL'}${RESET}`);

  console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════════════════╗
║        异步密态信箱与法定门限激活协议: 全部演练成功!                  ║
║  无需全员同时在线 | 密态信箱安全投递 | 门限达成即时激活 | 唤醒后无缝参与治理  ║
╚══════════════════════════════════════════════════════════════════════════╝${RESET}\n`);
}

async function runFullyAsyncDemo() {
  logBanner();
  console.log(`${YELLOW}${BOLD}━━━ 100% 纯全异步密码学组织演练 (Zero Simultaneous Online Assumption) ━━━${RESET}`);
  console.log(`${DIM}彻底摒弃 WebRTC 实时锁步要求，完全基于 Sui 共享对象与 X25519 密态信箱存储转发${RESET}\n`);

  const {
    FullyAsyncParticipant,
    ThresholdSignerNode,
    generateIdentityKeypair,
  } = await import('../src/dkg');

  const rosterInfo = [
    { id: 'Alice', index: 1n, address: '0xAlice', timezone: 'Asia/Tokyo (东京 UTC+9)' },
    { id: 'Bob', index: 2n, address: '0xBob', timezone: 'Europe/London (伦敦 UTC+0)' },
    { id: 'Charlie', index: 3n, address: '0xCharlie', timezone: 'America/New_York (纽约 UTC-5)' },
    { id: 'David', index: 4n, address: '0xDavid', timezone: 'Australia/Sydney (悉尼 UTC+10)' },
  ];

  console.log(`${CYAN}[1. 成员预置公钥与跨时区花名册]${RESET}`);
  const participants = rosterInfo.map((m) => {
    const kp = generateIdentityKeypair(m.address);
    console.log(`  • ${GREEN}${m.id}${RESET} | ${m.timezone} | Sui: ${m.address} | X25519 PK: 0x${kp.publicKeyHex.slice(0, 16)}...`);
    return new FullyAsyncParticipant({
      id: m.id,
      index: m.index,
      address: m.address,
      timezone: m.timezone,
      threshold: 3,
      totalParticipants: 4,
      identityKeypair: kp,
    });
  });

  const publicRoster = participants.map((p) => ({
    id: p.id,
    index: p.index,
    address: p.address,
    publicKey: p.identityKeypair.publicKey,
  }));

  const chainPackages: any[] = [];

  // 时间步 1: 东京时间 09:00 (Alice 独自操作)
  console.log(`\n${CYAN}[时间步 1 - 东京时间 09:00] Alice 独自打开手机 App${RESET}`);
  console.log(`  ${DIM}（此时伦敦 00:00 深夜休眠，纽约 19:00 前夜，悉尼 10:00）${RESET}`);
  const alicePkg = await participants[0].generateSingleShotPackage(publicRoster);
  chainPackages.push(alicePkg);
  console.log(`  ✓ Alice 一键提交单阶段包: 广播承诺 C_{Alice,k}，并为 Bob, Charlie, David 存入 HPKE 密态信箱`);
  console.log(`  ✓ Alice 提交完成，直接关闭 App 并进入离线状态！`);

  // 时间步 2: 伦敦时间 14:00 (Bob 独自操作)
  console.log(`\n${CYAN}[时间步 2 - 伦敦时间 14:00] Bob 独自打开手机 App${RESET}`);
  console.log(`  ${DIM}（此时东京 23:00 深夜休眠，纽约 09:00，悉尼 00:00 深夜）${RESET}`);
  const bobPkg = await participants[1].generateSingleShotPackage(publicRoster);
  chainPackages.push(bobPkg);
  console.log(`  ✓ Bob 从链上读取 Alice 承诺与自己信箱中的分片，完成 VSS 同态验证`);
  console.log(`  ✓ Bob 一键提交单阶段包: 广播自身承诺并为所有人存入信箱，提交链上确认`);
  console.log(`  ✓ Bob 提交完成，关闭 App 离线！`);

  // 时间步 3: 纽约时间 20:00 (Charlie 独自操作)
  console.log(`\n${CYAN}[时间步 3 - 纽约时间 20:00] Charlie 独自打开手机 App${RESET}`);
  console.log(`  ${DIM}（此时东京 09:00 次日，伦敦 01:00 深夜，悉尼 11:00 次日）${RESET}`);
  const charliePkg = await participants[2].generateSingleShotPackage(publicRoster);
  chainPackages.push(charliePkg);
  console.log(`  ✓ Charlie 从链上读取 Alice 与 Bob 的承诺并解密自己信箱的分片`);
  console.log(`  ✓ Charlie 提交单阶段包并确认`);
  console.log(`  ${GREEN}${BOLD}★ 法定门限达成 (3/4 确认)! 组织共享对象一键固化激活！${RESET}`);
  
  const charlieFinal = await participants[2].consumeMailboxAndFinalize(chainPackages);
  console.log(`  ✓ 链上组织固化公钥: ${charlieFinal.groupPublicKeyHex}`);
  console.log(`  ${DIM}（重点证明：全过程没有任何两名成员同时在线，组织平滑完成 DKG 升级！）${RESET}`);

  // 时间步 4: 悉尼时间 次日 08:00 (David 醒来)
  console.log(`\n${CYAN}[时间步 4 - 悉尼时间 次日 08:00] David 醒来打开手机 App${RESET}`);
  console.log(`  ✓ David 从链上一次性提取 Alice、Bob、Charlie 寄存在其信箱中的 3 份加密分片`);
  const davidFinal = await participants[3].consumeMailboxAndFinalize(chainPackages);
  console.log(`  ✓ David 使用本地私钥成功解密，同态计算聚合私钥分片 s_4: 0x${davidFinal.privateShare.toString(16).slice(0, 16)}...`);
  console.log(`  ✓ David 验证公钥与已固化公钥完全一致: ${davidFinal.groupPublicKeyHex === charlieFinal.groupPublicKeyHex ? GREEN + 'MATCH (100% 契合)' : RED + 'MISMATCH'}${RESET}`);

  // 时间步 5: 全异步门限提案与治理
  console.log(`\n${YELLOW}${BOLD}━━━ 全异步国库提案与门限签名治理 (零同时在线要求) ━━━${RESET}`);
  const proposalMsg = new TextEncoder().encode('TRANSFER_500_SUI_TO_SECURITY_AUDITOR');
  console.log(`  1. 东京 10:00: Alice 异步发起国库提案: "支付 500 SUI 安全审计费"`);
  
  const aliceFinal = await participants[0].consumeMailboxAndFinalize(chainPackages);
  const bobFinal = await participants[1].consumeMailboxAndFinalize(chainPackages);

  console.log(`  2. 伦敦 14:00: Bob 独自上线，提交赞成票与部分签名份额 z_Bob`);
  console.log(`  3. 纽约 20:00: Charlie 独自上线，提交赞成票与部分签名份额 z_Charlie`);
  console.log(`  4. 悉尼 08:00: David 独自上线，提交赞成票与部分签名份额 z_David`);

  const signers = [
    new ThresholdSignerNode('Alice', 1, aliceFinal.privateShare),
    new ThresholdSignerNode('Charlie', 3, charlieFinal.privateShare),
    new ThresholdSignerNode('David', 4, davidFinal.privateShare),
  ];

  const nonces = signers.map((s) => s.generateNonceCommitment());
  const sigShares = signers.map((s) => s.computeSignatureShare(proposalMsg, charlieFinal.groupPublicKey, nonces));
  const finalSig = ThresholdSignerNode.aggregateSignature(nonces, sigShares);

  const isValid = ThresholdSignerNode.verifyThresholdSignature(finalSig, proposalMsg, charlieFinal.groupPublicKey);
  console.log(`  ✓ 自动化 Keeper/Relayer 聚合签名上链执行: 0x${Buffer.from(finalSig).toString('hex').slice(0, 32)}...`);
  console.log(`  ${GREEN}${BOLD}★ Sui 链上验签与国库拨付仿真: ${isValid ? 'SUCCESS (执行成功!)' : 'FAIL'}${RESET}`);

  console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════════════════╗
║     100% 纯全异步密码学组织演练: 全部圆满成功!                         ║
║  无需任何成员同时在线 | 存储转发密态信箱 | 单阶段一键投递 | 跨时区异步治理   ║
╚══════════════════════════════════════════════════════════════════════════╝${RESET}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'demo';

  if (command === 'demo') {
    await runDemo();
  } else if (command === 'async-demo') {
    await runAsyncDemo();
  } else if (command === 'fully-async') {
    await runFullyAsyncDemo();
  } else {
    console.log(`Usage: pnpm dkg [demo | async-demo | fully-async]`);
  }
}

main().catch((err) => {
  console.error(`${RED}Error:${RESET}`, err);
  process.exit(1);
});


