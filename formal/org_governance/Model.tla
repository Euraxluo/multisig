------------------------------ MODULE Model ------------------------------
(* Cryptographic-organization governance state machine.
   Source of truth: contracts/agent_vault/sources/cryptographic_org.move on
   origin/main (commit a4396c1). Anchors:
     advance_organization_epoch   :654-685   (epoch +1, pk and key_generation
                                              unchanged — key-preserving resharing)
     rotate_group_key             :770-846   (pk replaced, key_generation +1,
                                              key_signers replaced)
     update_organization_roster   :866-960   (roster + threshold replaced,
                                              epoch +1; key_signers must all
                                              survive — EKeySignerRemoved :908)
     withdraw_genesis_stake       :695-735   (hard lock :705, then monotonic
                                              nonce + digest replay guard)
     execute_threshold_proposal   :611-651   (records a digest, changes no
                                              governance field)

   What is ABSTRACTED (stated, not hidden):
   - Ed25519 verification is not computed. A signature is modelled as the
     tuple of fields its digest binds (see each digest function, :510-608,
     :740-757), and it verifies iff it was issued by a key that is, or ever
     was, the org's group_pk. This encodes the protocol's own premise from
     docs/RESHARING_SECURITY.md §3.2: old shares of an unrotated key stay
     valid forever, because resharing does not change the secret.
   - Nonces are unbounded naturals with a strict `>` check (:620, :660, :704,
     :797, :913). The executed_proposals table is therefore redundant for
     replay and is omitted; the one thing it adds (cross-action digest
     collision) is impossible across the distinct domain constants.
   - `weights` and the numeric threshold are collapsed to one bit,
     `thresholdBelowKey` (:899, E_THRESHOLD_BELOW_KEY = 1009). The exact
     weight arithmetic is tested in cryptographic_org_roster_tests.move.
   - key_signers retention (:997-1005) is collapsed to one bit `excludesSigner`.
   - Genesis stake is one indivisible unit: locked until `now` passes
     `unlockAt`, then withdrawable exactly once.
   - DKG finalization, PoP byte checks and roster shape checks (:782-795,
     :876-893) are admission filters. A transition that would fail one of them
     is simply not enabled here; they are tested in org_pop_tests.move.

   CONSTANTS
     Keys   = {K1, K2}   group public keys the org may hold
     Nonces = {1, 2, 3}  the nonce values anyone may attempt
     Horizons = {0, 1, 2}  genesis-stake unlock deadlines
*)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Keys, Nonces, Horizons

VARIABLES
    epoch,            \* epoch_version; create() sets 1  (:211)
    pk,               \* group_pk                                    (:209)
    keyGen,           \* key_generation; create() sets 1, only rotate bumps it (:222, :837)
    lastNonce,        \* last_nonce; create() sets 0                 (:212)
    thresholdBelowKey,\* governance threshold < FROST key threshold? (:899)
    excludesSigner,   \* a live key signer is absent from the roster? (:997)
    stake,            \* genesis stake: "locked" | "free" | "taken"
    unlockAt,         \* genesis_unlock_at_ms, in model time units   (:221)
    now,              \* clock.timestamp_ms                          (:705)
    sigs              \* every signature ever produced: [kind, by, nonce, payload]

vars == <<epoch, pk, keyGen, lastNonce, thresholdBelowKey, excludesSigner,
          stake, unlockAt, now, sigs>>

Payloads == {"roster_ok", "roster_drop_signer", "roster_low_threshold"}

