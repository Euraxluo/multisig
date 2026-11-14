/**
 * Concurrently executes on-chain transactions across all 5 local Sui wallets on Sui Testnet.
 *
 * Covers:
 * 1. Concurrent Swaps (SUI -> VIRUS)
 * 2. Concurrent Add Liquidity (Mints real LPCoin objects on chain)
 * 3. Concurrent Remove Liquidity (Burns real LPCoin objects on chain)
 *
 * Requirements:
 * - Real transactions submitted on-chain to Sui Testnet (NO mock/local simulation).
 * - All 5 local wallets loaded from ~/.sui/sui_config/sui.keystore.
 * - Concurrently dispatched via Promise.all.
 * - Collects on-chain digests, verifies status.success === true, and outputs Suiscan explorer URLs.
 */
import fs from 'fs';
import path from 'path';
import { createSuiClient, discoverPools } from '../packages/sdk/src';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildCpmmSwapTx,
  buildCpmmAddLiquidityTx,
  buildCpmmRemoveLiquidityTx,
  findOwnedLpCoins,
} from '../apps/web/src/lib/onchainTx';
import { getNetworkContracts, SUI_TOKEN, VIRUS_TOKEN } from '../packages/shared/src';

interface WalletTxResult {
  index: number;
  action: string;
  address: string;
  digest: string;
  success: boolean;
  error?: string;
  durationMs: number;
  explorerUrl: string;
}

