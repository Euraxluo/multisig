import { NextRequest, NextResponse } from 'next/server';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { AgentVaultClient } from '@sui-universal/sdk';
import * as fs from 'fs';
import * as path from 'path';

const TESTNET_PACKAGE_ID = '0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36';

function getTestnetKeypair(): Ed25519Keypair {
  try {
    const suiConfigPath = path.join(process.env.HOME || '~', '.sui', 'sui_config', 'sui.keystore');
    if (fs.existsSync(suiConfigPath)) {
      const keystore: string[] = JSON.parse(fs.readFileSync(suiConfigPath, 'utf8'));
      // Search for the funded testnet address 0x8ac06d...
      for (const b64 of keystore) {
        const rawKey = Buffer.from(b64, 'base64');
        const secretKey = rawKey.slice(1, 33);
        const kp = Ed25519Keypair.fromSecretKey(secretKey);
        if (kp.toSuiAddress() === '0x8ac06d3d4328aff5bef88990741c1f620a96d5fc579bf2e459467763bd605788') {
          return kp;
        }
      }
      // Fallback to entry 4 or 0
      const raw = Buffer.from(keystore[4] || keystore[0], 'base64');
      return Ed25519Keypair.fromSecretKey(raw.slice(1, 33));
    }
  } catch (e) {
    console.warn('Keystore read fallback:', e);
  }
  // Generate random if keystore not accessible
  return new Ed25519Keypair();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    const client = new SuiGrpcClient({
      network: 'testnet',
      baseUrl: 'https://fullnode.testnet.sui.io:443',
    });
    const vaultClient = new AgentVaultClient({ packageId: TESTNET_PACKAGE_ID });
    const keypair = getTestnetKeypair();

    if (action === 'create_organization') {
      const { groupPk, thresholdWeight, members, weights } = body;
      const groupPkBytes = new Uint8Array(groupPk);

      const tx = vaultClient.buildCreateOrganizationPTB(
        groupPkBytes,
        thresholdWeight ?? 3,
        members,
        weights
      );

      const res = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        include: {
          effects: true,
          events: true,
        },
      });

      const txData = (res as any).Transaction || res;
      const digest = txData?.digest;

      let orgObjectId = '';
      if (txData?.effects?.changedObjects) {
        for (const obj of txData.effects.changedObjects) {
          if (obj.inputState === 'DoesNotExist' && obj.outputOwner?.$kind === 'Shared') {
            orgObjectId = obj.objectId;
            break;
          }
        }
      }

      if (!orgObjectId) {
        throw new Error('Failed to find created Organization object in tx effects');
      }

      return NextResponse.json({
        success: true,
        digest,
        orgObjectId,
        epoch: 1,
        packageId: TESTNET_PACKAGE_ID,
        suiscanTxUrl: `https://suiscan.xyz/testnet/tx/${digest}`,
        suiscanOrgUrl: `https://suiscan.xyz/testnet/object/${orgObjectId}`,
      });
    }

    if (action === 'advance_organization_epoch') {
      const { orgId, nonce, frostSignature } = body;
      const sigBytes = new Uint8Array(frostSignature);

      const tx = vaultClient.buildAdvanceOrganizationEpochPTB(
        orgId,
        nonce ?? 1,
        sigBytes
      );

      const res = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        include: {
          effects: true,
          events: true,
        },
      });

      const txData = (res as any).Transaction || res;
      const digest = txData?.digest;

      return NextResponse.json({
        success: true,
        digest,
        orgId,
        newEpoch: 2,
        suiscanTxUrl: `https://suiscan.xyz/testnet/tx/${digest}`,
        suiscanOrgUrl: `https://suiscan.xyz/testnet/object/${orgId}`,
      });
    }

    if (action === 'rotate_group_key') {
      const { orgId, nonce, newGroupPk, frostSignature } = body;
      const newPkBytes = new Uint8Array(newGroupPk);
      const sigBytes = new Uint8Array(frostSignature);

      const tx = vaultClient.buildRotateGroupKeyPTB(
        orgId,
        nonce ?? 1,
        newPkBytes,
        sigBytes
      );

      const res = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        include: {
          effects: true,
          events: true,
        },
      });

      const txData = (res as any).Transaction || res;
      const digest = txData?.digest;

      return NextResponse.json({
        success: true,
        digest,
        orgId,
        newGroupPk: Buffer.from(newPkBytes).toString('hex'),
        suiscanTxUrl: `https://suiscan.xyz/testnet/tx/${digest}`,
        suiscanOrgUrl: `https://suiscan.xyz/testnet/object/${orgId}`,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: any) {
    console.error('API /api/dao/execute error:', err);
    return NextResponse.json(
      {
        success: false,
        error: err.message || 'Transaction execution failed',
      },
      { status: 500 }
    );
  }
}