(* ------------------------------------------------------------------ *)
(* Signature validity. A signature verifies under the org's CURRENT  *)
(* group key when some key that ever signed it is the current pk.    *)
(* Because advance keeps pk, a signature issued before a resharing    *)
(* still verifies after it — docs/RESHARING_SECURITY.md §3.2.          *)
(* ------------------------------------------------------------------ *)
IssuedBy(s, k) == \E i \in DOMAIN sigs : sigs[i] = s /\ s.by = k

VerifiesNow(s) == IssuedBy(s, pk)

Fresh(n) == n > lastNonce

(* ------------------------------------------------------------------ *)
(* Actions. Each is one public entry, named so a counterexample reads *)
(* as a transaction sequence.                                  *)
(* ------------------------------------------------------------------ *)

\* :654 advance_organization_epoch — key-preserving resharing.
\* Digest binds (:562): chain, org, epoch, nonce, next epoch, key_generation.
\* Notably NOT a new key: the public key is unchanged by construction.
Advance(n) ==
    /\ Fresh(n)
    /\ LET s == [kind |-> "advance", by |-> pk, nonce |-> n,
                 payload |-> <<epoch, keyGen>>] IN
       /\ TRUE
       /\ epoch' = epoch + 1
       /\ lastNonce' = n
       /\ sigs' = Append(sigs, s)
       /\ UNCHANGED <<pk, keyGen, thresholdBelowKey, excludesSigner, stake, unlockAt, now>>

\* :770 rotate_group_key — hostile revocation. Replaces the key, so every
\* shard of the previous key stops verifying, and bumps key_generation so the
\* two V2 digests (advance, treasury transfer) bind the new generation (:833).
Rotate(n, newPk) ==
    /\ Fresh(n)
    /\ newPk \in Keys
    /\ LET s == [kind |-> "rotate", by |-> pk, nonce |-> n,
                 payload |-> <<epoch, newPk>>] IN
       /\ TRUE
       /\ pk' = newPk
       /\ keyGen' = keyGen + 1
       /\ epoch' = epoch + 1
       /\ lastNonce' = n
       /\ excludesSigner' = FALSE
       /\ sigs' = Append(sigs, s)
       /\ UNCHANGED <<thresholdBelowKey, stake, unlockAt, now>>

\* :866 update_organization_roster. The on-chain checks are ordered
\* shape, covers_current_roster, key_signers_retained, threshold, no-op,
\* nonce, replay, signature. A payload that fails one is rejected outright;
\* only "roster_ok" passes.
Roster(n, payload) ==
    /\ Fresh(n)
    /\ payload = "roster_ok"
    /\ LET s == [kind |-> "roster", by |-> pk, nonce |-> n,
                 payload |-> <<epoch, payload>>] IN
       /\ epoch' = epoch + 1
       /\ lastNonce' = n
       /\ thresholdBelowKey' = FALSE
       /\ excludesSigner' = FALSE
       /\ sigs' = Append(sigs, s)
       /\ UNCHANGED <<pk, keyGen, stake, unlockAt, now>>

\* The same entry WITHOUT the two guards added for issues #9 and #15
\* (key_signers_retained :908, threshold floor :899). Exists so the
\* isolation configuration can show each guard is independently load-bearing.
RosterUnguarded(n, payload) ==
    /\ Fresh(n)
    /\ LET s == [kind |-> "roster", by |-> pk, nonce |-> n,
                 payload |-> <<epoch, payload>>] IN
       /\ epoch' = epoch + 1
       /\ lastNonce' = n
       /\ thresholdBelowKey' = (payload = "roster_low_threshold")
       /\ excludesSigner' = (payload = "roster_drop_signer")
       /\ sigs' = Append(sigs, s)
       /\ UNCHANGED <<pk, keyGen, stake, unlockAt, now>>

\* :695 withdraw_genesis_stake. Hard lock first, then nonce and signature.
Withdraw(n) ==
    /\ stake = "free"
    /\ now >= unlockAt
    /\ Fresh(n)
    /\ LET s == [kind |-> "withdraw", by |-> pk, nonce |-> n,
                 payload |-> <<epoch, "stake">>] IN
       /\ stake' = "taken"
       /\ lastNonce' = n
       /\ sigs' = Append(sigs, s)
       /\ UNCHANGED <<epoch, pk, keyGen, thresholdBelowKey, excludesSigner, unlockAt, now>>

\* :611 execute_threshold_proposal — consumes a nonce, records the digest,
\* changes nothing this model tracks. Included because it shares last_nonce
\* with every other action, so it can invalidate a prepared signature.
Execute(n) ==
    /\ Fresh(n)
    /\ LET s == [kind |-> "execute", by |-> pk, nonce |-> n,
                 payload |-> <<epoch, n>>] IN
       /\ lastNonce' = n
       /\ sigs' = Append(sigs, s)
       /\ UNCHANGED <<epoch, pk, keyGen, thresholdBelowKey, excludesSigner, stake, unlockAt, now>>

\* Wall clock. Advances until the hard lock expires, which is also what frees
\* the genesis stake (:705 reads clock.timestamp_ms >= genesis_unlock_at_ms).
Tick ==
    /\ now < 2
    /\ now' = now + 1
    /\ stake' = IF stake = "locked" /\ now + 1 >= unlockAt THEN "free" ELSE stake
    /\ UNCHANGED <<epoch, pk, keyGen, lastNonce, thresholdBelowKey, excludesSigner, unlockAt, sigs>>

\* Terminal stutter, so TLC's deadlock check is not tripped by a finished org.
Done == UNCHANGED vars

(* ------------------------------------------------------------------ *)
\* The guarded transition relation is the code as it is on main.
Next ==
    \/ \E n \in Nonces : Advance(n)
    \/ \E n \in Nonces, k \in Keys : Rotate(n, k)
    \/ \E n \in Nonces : Roster(n, "roster_ok")
    \/ \E n \in Nonces : Withdraw(n)
    \/ \E n \in Nonces : Execute(n)
    \/ Tick
    \/ Done

\* isolation: the roster guards removed, everything else identical.
NextUnguarded ==
    \/ \E n \in Nonces : Advance(n)
    \/ \E n \in Nonces, k \in Keys : Rotate(n, k)
    \/ \E n \in Nonces, p \in Payloads : RosterUnguarded(n, p)
    \/ \E n \in Nonces : Withdraw(n)
    \/ \E n \in Nonces : Execute(n)
    \/ Tick
    \/ Done
\* SpecBroken: rotate() authorizes a new key but the digest does not bind WHICH
\* new key — the pre-#23 shape. The resulting signature can be re-spent to
\* install a different key than the signers approved.
RotateUnbound(n) ==
    /\ Fresh(n)
    /\ \E installed \in Keys :
        /\ LET s == [kind |-> "rotate", by |-> pk, nonce |-> n,
                     payload |-> <<epoch, "unbound">>] IN
            /\ pk' = installed
            /\ keyGen' = keyGen + 1
            /\ epoch' = epoch + 1
            /\ lastNonce' = n
            /\ excludesSigner' = FALSE
            /\ sigs' = Append(sigs, s)
            /\ UNCHANGED <<thresholdBelowKey, stake, unlockAt, now>>

NextBroken ==
    \/ \E n \in Nonces : Advance(n)
    \/ \E n \in Nonces : RotateUnbound(n)
    \/ \E n \in Nonces : Roster(n, "roster_ok")
    \/ \E n \in Nonces : Withdraw(n)
    \/ \E n \in Nonces : Execute(n)
    \/ Tick
    \/ Done

\* create() at :207-223.
Init ==
    /\ epoch = 1
    /\ pk \in Keys
    /\ keyGen = 1
    /\ lastNonce = 0
    /\ thresholdBelowKey = FALSE
    /\ excludesSigner = FALSE
    /\ stake = "locked"
    /\ unlockAt \in Horizons
    /\ now = 0
    /\ sigs = <<>>
(* ------------------------------------------------------------------ *)
Spec == Init /\ [][Next]_vars
SpecUnguarded == Init /\ [][NextUnguarded]_vars
SpecBroken == Init /\ [][NextBroken]_vars

\* Liveness witness for the accepted residual (RESHARING_SECURITY.md §3.2):
\* some signature issued before any rotation keeps verifying after a later
\* epoch advance. TRUE on the real code; it would go FALSE if advance() were
\* ever changed to rotate the key.
AdvanceSurvivesResharing ==
    /\ \A s \in DOMAIN sigs :
        (sigs[s].kind = "advance") =>
            (((\A j \in DOMAIN sigs : (j > s) => (sigs[j].kind # "rotate"))) => VerifiesNow(sigs[s]))



(* ------------------------------------------------------------------ *)
(* Invariants. Each names the design clause it pins down.             *)
(* ------------------------------------------------------------------ *)

\* I1 (§4, mode table): key-preserving resharing must not be the only thing
\* standing between a hostile ex-member and the key. Concretely: if a key
\* signer has been dropped from the roster, the key they hold a share of must
\* no longer verify. rotate_group_key is what makes that true.
NoSignerOutsideGovernance ==
    excludesSigner => ~ \E s \in DOMAIN sigs : sigs[s].by = pk

\* I2 (cryptographic_org.move :892-899, issue #15): the governance threshold
\* never drops below the FROST key threshold, so a minority can neither approve
\* an action nor brick one.
GovernanceCoversKeyThreshold == ~thresholdBelowKey

\* I3 (issue #23, :510-528): a rotation authorization is bound to the new key.
\* Replaying the signature that installed key B cannot install key C.
\* A rotation digest binds the key it installs (compute_key_rotation_digest,
\* :510-528). Replaying the signature that installed key B cannot install key C,
\* because the payload records exactly one key and the state takes exactly that
\* The key a rotation claims to install is the second element of its payload
\* (:525 appends new_group_pk). On the real code that is exactly the key the
\* state ends up holding. Broken.cfg writes a constant there instead, so the
\* claim and the state come apart.
\* The key the org holds once signature s has been applied, defined only for the
\* most recent rotate: every earlier rotate was followed by another, so only the
\* last one's payload is still the live key. That is exactly the comparison a
\* replay attack fails — the old signature names a key the org no longer holds.
claimed(s) == sigs[s].payload[2]
pkAfter(s) == IF \A j \in DOMAIN sigs : j > s => sigs[j].kind # "rotate" THEN pk ELSE claimed(s)
RotationBindsNewKey ==
    /\ \A s \in DOMAIN sigs :
        sigs[s].kind = "rotate" => claimed(s) = pkAfter(s)

\* I4 (round 9, :833-837): key_generation moves iff the key was replaced, and
\* an epoch-advance authorization is bound to the generation it was signed
\* under. Old shards cannot authorize a resharing after a rotation, nor can a
\* resharing-signed digest be replayed once rotate has bumped the generation.
\* key_generation at the moment signature s was accepted: it starts at 1 and
\* rises by one for every earlier rotate. An advance binds exactly this.
keyGenAt(s) == 1 + Cardinality({i \in DOMAIN sigs : i < s /\ sigs[i].kind = "rotate"})

AdvanceBindsKeyGeneration ==
    /\ \A s \in DOMAIN sigs :
        sigs[s].kind = "advance" => sigs[s].payload[2] = keyGenAt(s)

\* I5 (:687-706): nothing releases the genesis stake before its hard lock, and
\* it is released at most once.
GenesisStakeHardLock ==
    (stake = "taken" => now >= unlockAt) /\ (stake = "locked" \/ stake = "free" \/ stake = "taken")

\* I6 (:620 and every sibling): a nonce never goes backwards and is never reused.
NonceMonotonic ==
    \A i, j \in DOMAIN sigs : i < j => sigs[i].nonce < sigs[j].nonce

\* I7 (§3.2, the accepted residual): BEFORE any rotation, a signature made by
\* the current key keeps verifying no matter how many resharing epochs pass.
\* This one is a PROPERTY, not a bug. It is here so the erasure limitation is
\* checked rather than assumed — see PreRotationSignatureStillValid in the cfg.
OldSignatureStillVerifies ==
    \A s \in DOMAIN sigs : sigs[s].by = pk => VerifiesNow(sigs[s])

=============================================================================*)
