# Cryptographic Security Specification: Resharing, Erasure Assumptions, and Key Rotation

**Protocol**: Sui Universal Cryptographic Organization Protocol  
**Package**: `agent_vault::cryptographic_org`, `agent_vault::dkg_committee`  
**SDK**: `@sui-universal/sdk/dkg` (`resharing.ts`, `threshold_signer.ts`, `vss.ts`)  
**Standard**: FROST (Two-Round Threshold Schnorr/Ed25519) & Pure Gennaro Proactive Secret Resharing (Gennaro et al. 1999)

---

## 1. Executive Summary & Core Security Notice

Key-preserving secret resharing allows a threshold committee to change its threshold $(t_{\text{old}}, n_{\text{old}}) \to (t_{\text{new}}, n_{\text{new}})$, migrate participants, and refresh private secret shares **without changing the on-chain group public key $Y$**.

### ⚠️ The Fundamental Erasure Limitation
> **Key-preserving resharing CANNOT cryptographically revoke an expelled or hostile committee member who refuses to erase their old share.**

If a removed member preserves their epoch $e$ share $s_i$ and colludes with $t_{\text{old}} - 1$ other members who have access to (or leaked) their epoch $e$ shares, the colluders can reconstruct the underlying private master key:
$$s = \sum_{j \in S} \lambda_j \cdot s_j$$

Because key-preserving resharing leaves the group public key $Y = s \cdot G$ invariant on-chain, any signature computed with $s$ will evaluate as valid under `sui::ed25519::ed25519_verify`.

**Therefore, the protocol never advertises key-preserving resharing as "hostile revocation".** For scenarios where an adversary, rogue insider, or compromised node must be permanently excluded without trusting them to zeroize private memory, the protocol provides **`rotate_group_key`**.

---

## 2. Mathematical Foundations: Pure Gennaro Resharing

The SDK implements pure Gennaro Proactive Secret Resharing (Gennaro, Jarecki, Krawczyk, Rabin, 1999) on curve Ed25519.

### 2.1 Share Normalization and Sub-polynomials
Let $S \subseteq \{1, \dots, n_{\text{old}}\}$ be a qualified set of old active committee members with $|S| \ge t_{\text{old}}$. Each participant $P_i \in S$ holds an old private share $s_i$.
1. Each dealer $P_i$ computes their Lagrange basis evaluation at zero:
   $$z_i = \lambda_{i, S}(0) \cdot s_i \pmod \ell$$
   Notice that $\sum_{i \in S} z_i = s \pmod \ell$.
2. Dealer $P_i$ samples a random polynomial $g_i(x)$ of degree $t_{\text{new}} - 1$ where the constant term is $z_i$:
   $$g_i(x) = z_i + a_{i,1} x + a_{i,2} x^2 + \dots + a_{i, t_{\text{new}}-1} x^{t_{\text{new}}-1} \pmod \ell$$
3. Dealer $P_i$ evaluates sub-shares for each new committee member $P_k \in \{1, \dots, n_{\text{new}}\}$:
   $$w_{i \to k} = g_i(k) \pmod \ell$$
4. Dealer $P_i$ broadcasts Feldman VSS commitments to all coefficients:
   $$C_{i,l} = a_{i,l} \cdot G \quad \text{for } l \in \{0, \dots, t_{\text{new}}-1\}, \quad \text{with } C_{i,0} = z_i \cdot G$$

### 2.2 Sub-share Verification and Aggregation
Every new recipient $P_k$ verifies the sub-share received from dealer $P_i$:
$$w_{i \to k} \cdot G \stackrel{?}{=} \sum_{l=0}^{t_{\text{new}}-1} k^l \cdot C_{i,l}$$
Upon verification from all qualified dealers $Q \subseteq S$ ($|Q| \ge t_{\text{old}}$), participant $P_k$ computes their new epoch share:
$$s'_k = \sum_{i \in Q} w_{i \to k} \pmod \ell$$

