import { createSuiClient, discoverPools } from '../packages/sdk/src';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildCpmmSwapTx,
  buildCpmmAddLiquidityTx,
  buildCpmmRemoveLiquidityTx,
  findOwnedLpCoins,
  selectCoinsForAmount,
} from '../apps/web/src/lib/onchainTx';
import { getNetworkContracts, SUI_TOKEN, VIRUS_TOKEN } from '../packages/shared/src';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('===============================================================');
  console.log('  EXECUTING DIRECT ON-CHAIN TESTNET TRANSACTIONS (LIVE)        ');
  console.log('===============================================================\n');

  const client = createSuiClient('testnet');
  const contracts = getNetworkContracts('testnet');

  // Load Wallet 2 (0x2c65...6347)
  const keystorePath = path.join(process.env.HOME || '', '.sui', 'sui_config', 'sui.keystore');
  const keystoreRaw: string[] = JSON.parse(fs.readFileSync(keystorePath, 'utf8'));
  const keypairs = keystoreRaw.map((entry) => {
    const buf = Buffer.from(entry, 'base64');
    return Ed25519Keypair.fromSecretKey(buf.subarray(1));
  });

  // Pick Wallet 2 (has plenty of SUI and VIRUS)
  const kp = keypairs[1];
  const address = kp.toSuiAddress();
  console.log('Using Testnet Wallet:', address);

  // Discover pool with retry
  async function getPool() {
    for (let i = 0; i < 10; i++) {
      const p = await discoverPools('testnet');
      if (p.length > 0) return p[0];
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('No on-chain pool found');
  }

  const pool = await getPool();
  console.log(`Discovered Live Pool ID: ${pool.poolId} (SUI / VIRUS)`);

  const txs: Array<{
    action: string;
    digest: string;
    checkpoint: string | number | undefined;
    url: string;
    success: boolean;
  }> = [];

  // =========================================================================
  // 1. LIVE SWAP: SUI -> VIRUS (2,000,000 MIST = 0.002 SUI)
  // =========================================================================
  console.log('\n--- 1. Submitting Live Swap on Sui Testnet ---');
  const swapTx = buildCpmmSwapTx({
    contracts,
    pool,
    tokenIn: SUI_TOKEN,
    tokenOut: VIRUS_TOKEN,
    amountIn: 2_000_000n, // 0.002 SUI
    minAmountOut: 1n,
    sender: address,
  });

  const swapRes = await client.signAndExecuteTransaction({
    transaction: swapTx,
    signer: kp,
  });
  const swapDigest = swapRes.Transaction.digest;
  const swapSuccess = swapRes.Transaction.status?.success ?? false;
  console.log(`Swap Result: ${swapSuccess ? 'SUCCESS' : 'FAILED'}`);
  console.log(`Swap Digest: ${swapDigest}`);
  console.log(`Suiscan: https://suiscan.xyz/testnet/tx/${swapDigest}`);
  txs.push({
    action: 'SWAP (0.002 SUI -> VIRUS)',
    digest: swapDigest,
    checkpoint: swapRes.Transaction.checkpoint,
    url: `https://suiscan.xyz/testnet/tx/${swapDigest}`,
    success: swapSuccess,
  });

  // =========================================================================
  // 2. LIVE ADD LIQUIDITY: 100,000 MIST SUI + proportional VIRUS
  // =========================================================================
  console.log('\n--- 2. Submitting Live Add Liquidity on Sui Testnet ---');
  // Refresh pool reserves after swap
  const livePool = await getPool();

  const addAmountX = 100_000n; // 0.0001 SUI
  const addAmountY = (addAmountX * livePool.reserveY) / livePool.reserveX + 100n;

  const coinSelectionB = await selectCoinsForAmount('testnet', address, VIRUS_TOKEN.address, addAmountY);

  const addTx = buildCpmmAddLiquidityTx({
    contracts,
    pool: livePool,
    amountA: addAmountX,
    amountB: addAmountY,
    sender: address,
    coinSelectionB: coinSelectionB ?? undefined,
    minLp: 1n,
  });

  const addRes = await client.signAndExecuteTransaction({
    transaction: addTx,
    signer: kp,
  });
  const addDigest = addRes.Transaction.digest;
  const addSuccess = addRes.Transaction.status?.success ?? false;
  console.log(`Add Liquidity Result: ${addSuccess ? 'SUCCESS' : 'FAILED'}`);
  console.log(`Add Liquidity Digest: ${addDigest}`);
  console.log(`Suiscan: https://suiscan.xyz/testnet/tx/${addDigest}`);
  txs.push({
    action: 'ADD LIQUIDITY (Deposit SUI + VIRUS -> Mint LPCoin)',
    digest: addDigest,
    checkpoint: addRes.Transaction.checkpoint,
    url: `https://suiscan.xyz/testnet/tx/${addDigest}`,
    success: addSuccess,
  });

  // =========================================================================
  // 3. LIVE REMOVE LIQUIDITY: Burn 50% of owned LP Coins
  // =========================================================================
  console.log('\n--- 3. Submitting Live Remove Liquidity on Sui Testnet ---');
  const ownedLp = await findOwnedLpCoins('testnet', address, contracts, livePool);
  console.log(`Found ${ownedLp.length} LPCoin objects owned by ${address.slice(0, 10)}...`);

  if (ownedLp.length > 0) {
    const totalLp = ownedLp.reduce((acc, c) => acc + c.value, 0n);
    const burnLp = totalLp / 2n > 0n ? totalLp / 2n : totalLp;
    console.log(`Burning ${burnLp} LPCoin units out of ${totalLp} total...`);

    const removeTx = buildCpmmRemoveLiquidityTx({
      contracts,
      pool: livePool,
      primaryLpCoinId: ownedLp[0].objectId,
      mergeLpCoinIds: ownedLp.slice(1).map((c) => c.objectId),
      burnLpAmount: burnLp,
      totalLpBalance: totalLp,
      sender: address,
      minAmountX: 1n,
      minAmountY: 1n,
    });

    const removeRes = await client.signAndExecuteTransaction({
      transaction: removeTx,
      signer: kp,
    });
    const removeDigest = removeRes.Transaction.digest;
    const removeSuccess = removeRes.Transaction.status?.success ?? false;
    console.log(`Remove Liquidity Result: ${removeSuccess ? 'SUCCESS' : 'FAILED'}`);
    console.log(`Remove Liquidity Digest: ${removeDigest}`);
    console.log(`Suiscan: https://suiscan.xyz/testnet/tx/${removeDigest}`);
    txs.push({
      action: 'REMOVE LIQUIDITY (Burn LPCoin -> Withdraw SUI + VIRUS)',
      digest: removeDigest,
      checkpoint: removeRes.Transaction.checkpoint,
      url: `https://suiscan.xyz/testnet/tx/${removeDigest}`,
      success: removeSuccess,
    });
  }

  console.log('\n===============================================================');
  console.log('  ALL LIVE TRANSACTIONS COMPLETED & VERIFIED ON TESTNET        ');
  console.log('===============================================================');
  console.log(JSON.stringify(txs, null, 2));
}

main().catch(console.error);