export async function runConcurrentTransactions(): Promise<void> {
  console.log('===============================================================');
  console.log('  CONCURRENT 5-WALLET ON-CHAIN TESTNET TRANSACTION SUITE       ');
  console.log('  Testing: Swaps, Add Liquidity, Remove Liquidity on chain     ');
  console.log('===============================================================\n');

  const client = createSuiClient('testnet');
  const contracts = getNetworkContracts('testnet');

  // 1. Load keystore
  const keystorePath = path.join(process.env.HOME || '', '.sui', 'sui_config', 'sui.keystore');
  if (!fs.existsSync(keystorePath)) {
    throw new Error(`Sui keystore not found at ${keystorePath}`);
  }

  const keystoreRaw: string[] = JSON.parse(fs.readFileSync(keystorePath, 'utf8'));
  const keypairs = keystoreRaw.map((entry) => {
    const buf = Buffer.from(entry, 'base64');
    return Ed25519Keypair.fromSecretKey(buf.subarray(1));
  });

  console.log(`Loaded ${keypairs.length} local wallets from keystore:`);
  keypairs.forEach((kp, i) => {
    console.log(`  [Wallet ${i + 1}] ${kp.toSuiAddress()}`);
  });

  // 2. Discover live pool
  console.log('\nDiscovering live CPMM pool on Sui Testnet...');
  const pools = await discoverPools('testnet');
  if (pools.length === 0) {
    throw new Error('No on-chain pools found on Sui Testnet!');
  }
  const pool = pools[0];
  console.log(`Target Pool ID: ${pool.poolId}`);
  console.log(`  Pair: SUI / VIRUS`);
  console.log(`  Reserves: X=${pool.reserveX.toString()} (SUI), Y=${pool.reserveY.toString()} (VIRUS)`);

  // ===============================================================
  // PHASE 1: Concurrent Swaps (5 wallets)
  // ===============================================================
  const swapAmountMIST = 50_000n;
  console.log(`\n---------------------------------------------------------------`);
  console.log(`PHASE 1: 5 Concurrent Swaps (${swapAmountMIST} MIST SUI -> VIRUS)...`);
  console.log(`---------------------------------------------------------------`);

  const swapTasks = keypairs.map(async (kp, idx) => {
    const address = kp.toSuiAddress();
    const startTime = Date.now();
    try {
      const tx = buildCpmmSwapTx({
        contracts,
        pool,
        tokenIn: SUI_TOKEN,
        tokenOut: VIRUS_TOKEN,
        amountIn: swapAmountMIST,
        minAmountOut: 1n,
        sender: address,
      });

      const res = await client.signAndExecuteTransaction({ transaction: tx, signer: kp });
      const digest = res.Transaction.digest;
      const success = res.Transaction.status?.success ?? false;
      const durationMs = Date.now() - startTime;
      return {
        index: idx + 1,
        action: 'SWAP',
        address,
        digest,
        success,
        durationMs,
        explorerUrl: `https://suiscan.xyz/testnet/tx/${digest}`,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      return {
        index: idx + 1,
        action: 'SWAP',
        address,
        digest: 'N/A',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
        explorerUrl: '',
      };
    }
  });

  const swapStart = Date.now();
  const swapResults = await Promise.all(swapTasks);
  const swapElapsed = Date.now() - swapStart;

  console.log(`Phase 1 Complete (Elapsed: ${swapElapsed}ms):`);
  swapResults.forEach((r) => {
    console.log(`  [${r.success ? 'PASS' : 'FAIL'}] Wallet ${r.index}: ${r.digest} (${r.durationMs}ms)`);
  });

  // ===============================================================
  // PHASE 2: Concurrent Add Liquidity (5 wallets mint real LPCoin)
  // ===============================================================
  const addAmountX = 10_000n; // 0.00001 SUI
  const addAmountY = (addAmountX * pool.reserveY) / pool.reserveX;
  console.log(`\n---------------------------------------------------------------`);
  console.log(`PHASE 2: 5 Concurrent Add Liquidity (${addAmountX} SUI + ${addAmountY} VIRUS)...`);
  console.log(`---------------------------------------------------------------`);

  const addTasks = keypairs.map(async (kp, idx) => {
    const address = kp.toSuiAddress();
    const startTime = Date.now();
    try {
      // Find an owned VIRUS coin for this wallet
      const virusCoins = await client.listCoins({ owner: address, coinType: pool.typeArguments[1] });
      if (virusCoins.objects.length === 0) {
        throw new Error(`No VIRUS coin found for wallet ${address}`);
      }
      const virusCoinId = virusCoins.objects[0].objectId;

      const tx = buildCpmmAddLiquidityTx({
        contracts,
        pool,
        amountA: addAmountX,
        amountB: addAmountY,
        sender: address,
        inputCoinBId: virusCoinId,
        minLp: 1n,
      });

      const res = await client.signAndExecuteTransaction({ transaction: tx, signer: kp });
      const digest = res.Transaction.digest;
      const success = res.Transaction.status?.success ?? false;
      const durationMs = Date.now() - startTime;
      return {
        index: idx + 1,
        action: 'ADD_LIQUIDITY',
        address,
        digest,
        success,
        durationMs,
        explorerUrl: `https://suiscan.xyz/testnet/tx/${digest}`,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      return {
        index: idx + 1,
        action: 'ADD_LIQUIDITY',
        address,
        digest: 'N/A',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
        explorerUrl: '',
      };
    }
  });

  const addStart = Date.now();
  const addResults = await Promise.all(addTasks);
  const addElapsed = Date.now() - addStart;

  console.log(`Phase 2 Complete (Elapsed: ${addElapsed}ms):`);
  addResults.forEach((r) => {
    console.log(`  [${r.success ? 'PASS' : 'FAIL'}] Wallet ${r.index}: ${r.digest} (${r.durationMs}ms)`);
  });

  // Wait 1.5s for checkpoint finalization before querying LP tokens
  await new Promise((r) => setTimeout(r, 1500));

  // ===============================================================
  // PHASE 3: Concurrent Remove Liquidity (5 wallets burn real LPCoin)
  // ===============================================================
  console.log(`\n---------------------------------------------------------------`);
  console.log(`PHASE 3: 5 Concurrent Remove Liquidity (Burn minted LPCoin)...`);
  console.log(`---------------------------------------------------------------`);

  const removeTasks = keypairs.map(async (kp, idx) => {
    const address = kp.toSuiAddress();
    const startTime = Date.now();
    try {
      const ownedLps = await findOwnedLpCoins('testnet', address, contracts, pool);
      if (ownedLps.length === 0) {
        throw new Error(`No on-chain LPCoin object found for wallet ${address}`);
      }
      const targetLp = ownedLps[0];

      const tx = buildCpmmRemoveLiquidityTx({
        contracts,
        pool,
        lpCoinId: targetLp.objectId,
        sender: address,
        minAmountX: 1n,
        minAmountY: 1n,
      });

      const res = await client.signAndExecuteTransaction({ transaction: tx, signer: kp });
      const digest = res.Transaction.digest;
      const success = res.Transaction.status?.success ?? false;
      const durationMs = Date.now() - startTime;
      return {
        index: idx + 1,
        action: 'REMOVE_LIQUIDITY',
        address,
        digest,
        success,
        durationMs,
        explorerUrl: `https://suiscan.xyz/testnet/tx/${digest}`,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      return {
        index: idx + 1,
        action: 'REMOVE_LIQUIDITY',
        address,
        digest: 'N/A',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
        explorerUrl: '',
      };
    }
  });

  const removeStart = Date.now();
  const removeResults = await Promise.all(removeTasks);
  const removeElapsed = Date.now() - removeStart;

  console.log(`Phase 3 Complete (Elapsed: ${removeElapsed}ms):`);
  removeResults.forEach((r) => {
    console.log(`  [${r.success ? 'PASS' : 'FAIL'}] Wallet ${r.index}: ${r.digest} (${r.durationMs}ms)`);
  });

  // Final summary
  const allResults = [...swapResults, ...addResults, ...removeResults];
  const allPassed = allResults.every((r) => r.success);

  console.log('\n===============================================================');
  console.log(`  ALL ON-CHAIN PHASES SUMMARY (${allResults.filter((r) => r.success).length}/${allResults.length} PASSED)`);
  console.log('===============================================================\n');

  for (const r of allResults) {
    console.log(`[${r.action}] Wallet ${r.index} (${r.address}):`);
    console.log(`  Digest:   ${r.digest}`);
    console.log(`  Explorer: ${r.explorerUrl || r.error}`);
    console.log(`  Latency:  ${r.durationMs}ms\n`);
  }

  if (!allPassed) {
    throw new Error('Some concurrent on-chain transactions failed.');
  }

  console.log('>>> 15/15 Concurrent on-chain transactions confirmed on Sui Testnet! <<<\n');
}

if (process.argv[1] && process.argv[1].endsWith('concurrent_onchain_txs.ts')) {
  runConcurrentTransactions()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal execution error:', err);
      process.exit(1);
    });
}