### 2.3 On-Chain and Curve Exponent Public Key Invariance
Any qualified subset $S' \subseteq \{1, \dots, n_{\text{new}}\}$ of size $t_{\text{new}}$ satisfies:
$$\sum_{k \in S'} \lambda_{k, S'}(0) \cdot s'_k \cdot G = \sum_{k \in S'} \lambda_{k, S'}(0) \sum_{i \in Q} g_i(k) \cdot G = \sum_{i \in Q} g_i(0) \cdot G = \sum_{i \in Q} z_i \cdot G = s \cdot G = Y$$
In `@sui-universal/sdk/dkg/resharing.ts`, the new group public key is **never passed through from caller input**. It is explicitly recomputed in the curve exponent ($\sum_{k \in S'} \lambda_k s'_k \cdot G$) and validated against the initial group public key.

---

## 3. Threat Model and Erasure Assumptions

### 3.1 Mobile Adversary Model
Proactive secret sharing was designed for the *mobile adversary* model:
- An attacker can compromise at most $t_{\text{old}} - 1$ participants in epoch $e$.
- The attacker then moves and compromises at most $t_{\text{new}} - 1$ participants in epoch $e+1$.
- **Security Guarantee**: As long as participants in epoch $e$ **completely erase** their old shares $s_i$ and intermediate polynomials $g_i(x)$ at the end of epoch $e$, the attacker learns zero information about the secret $s$.

### 3.2 Failure of Erasure (Byzantine Collusion)
If $t_{\text{old}}$ old shares from epoch $e$ are ever captured—whether by an ex-member refusing to delete disk state, physical memory dumps, or collusion among dismissed signers:
1. Resharing does **not** alter the secret $s$.
2. The old shares remain valid polynomial evaluations of the original secret $s$.
3. The group public key $Y$ registered on the Sui blockchain has not changed.
4. The colluding parties can synthesize standard valid Ed25519 signatures that satisfy `sui::ed25519::ed25519_verify(&sig, &org.group_pk, &digest)`.

---

## 4. Dual Operational Modes: Epoch Advance vs Key Rotation

The protocol cleanly separates routine committee transitions from hostile revocation via two distinct on-chain primitives:

```
                          ┌────────────────────────┐
                          │ Committee Reconfiguration│
                          └───────────┬────────────┘
                                      │
                   Is the removed party trusted to erase
                   their private share, or is this routine
                   re-balancing / hardware migration?
                                     / \
                                    /   \
                             YES   /     \   NO (Adversarial /
                                  /       \      Compromised)
                                 v         v
                     ┌──────────────────┐  ┌──────────────────┐
                     │ Key-Preserving   │  │ Full Key         │
                     │ Resharing        │  │ Rotation         │
                     │ advance_epoch    │  │ rotate_group_key │
                     └─────────┬────────┘  └─────────┬────────┘
                               │                     │
                    Public Key │          Public Key │
                     Invariant │             Changed │
                               v                     v
                     Org PK Remains Y     Org PK Becomes Y_new
                     Epoch = e + 1        Epoch = e + 1
```

### Mode Comparison Matrix

| Property | `advance_organization_epoch` | `rotate_group_key` |
|---|---|---|
| **Underlying Math** | Gennaro Proactive Secret Resharing | Fresh FROST DKG Ceremony |
| **Group Public Key ($Y$)** | **Unchanged** (100% curve invariant) | **Replaced** ($Y_{\text{new}} = s_{\text{new}} \cdot G$) |
| **Erasure Assumption** | **Strictly Required**: honest local deletion of old shares | **Zero Trust**: even if 100% of old shares leak, $Y_{\text{new}}$ is secure |
| **Primary Use Case** | Periodic proactive refresh, routine node turnover, threshold adjustment | Stolen private keys, rogue operator, adversarial expulsion |
| **On-Chain Function** | `cryptographic_org::advance_organization_epoch` | `cryptographic_org::rotate_group_key` |
| **Domain Constant** | `SUI_ORG_APPROVAL_V1:` | `SUI_ORG_KEY_ROTATION_V1:` |
| **Authorization** | Threshold signature from current epoch | Threshold signature from current epoch |

---

## 5. On-Chain Smart Contract Implementation

Both operations are secured by Move smart contracts in `packages/contracts/agent_vault/sources/cryptographic_org.move`.

### 5.1 Replay Protection & Domain Separation
All administrative updates require a strictly monotonic `nonce > org.last_nonce` and cryptographic domain separation:

```move
const DOMAIN_PROPOSAL: vector<u8> = b"SUI_ORG_PROPOSAL_V1:";
const DOMAIN_THRESHOLD_APPROVAL: vector<u8> = b"SUI_ORG_APPROVAL_V1:";
const DOMAIN_KEY_ROTATION: vector<u8> = b"SUI_ORG_KEY_ROTATION_V1:";

// Digest binding: SHA256(DOMAIN || chain_id || org_id || epoch || nonce || new_group_pk)
public fun compute_key_rotation_digest(
    chain_id: &vector<u8>,
    org_id: ID,
    epoch_version: u64,
    nonce: u64,
    new_group_pk: &vector<u8>
): vector<u8> {
    let mut data = vector::empty<u8>();
    vector::append(&mut data, DOMAIN_KEY_ROTATION);
    vector::append(&mut data, *chain_id);
    vector::append(&mut data, bcs::to_bytes(&org_id));
    vector::append(&mut data, bcs::to_bytes(&epoch_version));
    vector::append(&mut data, bcs::to_bytes(&nonce));
    vector::append(&mut data, *new_group_pk);
    hash::sha2_256(data)
}
```

### 5.2 Atomic Key Rotation
`rotate_group_key` verifies authorization under the *current* valid threshold key before atomically updating `org.group_pk`:

```move
public fun rotate_group_key(
    org: &mut Organization,
    nonce: u64,
    new_group_pk: vector<u8>,
    frost_signature: vector<u8>,
    _ctx: &mut TxContext
) {
    assert!(vector::length(&new_group_pk) == 32, E_INVALID_PK_LENGTH);
    assert!(nonce > org.last_nonce, E_INVALID_NONCE);
    let org_id = object::uid_to_inner(&org.id);
    let next_epoch = org.epoch_version + 1;

    let rotation_digest = compute_key_rotation_digest(
        &org.chain_id,
        org_id,
        org.epoch_version,
        nonce,
        &new_group_pk
    );

    assert!(!table::contains(&org.executed_proposals, rotation_digest), E_PROPOSAL_ALREADY_EXECUTED);
    let is_valid = ed25519::ed25519_verify(&frost_signature, &org.group_pk, &rotation_digest);
    assert!(is_valid, E_INVALID_SIGNATURE);

    let old_pk = org.group_pk;
    table::add(&mut org.executed_proposals, rotation_digest, true);
    org.last_nonce = nonce;
    org.epoch_version = next_epoch;
    org.group_pk = new_group_pk;

    event::emit(GroupKeyRotatedEvent {
        org_id,
        old_group_pk: old_pk,
        new_group_pk,
        new_epoch_version: next_epoch,
    });
}
```

---

## 6. Off-Chain Dealer Honesty: Schnorr Proof of Knowledge

In pure Gennaro resharing, a malicious dealer could choose a polynomial $g_i(x)$ whose constant term $z_i \ne \lambda_i(0) \cdot s_i$, skewing the new master key.

### Why Off-Chain Verification is Required
Verifying that $C_{i,0} = \lambda_i(0) \cdot Y_i$ on-chain would require native Ed25519 point scalar multiplication and point comparison. Because Sui Move standard library (`sui::ed25519`) only exposes `ed25519_verify` (and does not expose point addition or curve scalar multiplication in Move bytecode), dealer honesty is validated off-chain during Round 1 by all participants.

### Schnorr PoK Specification
Each dealer $P_i$ produces a non-interactive Schnorr Proof of Knowledge (Fiat-Shamir transformed):
1. Dealer chooses random scalar $r \leftarrow \mathbb{Z}_\ell^*$ and computes commitment $R = r \cdot G$.
2. Challenge is computed with explicit domain and context binding:
   $$\text{challenge} = \text{SHA-256}(\text{"POK\_V1:"} \parallel \text{org\_id} \parallel \text{epoch} \parallel i \parallel C_{i,0} \parallel R)$$
3. Dealer computes response $s = r + \text{challenge} \cdot z_i \pmod \ell$.
4. Every peer verifies:
   $$s \cdot G \stackrel{?}{=} R + \text{challenge} \cdot C_{i,0}$$
If any dealer fails this verification, the participant is flagged as Byzantine and excluded from the qualified dealer set $Q$ before session finalization.

---

## 7. Operational Guidelines for Operators

1. **Schedule Regular Resharing**: Perform `advance_organization_epoch` on a regular cadence (e.g., monthly) to prevent passive leakage accumulation across servers.
2. **Execute Strict Zeroization**: Ensure node operators run automated memory zeroization scripts that wipe previous epoch share files and private memory immediately after receiving the `OrganizationEpochUpdatedEvent`.
3. **Trigger Immediate Key Rotation upon Breach**: If any node credentials or HSM partitions are suspected to be compromised, do **NOT** rely on secret resharing. Execute a fresh DKG and submit `rotate_group_key`.
