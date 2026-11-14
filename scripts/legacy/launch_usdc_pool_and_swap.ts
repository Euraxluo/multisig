import { createSuiClient, discoverPools } from '../packages/sdk/src';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildCreateCpmmPoolTx,
  buildCpmmSwapTx,
  findInputCoin,
} from '../apps/web/src/lib/onchainTx';
import {
  getNetworkContracts,
  SUI_TOKEN,
  TESTNET_USDC_TOKEN,
  canonicalCoinType,
} from '../packages/shared/src';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('===============================================================');
  console.log('  LAUNCHING SUI / USDC CPMM POOL & EXECUTING TESTNET SWAP      ');
  console.log('===============================================================\n');

  const client = createSuiClient('testnet');
  const contracts = getNetworkContracts('testnet');

  // Load Keypairs
  const keystorePath = path.join(process.env.HOME || '', '.sui', 'sui_config', 'sui.keystore');
  const keystoreRaw: string[] = JSON.parse(fs.readFileSync(keystorePath, 'utf8'));
  const keypairs = keystoreRaw.map((entry) => {
    const buf = Buffer.from(entry, 'base64');
    return Ed25519Keypair.fromSecretKey(buf.subarray(1));
  });

  // Wallet 1 (eager-malachite) has 0.20 SUI and 20 USDC
  const kpWallet1 = keypairs[4];
  const wallet1Address = kpWallet1.toSuiAddress();
  console.log('Wallet 1 (Creator):', wallet1Address);

  // 1. Check existing pools for SUI/USDC
  console.log('\n--- Checking Existing On-Chain Pools ---');
  let pools = await discoverPools('testnet');
  let usdcPool = pools.find((p) => {
    const [x, y] = p.typeArguments.map(canonicalCoinType);
    const targetX = canonicalCoinType(SUI_TOKEN.address);
    const targetY = canonicalCoinType(TESTNET_USDC_TOKEN.address);
    return (x === targetX && y === targetY) || (x === targetY && y === targetX);
  });

  if (!usdcPool) {
    console.log('No SUI/USDC pool found on testnet. Creating new on-chain pool...');
    
    // Initial liquidity: 0.02 SUI (20,000,000 MIST) + 2.00 USDC (2,000,000 units)
    const amountX = 20_000_000n; // 0.02 SUI
    const amountY = 2_000_000n;  // 2 USDC (decimals: 6)

    const coinYObjectId = await findInputCoin(
      'testnet',
      wallet1Address,
      TESTNET_USDC_TOKEN.address,
      amountY
    );

    if (!coinYObjectId) {
      throw new Error(`No USDC coin found with balance >= ${amountY}`);
    }
    console.log(`Using USDC Coin Object: ${coinYObjectId}`);

    const createPoolTx = buildCreateCpmmPoolTx({
      contracts,
      coinTypeX: SUI_TOKEN.address,
      coinTypeY: TESTNET_USDC_TOKEN.address,
      amountX,
      amountY,
      coinYObjectId,
      sender: wallet1Address,
      feeBps: 30n,
      protocolFeeShareBps: 1000n,
      requirePolicy: false,
    });

    console.log('Submitting create_pool transaction on Sui Testnet...');
    const createRes = await client.signAndExecuteTransaction({
      transaction: createPoolTx,
      signer: kpWallet1,
    });

    const createDigest = createRes.Transaction.digest;
    const createSuccess = createRes.Transaction.status?.success ?? false;
    console.log(`Create Pool Result: ${createSuccess ? 'SUCCESS' : 'FAILED'}`);
    console.log(`Create Pool Digest: ${createDigest}`);
    console.log(`Suiscan: https://suiscan.xyz/testnet/tx/${createDigest}`);

    if (!createSuccess) {
      throw new Error('Create pool transaction failed!');
    }

    // Wait 2s and re-discover pools
    await new Promise((r) => setTimeout(r, 2500));
    for (let retry = 0; retry < 5; retry++) {
      pools = await discoverPools('testnet');
      usdcPool = pools.find((p) => {
        const [x, y] = p.typeArguments.map(canonicalCoinType);
        const targetX = canonicalCoinType(SUI_TOKEN.address);
        const targetY = canonicalCoinType(TESTNET_USDC_TOKEN.address);
        return (x === targetX && y === targetY) || (x === targetY && y === targetX);
      });
      if (usdcPool) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (!usdcPool) {
    throw new Error('Failed to discover SUI/USDC pool after creation');
  }

  console.log('\n===============================================================');
  console.log(`Discovered Live SUI/USDC Pool ID: ${usdcPool.poolId}`);
  console.log(`Reserve SUI: ${usdcPool.reserveX.toString()}`);
  console.log(`Reserve USDC: ${usdcPool.reserveY.toString()}`);
  console.log(`Suiscan: https://suiscan.xyz/testnet/object/${usdcPool.poolId}`);
  console.log('===============================================================\n');

  // 2. Perform a Live Swap: 0.001 SUI -> USDC
  console.log('--- Submitting Live Swap: 0.001 SUI -> USDC on Testnet ---');
  const swapAmountIn = 1_000_000n; // 0.001 SUI
  const swapTx = buildCpmmSwapTx({
    contracts,
    pool: usdcPool,
    tokenIn: SUI_TOKEN,
    tokenOut: TESTNET_USDC_TOKEN,
    amountIn: swapAmountIn,
    minAmountOut: 1n,
    sender: wallet1Address,
  });

  const swapRes = await client.signAndExecuteTransaction({
    transaction: swapTx,
    signer: kpWallet1,
  });

  const swapDigest = swapRes.Transaction.digest;
  const swapSuccess = swapRes.Transaction.status?.success ?? false;
  console.log(`Swap Result: ${swapSuccess ? 'SUCCESS' : 'FAILED'}`);
  console.log(`Swap Digest: ${swapDigest}`);
  console.log(`Suiscan: https://suiscan.xyz/testnet/tx/${swapDigest}`);

  // Re-read pool reserves after swap
  await new Promise((r) => setTimeout(r, 1500));
  const updatedPools = await discoverPools('testnet');
  const updatedUsdcPool = updatedPools.find((p) => p.poolId === usdcPool!.poolId);
  if (updatedUsdcPool) {
    console.log(`Updated Reserve SUI: ${updatedUsdcPool.reserveX.toString()}`);
    console.log(`Updated Reserve USDC: ${updatedUsdcPool.reserveY.toString()}`);
  }

  console.log('\n===============================================================');
  console.log('  ALL USDC ON-CHAIN ACTIONS COMPLETED SUCCESSFULLY!            ');
  console.log('===============================================================');
}

main().catch(console.error);
