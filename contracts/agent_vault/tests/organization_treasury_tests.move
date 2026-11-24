#[test_only]
module agent_vault::organization_treasury_tests;

use sui::{
    clock::{Self, Clock},
    coin::{Self, Coin},
    event,
    sui::SUI,
    test_scenario::{Self as ts, Scenario},
};
use agent_vault::{
    asynchronous_proposal::{Self as proposal, Proposal, ProposalExecutedEvent},
    cryptographic_org::{Self as org, Organization},
    organization_treasury::{
        Self as treasury, AgentAuthorityDelegated, OrganizationTreasury, TreasuryCreated,
        TreasuryOutflowPolicyUpdated, TransferBinding, TransferCreated,
    },
    vault::{Self, AgentVault, MasterCap, OperatorCap, AgentCap},
};

use fun fixture_end as TreasuryFixture.end;
use fun fixture_next_tx as TreasuryFixture.next_tx;
use fun fixture_ctx as TreasuryFixture.ctx;

// === Constants ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const ZERO_WEIGHT: address = @0xDA71D;
const RELAYER: address = @0xEE7E;
const RECIPIENT: address = @0x9999;
const OPERATOR: address = @0x0DEA;
const OPERATOR2: address = @0x0DDB;
const AGENT: address = @0xCAFE;
const ATTACKER: address = @0xBAD1;
const U64_MAX: u64 = 18446744073709551615;

/// A hundred fresh addresses: enough for one operator to fill the agent
/// registry (MAX_AGENTS_PER_VAULT) with junk cards.
const JUNK_AGENTS: vector<address> = vector[@0x10000, @0x10001, @0x10002, @0x10003, @0x10004, @0x10005, @0x10006, @0x10007, @0x10008, @0x10009, @0x1000a, @0x1000b, @0x1000c, @0x1000d, @0x1000e, @0x1000f, @0x10010, @0x10011, @0x10012, @0x10013, @0x10014, @0x10015, @0x10016, @0x10017, @0x10018, @0x10019, @0x1001a, @0x1001b, @0x1001c, @0x1001d, @0x1001e, @0x1001f, @0x10020, @0x10021, @0x10022, @0x10023, @0x10024, @0x10025, @0x10026, @0x10027, @0x10028, @0x10029, @0x1002a, @0x1002b, @0x1002c, @0x1002d, @0x1002e, @0x1002f, @0x10030, @0x10031, @0x10032, @0x10033, @0x10034, @0x10035, @0x10036, @0x10037, @0x10038, @0x10039, @0x1003a, @0x1003b, @0x1003c, @0x1003d, @0x1003e, @0x1003f, @0x10040, @0x10041, @0x10042, @0x10043, @0x10044, @0x10045, @0x10046, @0x10047, @0x10048, @0x10049, @0x1004a, @0x1004b, @0x1004c, @0x1004d, @0x1004e, @0x1004f, @0x10050, @0x10051, @0x10052, @0x10053, @0x10054, @0x10055, @0x10056, @0x10057, @0x10058, @0x10059, @0x1005a, @0x1005b, @0x1005c, @0x1005d, @0x1005e, @0x1005f, @0x10060, @0x10061, @0x10062, @0x10063];
const GROUP_PK: vector<u8> = x"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

// rt9 fixture keys (org_pop_tests provenance): SK1 = 0xab*32 (old key),
// SK2 = 0xcd*32 (rotated-to key). Used by the key-generation regression tests.
const PK1: vector<u8> = x"248acbdbaf9e050196de704bea2d68770e519150d103b587dae2d9cad53dd930";
const PK2: vector<u8> = x"fc947730f49eb01427a66e050733294d9e520e545c7a27125a780634e0860a27";

// Delegation caps pinned by every main-fixture signature (I3).
const DELEGATED_OUTFLOW: u64 = 1000;
const DELEGATED_BUDGET: u64 = 500;

// === I3 delegation fixtures ===
//
// The start_treasury layout is deterministic: txn0 = clock + org (O1),
// txn1 = treasury (T1 with vault V1), txn2 = deposit + bound proposal,
// txn3 = idle. The follow-ups used by the binding tests are txn4 = second
// treasury (T2 with vault V2) and txn5 = foreign org (O2). The signed digests
// were produced offline with node:crypto (seed 0x01*32 = GROUP_PK; layout
// mirrored from organization_treasury.move, zero shared code with the chain):
//
//   O1  = 0x5ef2fcf809fb9535ea0aeaea421f683026f06c34569aafc42bcde652ef6dd270
//   T1  = 0x90c5264c9da2b340fdc9fbd15ad3f0a181a57afa7ae55b15a3c5dce6b31f45c8
//   V1  = 0xd726ecf6f7036ee3557cd6c7b93a49b231070e8eecada9cfa157e40e3f02e5d3
//   T2  = 0xbfd1d3ac3d6c37f03afe4d7c244e677f9b01fcbff79dae3394640a7944e5f5ab
//   V2  = 0x1611edd9a9d42dbcd9ae773ffa22be0f6017b00590959dd5c767e4efcd34cd0b
//   O2  = 0x4b91c69db001e4d18e0c79058e6b83167d016a3ff50d13f17f35d3ef9e32fe5f
//
// SUI_ORG_TREASURY_AGENT_V1: || "sui-testnet:" || O1 || bcs(1) || bcs(1) ||
//   T1 || V1 || OPERATOR || bcs(1000) || bcs(500) || bcs(1)
const SIG_DELEGATE_N1: vector<u8> = x"75ebbacbcd72521b6c939bf156e4e13fbc8eda26b78c9fc3bd8ee469103936e10c586a7463eaf53b27d6c4a4c824d19135cafde0313e1e877b951667997f550a";

// Same layout at nonce 2 for OPERATOR2 with caps (800, 400): re-delegation.
const SIG_DELEGATE_N2_OTHER_OPERATOR: vector<u8> = x"978ed2a8ee9c3334ebef44f179a342743718755c145901470c0e45d8673a5a4b0bb083deec35e7572e61f5ac2cda4912e5526bd70932e700663a98729954f701";

// Same layout with O2 substituted: a signature valid only for another org.
const SIG_DELEGATE_FOREIGN_ORG: vector<u8> = x"198bdae5080816199a5453b5c3e640d3bf41a08236480bd4e9a5305553e83bf7c791a0aad0971405781de75620ba625f492e603d798f73ed5533ee8f81681a0f";

// Same layout with V2 substituted: a signature valid only for another vault.
const SIG_DELEGATE_FOREIGN_VAULT: vector<u8> = x"5e0a9cffece5c864ba991fff31ad6c07d9ee20390f8ca9153947ff8340eba709f4cf8ef0607a50e62a1cb08dad69698f647fdc148f9e00706a73d4bcd28fed0d";

// Same layout with (T2, V2) substituted: another treasury's signature.
const SIG_DELEGATE_FOREIGN_TREASURY: vector<u8> = x"1a568fba9c26df905efc0cb8404a22b4ba6004c0a6e4b467b972dcb4e7920e6b3bdc91896de4e7ee85be7ec2e9d2bddc8dd1f2344cf7596ad287e08f4271cf09";

// The exact SIG_DELEGATE_N1 digest signed by seed 0x02*32 instead of the org key.
const SIG_DELEGATE_WRONG_KEY: vector<u8> = x"9ad2f9e72ed45c8d6d4b2608760e4e56813b5a6c4a53b55aca715bcb2384ef22516795c565c7a06b75e1cdc638472701dce1dbfe915c0416479c4c080f130e08";

// SUI_ORG_TREASURY_OUTFLOW_V1: || "sui-testnet:" || O1 || bcs(1) || bcs(1) ||
//   T1 || V1 || bcs(50) || bcs(20) || bcs(1)
const SIG_OUTFLOW_SET_N1: vector<u8> = x"040cb7a33ad92eeec668a863c29c746392275b443b83b063501db4924433ae87582c36352d616bb27c485494fa3cc2c9a09cc15d0ff27e9426b13756991e8d0f";

// Same outflow layout at nonce 2 with zero caps: the governance stop switch.
const SIG_OUTFLOW_STOP_N2: vector<u8> = x"3d9ac52f59a7d4e9d8b5feb78c7ed4b46f34ae05644bed81471b488ab07a841cbdc734f2230e69c1c26de4fe30215932023006ce50356209caf5d8f231d6310b";

// Same layout at nonce 2 with (30, 20): an epoch cap exactly the size of the
// bound governance transfer.
const SIG_OUTFLOW_TIGHT_N2: vector<u8> = x"206c43eb9cbe3e9d6743a2e52e717387f34c6451113a8780d8e48fe2b85414237a05c12e2d832bf6a436db41b202bfddf601ef449e054d6f273eba1fff8af508";

// Same layout at nonce 2 with one cap zeroed: (40, 0) and (0, 20) are both
// stops, whatever the other cap says.
const SIG_OUTFLOW_ZERO_BUDGET_N2: vector<u8> = x"9fb202795591d3c5de5e6efa22981fcb9862370e3d6641a8b479d29b2b26fad52a7766f862434f161577c3e0fc304e1325de56f55697b8cbed889b28a4b27a07";
const SIG_OUTFLOW_ZERO_EPOCH_N2: vector<u8> = x"1c200a0ab3d4d1df3b14b4a146da8cedffdfccf655898326091857c46c1ff0f430bf934ea65a2de5567a14026ab31ad5ebfb7d8d33213350917560a746d0fd05";

// Positive caps (50, 20) at nonce 3: raising the caps again after a stop.
const SIG_OUTFLOW_REARM_N3: vector<u8> = x"796043173b836fd640c7ff89f17179925f7b3fe88529ee43f6b2fa70cc5c6a3fd1a8fa1587aa97da09e5f9cf33f44f189ed2abde618892320bb888c173d9f70e";

// The standard delegation again at nonce 4: a fresh delegation after a stop.
const SIG_DELEGATE_N4: vector<u8> = x"5f2e01c7fef8afe9d5ebfbcdfb1bdfd615a6876733936a10d9c0ebdd5741969f646c7515addcbc0bb5bb9df7fa5995e2ab1a0497ad7ad11639f5d49b889ef60c";

// OPERATOR with caps (20, 10) at nonce 1: an epoch cap below the bound
// transfer amount of 30.
const SIG_DELEGATE_SMALL_N1: vector<u8> = x"ef00b72f03bf7bbce1a5402ff1fd1f47aafda96e56a6b25b20e835066c27f9ed64c62f0c5cc5c7f024a377053db37212842ea41b5a383984b1ec54ea4b2bb000";

// Outflow layout at nonce 2 with (1000, 50): the epoch cap stays where the
// standard delegation put it, the per-agent cap drops to a tenth.
const SIG_OUTFLOW_LOWER_BUDGET_N2: vector<u8> = x"f0fc7dc36d64ae9b8cdd792f4dec5f23db66877c21ccee1051d691be34f77c229a679228e23c8eb517ccd61ce511c9ee8e8a6928abc4c1d577e52471bf947203";

// Delegation layout, caps (1000, 500): OPERATOR2 at nonce 3, and at nonce 1
// the operator replaced by one of the organization's own object addresses
// (T1, V1, O1). Those three are validly signed on purpose.
const SIG_DELEGATE_OPERATOR2_N3: vector<u8> = x"a491738acb00aabcb3e1197e22b19150260051180a2bb520abb7f1af30a0776bf996b2b76b01a519bd2cd628467fd80d935b9e77d912e547dc578c790e18a90f";
const SIG_DELEGATE_TO_TREASURY_N1: vector<u8> = x"f249c8c883c86f7eccf2b1cb97093c9c1677e6e7055a9688203faf426bad3f3e012dc3f619515e8a870dd084d6012476d7318a8df6aacb33127b42b33e681f07";
const SIG_DELEGATE_TO_VAULT_N1: vector<u8> = x"eccc60dc3c13daf999c17c2a34c6e8c552e9f9111c0179a8773f39629665b99ced4160ce3abda15c53299c75dcb367cfddb06d433377ef5f4b4662fe34d5f10a";
const SIG_DELEGATE_TO_ORG_N1: vector<u8> = x"bfe65d94dad0174d0df2b63da5a1cd997c7388924be5c46320b67a42ef480956072df9670a34d3a43e88d2edbbb594f592d769fe45dad8b89c12457f1468d50a";

// Outflow layout with O2 / V2 / (T2, V2) substituted, and the foreign-key
// signature over the exact outflow digest (seed 0x02*32).
const SIG_OUTFLOW_FOREIGN_ORG: vector<u8> = x"826a0a04fbda1c7a3763b5bc86e7f577b6da3f60c94ee17406fd5e9b6e5db6fcff2f6042be2755f64a5c9a7c0205fac74b62dbd8666cbd23bf67f507ee96b40e";
const SIG_OUTFLOW_FOREIGN_VAULT: vector<u8> = x"96c5a3934e21532682d038ddcd240d17c23cd715db2276b5fcb2958ea423bae1c2a124f98d53d775ef48f7e30209dce03799e536d39ccbeef8b3d126a9fb7103";
const SIG_OUTFLOW_FOREIGN_TREASURY: vector<u8> = x"7967354dd270cb0699d7d0442205b4c98b9520a03e62bb09296da4459f9178cd9867adf327d2bdb165e5064c45f2101fde9d1674d1ffa4d75d244c26aa5c6505";
const SIG_OUTFLOW_WRONG_KEY: vector<u8> = x"34f57557f6dd832a50659b13cd4ad864c355ebd6e8d84de0eb41b9ce972e5e01e96d0935d6d6bbff40aa7cf25a0a011d04228d2dc44063dd50245008c0bc0201";

// === Epoch binding ===
//
// SIG_OUTFLOW_REARM_N3 above is (50, 20) at epoch 1, nonce 3, so it doubles as
// the old-epoch outflow signature. The roster signature follows
// cryptographic_org's SUI_ORG_ROSTER_V1 layout:
//   || "sui-testnet:" || O1 || bcs(1) || bcs(2) || bcs(2) || bcs(3) ||
//   bcs([ALICE, BOB, ZERO_WEIGHT]) || bcs([2, 1, 1])
const SIG_ROSTER_N2: vector<u8> = x"cb83a71ed7db6be365a78926a783fc187d1d29eacfb018feda01a7b89b546268f6bfb37d9b69840659088fd1544d628a3fcfd09d1359827b07b9a0bddd158e0d";

// The standard delegation at nonce 3, signed for epoch 1 and for epoch 2.
const SIG_DELEGATE_N3_EPOCH1: vector<u8> = x"4798feaf8db5a9c5a190b487cd92124cce1c39e3b2365a656ede6507ecfff0fa063458463439233937f3fc2a9648de84e5338cc267cb49404a86173c87c7500e";
const SIG_DELEGATE_N3_EPOCH2: vector<u8> = x"f284eb12240e7a2188575f35f6f9386d849a5bbc374832296db0b855c4bc83988c30c51420832998e32575f7a069a617214914296ac4f30042b2829a2e6d1208";

// Outflow caps (50, 20) at nonce 3, signed for epoch 2.
const SIG_OUTFLOW_N3_EPOCH2: vector<u8> = x"5e343d42b06773e238570145a34e41ef86dcb651eba215a4094608c22cc5f3b4b6d2db33f1cb707cb440930e814719fb8b375256ae051708baa39267aad7a901";

// The SDK's golden digests (packages/multisig/src/agent-vault/org/
// digest-vectors.json), computed by scripts/golden-vectors-gen.mjs with
// node:crypto and no code shared with this package.
const SDK_GOLDEN_AGENT_DIGEST: vector<u8> = x"1a3418563eefbcc97b5c13a520c90b06fc31e667fc539d4ecd9d99ae44f2bd0b";
const SDK_GOLDEN_OUTFLOW_DIGEST: vector<u8> = x"4384a2c17b89d60cd654983f5364b53f48bbdd681e45522a574d9f3fe2318297";

// === I3 key-rotation fixtures (rt9 layout, SK1 = 0xab*32, SK2 = 0xcd*32) ===
//
// txn0 = org on PK1, txn1 = rotate to PK2 (nonce 1; epoch 1->2, kg 1->2),
// txn2 = treasury (OR with vault VR):
//
//   OR = 0xa4137e2ed945e7f4e8c307001c32e97472fb3eebb8f7b4ab7534b447d22da89b
//   TR = 0x7a10c02978bcfb401f9b47ec14da19003dea0355b33c23bd53764e4a854669a0
//   VR = 0xdba72804cc9504a82bbaa13ed4a83a0e2c6219d7e45125cf57fd10cbab957a97
//
// SUI_ORG_TREASURY_AGENT_V1 over epoch 2 / nonce 2 / kg 2: SK1 (must fail
// against PK2) and SK2 (positive control).
const SIG_ROT_OLDKEY: vector<u8> = x"8b3474c0a2cd8e48d538180c3f9b6c21587d78c366f0b4ff1aba5b73161fc1a256bcf7076aad3af54b6341c92a455dc6759a4cec3641ae26aaa5452b59b3a80f";
const SIG_ROT_NEWKEY: vector<u8> = x"8da26181473d4240cb3798d639c8101195e079dc51a07118e3ba86ff2987abaf8a0f0f3fe472004c2fc2ec957ebc1eaec76026d7335e8520d2d43a53bb4f4000";

// Same bindings under SUI_ORG_TREASURY_OUTFLOW_V1 with zero caps, SK1: the
// rotated-out shards cannot even trigger the stop switch.
const SIG_ROT_OLDKEY_OUTFLOW: vector<u8> = x"a5fc415323b4e8902cc6dd750c3ca9fd546222bab59e8eacb9b6bc1e9e283b1673508c620ed55ef01cdbeecbaf9556df004b820fa0889afba9a1952c0c269108";

// === Tests ===

#[test]
fun member_creates_shared_wrapper_with_discoverable_vault_and_sealed_cap() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| {
        assert_custody(f);
        assert_balance(f, 100);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::ENotMember, location = agent_vault::organization_treasury)]
fun outsider_cannot_create_treasury() {
    let f = start_treasury(RELAYER);
    f.end();
}

#[test, expected_failure(abort_code = treasury::ENotMember, location = agent_vault::organization_treasury)]
fun zero_weight_roster_entry_cannot_create_treasury() {
    let f = start_treasury(ZERO_WEIGHT);
    f.end();
}

#[test]
fun another_positive_weight_member_can_create_treasury() {
    let mut f = start_treasury(BOB);
    f.next_tx!(BOB, |f| assert_custody(f));
    f.end();
}

#[test]
fun third_party_executes_approved_stored_recipient_and_conserves_sui() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| {
        execute(f);
        assert_executed_event(f, 30, RECIPIENT);
    });
    f.next_tx!(RELAYER, |f| {
        assert_state(f, 2, 3, 0);
        assert_balance(f, 70);
        assert!(ts::ids_for_address<Coin<SUI>>(RELAYER).is_empty());
        assert!(ts::ids_for_address<Coin<SUI>>(ALICE).is_empty());
    });
    f.end();
}

#[test]
fun entire_balance_can_exit_using_same_organization_approval() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| {
        create_transfer(f.treasury_id, f.org_id, 100, BOB, f);
    });
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| {
        execute(f);
        assert_executed_event(f, 100, BOB);
    });
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 0);
    });
    f.end();
}

#[test]
fun separate_treasuries_share_governance_but_keep_distinct_funding_bindings() {
    let mut f = start_treasury(ALICE);
    let first_treasury = f.treasury_id;
    let first_vault = f.vault_id;
    f.next_tx!(BOB, |f| create_treasury(f.org_id, f));
    assert!(f.treasury_id != first_treasury && f.vault_id != first_vault);
    f.next_tx!(ALICE, |f| {
        deposit(f, 80);
        create_transfer(f.treasury_id, f.org_id, 30, RECIPIENT, f);
    });
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 50);
        let first = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, first_vault);
        assert!(vault::vault_balance(&first) == 100);
        ts::return_shared(first);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongOrganization, location = agent_vault::organization_treasury)]
fun foreign_organization_precedes_vault_binding_and_threshold_checks() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(RELAYER, |f| {
        execute_using(f.treasury_id, f.binding_id, f.other_org, f.proposal_id, f.vault_id, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongVault, location = agent_vault::organization_treasury)]
fun foreign_vault_precedes_unapproved_proposal() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| {
        execute_using(bound_treasury, f.binding_id, f.org_id, f.proposal_id, f.vault_id, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongOrganization, location = agent_vault::organization_treasury)]
fun transfer_creation_rejects_foreign_organization_before_membership() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(RELAYER, |f| create_transfer(f.treasury_id, f.other_org, 30, RECIPIENT, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::ENotMember, location = agent_vault::organization_treasury)]
fun outsider_cannot_create_a_bound_transfer() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| create_transfer(f.treasury_id, f.org_id, 30, RECIPIENT, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongTreasuryBinding, location = agent_vault::organization_treasury)]
fun same_org_approved_transfer_cannot_spend_another_treasury() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongProposalBinding, location = agent_vault::organization_treasury)]
fun approved_foreign_org_proposal_cannot_replace_the_bound_proposal() {
    let mut f = start_treasury(ALICE);
    let own_org = f.org_id;
    let own_binding = f.binding_id;
    let own_treasury = f.treasury_id;
    let own_vault = f.vault_id;
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(ALICE, |f| create_treasury(f.other_org, f));
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.other_org, 30, RECIPIENT, f));
    f.org_id = f.other_org;
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| {
        execute_using(own_treasury, own_binding, own_org, f.proposal_id, own_vault, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongProposalBinding, location = agent_vault::organization_treasury)]
fun binding_cannot_authorize_a_different_same_org_proposal() {
    let mut f = start_treasury(ALICE);
    let original_binding = f.binding_id;
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.org_id, 31, RECIPIENT, f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.binding_id = original_binding;
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = 4004, location = agent_vault::asynchronous_proposal)]
fun creator_cannot_execute_without_threshold_approval() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(ALICE, |f| execute(f));
    f.end();
}

#[test]
fun execution_one_millisecond_before_deadline_succeeds() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.clock.set_for_testing(99);
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| assert_balance(f, 70));
    f.end();
}

#[test]
fun execution_at_inclusive_deadline_succeeds() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.clock.set_for_testing(100);
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| assert_balance(f, 70));
    f.end();
}

#[test, expected_failure(abort_code = 4001, location = agent_vault::asynchronous_proposal)]
fun first_millisecond_after_deadline_precedes_threshold_check() {
    let mut f = start_treasury(ALICE);
    f.clock.set_for_testing(101);
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = 4011, location = agent_vault::asynchronous_proposal)]
fun authenticated_epoch_advance_invalidates_previously_approved_transfer() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(ALICE, |f| advance_epoch(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test]
fun new_epoch_proposal_restores_governed_exit_after_rotation() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| advance_epoch(f));
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.org_id, 100, RECIPIENT, f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 0);
    });
    f.end();
}

#[test, expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
fun rejected_transfer_cannot_execute_even_before_deadline() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| reject(f));
    f.next_tx!(BOB, |f| reject(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
fun executed_transfer_cannot_replay_even_after_deadline() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.clock.set_for_testing(101);
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = 2004, location = agent_vault::vault)]
fun approved_transfer_cannot_exceed_canonical_vault_balance() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.org_id, 101, RECIPIENT, f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::ENotMember, location = agent_vault::organization_treasury)]
fun zero_weight_member_cannot_create_bound_transfer() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ZERO_WEIGHT, |f| create_transfer(f.treasury_id, f.org_id, 30, RECIPIENT, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidRecipient, location = agent_vault::organization_treasury)]
fun zero_recipient_precedes_zero_amount_and_empty_title() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"", @0x0, 0, 0, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EZeroAmount, location = agent_vault::organization_treasury)]
fun zero_amount_precedes_empty_title_and_invalid_deadline() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"", RECIPIENT, 0, 0, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidTitle, location = agent_vault::organization_treasury)]
fun empty_title_precedes_invalid_deadline() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"", RECIPIENT, 1, 0, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidTitle, location = agent_vault::organization_treasury)]
fun first_title_byte_over_bound_is_rejected() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, vector::tabulate!(257, |_| 1u8), RECIPIENT, 1, 100, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidDeadline, location = agent_vault::organization_treasury)]
fun creation_at_deadline_is_rejected_without_unsigned_underflow() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"a", RECIPIENT, 1, 0, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidDeadline, location = agent_vault::organization_treasury)]
fun creation_after_deadline_is_rejected_without_unsigned_underflow() {
    let mut f = start_treasury(ALICE);
    f.clock.set_for_testing(101);
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.org_id, 1, RECIPIENT, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidDeadline, location = agent_vault::organization_treasury)]
fun first_millisecond_over_maximum_duration_is_rejected() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"a", RECIPIENT, 1, 31_536_000_001, f));
    f.end();
}

#[test]
fun minimum_amount_and_maximum_title_and_duration_are_supported() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, vector::tabulate!(256, |_| 1u8), RECIPIENT, 1, 31_536_000_000, f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 99);
    });
    f.end();
}

// === Threshold-Gated Agent Delegation (I3) ===

#[test]
fun threshold_delegation_issues_operator_and_sets_policy() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate(f);
        assert_delegation_event(f, f.treasury_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1);
    });
    f.next_tx!(RELAYER, |f| {
        assert_vault_state(f, f.vault_id, 100, DELEGATED_OUTFLOW, DELEGATED_BUDGET);
        assert_nonce(f, f.org_id, 1);
        assert!(ts::ids_for_address<OperatorCap>(OPERATOR).length() == 1);
        assert!(ts::ids_for_address<OperatorCap>(ALICE).is_empty());
        assert!(ts::ids_for_address<OperatorCap>(BOB).is_empty());
        assert!(ts::ids_for_address<OperatorCap>(RELAYER).is_empty());
        assert!(ts::ids_for_address<MasterCap>(OPERATOR).is_empty());
        assert!(!ts::has_most_recent_shared<MasterCap>());
    });
    f.end();
}

#[test]
fun repeated_delegation_keeps_earlier_operators_live() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR2, 800, 400, 2, SIG_DELEGATE_N2_OTHER_OPERATOR, f);
        assert_delegation_event(f, f.treasury_id, f.vault_id, OPERATOR2, 800, 400, 2);
    });
    f.next_tx!(RELAYER, |f| {
        assert_vault_state(f, f.vault_id, 100, 800, 400);
        assert_nonce(f, f.org_id, 2);
        assert!(ts::ids_for_address<OperatorCap>(OPERATOR).length() == 1);
        assert!(ts::ids_for_address<OperatorCap>(OPERATOR2).length() == 1);
    });
    spawn_card(OPERATOR, AGENT, 400, &mut f);
    f.end();
}

#[test]
fun outflow_update_sets_caps_and_emits_bound_event() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        set_outflow(f, 50, 20, 1, SIG_OUTFLOW_SET_N1);
        assert_outflow_event(f.treasury_id, f.vault_id, 50, 20, 1);
    });
    f.next_tx!(RELAYER, |f| {
        assert_vault_state(f, f.vault_id, 100, 50, 20);
        assert_nonce(f, f.org_id, 1);
        assert!(ts::ids_for_address<OperatorCap>(OPERATOR).is_empty());
    });
    f.end();
}

/// Stop switch: delegate, issue a card, spend once, then stop. The stop zeroes
/// the caps, raises the vault version, empties the agent registry, and leaves
/// the outflow already spent on the epoch ledger.
#[test]
fun stop_switch_retires_cards_and_raises_the_vault_version() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    agent_spend(10, &mut f);
    collect_payout(&mut f);
    f.next_tx!(RELAYER, |f| {
        set_outflow(f, 0, 0, 2, SIG_OUTFLOW_STOP_N2);
        assert_outflow_event(f.treasury_id, f.vault_id, 0, 0, 2);
        // vault::AgentCapsRevokedEvent = vault_id ‖ new_version, emitted in
        // this stop transaction.
        let events = event::events_by_type<vault::AgentCapsRevokedEvent>();
        assert!(events.length() == 1);
        let mut fields = sui::bcs::new(sui::bcs::to_bytes(&events[0]));
        assert!(object::id_from_address(fields.peel_address()) == f.vault_id);
        assert!(fields.peel_u64() == 2);
        assert!(fields.into_remainder_bytes().is_empty());
    });
    f.next_tx!(RELAYER, |f| {
        let vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        assert!(vault::vault_balance(&vault) == 90);
        assert!(vault::max_epoch_outflow(&vault) == 0);
        assert!(vault::max_agent_budget(&vault) == 0);
        assert!(vault::vault_version(&vault) == 2);
        assert!(vault::agent_count(&vault) == 0);
        assert!(vault::epoch_outflow(&vault) == 10);
        ts::return_shared(vault);
        assert_nonce(f, f.org_id, 2);
    });
    f.end();
}

#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun stopped_agent_card_cannot_spend() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    f.next_tx!(RELAYER, |f| set_outflow(f, 0, 0, 2, SIG_OUTFLOW_STOP_N2));
    agent_spend(10, &mut f);
    f.end();
}

#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun stopped_operator_card_cannot_issue_cards() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 0, 0, 2, SIG_OUTFLOW_STOP_N2));
    spawn_card(OPERATOR, AGENT, 20, &mut f);
    f.end();
}

/// Raising the caps is not a revocation, but a stop was: cards issued before
/// the stop stay invalid under the raised caps.
#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun raising_caps_after_a_stop_does_not_revive_old_agent_cards() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    f.next_tx!(RELAYER, |f| set_outflow(f, 0, 0, 2, SIG_OUTFLOW_STOP_N2));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 3, SIG_OUTFLOW_REARM_N3));
    agent_spend(10, &mut f);
    f.end();
}

#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun raising_caps_after_a_stop_does_not_revive_old_operator_cards() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 0, 0, 2, SIG_OUTFLOW_STOP_N2));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 3, SIG_OUTFLOW_REARM_N3));
    spawn_card(OPERATOR, AGENT, 20, &mut f);
    f.end();
}

/// After a stop only a new delegation restores agent spending: it issues a
/// card at the new vault version, and the retired agent address can be spawned
/// again because the stop emptied the registry.
#[test]
fun fresh_delegation_after_a_stop_issues_working_cards() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    agent_spend(10, &mut f);
    collect_payout(&mut f);
    f.next_tx!(RELAYER, |f| set_outflow(f, 0, 0, 2, SIG_OUTFLOW_STOP_N2));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 3, SIG_OUTFLOW_REARM_N3));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 4, SIG_DELEGATE_N4, f);
        assert_delegation_event(f, f.treasury_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 4);
    });
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    agent_spend(10, &mut f);
    collect_payout(&mut f);
    f.next_tx!(RELAYER, |f| {
        assert_vault_state(f, f.vault_id, 80, DELEGATED_OUTFLOW, DELEGATED_BUDGET);
        assert_nonce(f, f.org_id, 4);
    });
    f.end();
}

/// A zero epoch cap is a stop whatever the agent budget says: nothing can spend
/// under it, so the cards are retired instead of left dormant.
#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun zero_epoch_cap_retires_cards_even_with_a_positive_agent_budget() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    f.next_tx!(RELAYER, |f| set_outflow(f, 0, 20, 2, SIG_OUTFLOW_ZERO_EPOCH_N2));
    agent_spend(10, &mut f);
    f.end();
}

/// A zero agent budget is a stop as well. Nothing can spend under it, so the
/// cards are retired rather than left dormant; the positive epoch cap stays on
/// the books, which is what keeps bounding governance transfers.
#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun zero_agent_budget_retires_cards_even_with_a_positive_epoch_cap() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    f.next_tx!(RELAYER, |f| set_outflow(f, 40, 0, 2, SIG_OUTFLOW_ZERO_BUDGET_N2));
    f.next_tx!(RELAYER, |f| {
        let vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        assert!(vault::max_epoch_outflow(&vault) == 40);
        assert!(vault::max_agent_budget(&vault) == 0);
        assert!(vault::vault_version(&vault) == 2);
        assert!(vault::agent_count(&vault) == 0);
        ts::return_shared(vault);
    });
    agent_spend(10, &mut f);
    f.end();
}

#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun zero_agent_budget_retires_operator_cards_too() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 40, 0, 2, SIG_OUTFLOW_ZERO_BUDGET_N2));
    spawn_card(OPERATOR, AGENT, 1, &mut f);
    f.end();
}

/// The cards retired by a zero agent budget stay retired when the caps come
/// back: only a new delegation issues working cards again.
#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun raising_the_agent_budget_back_does_not_revive_retired_cards() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    f.next_tx!(RELAYER, |f| set_outflow(f, 40, 0, 2, SIG_OUTFLOW_ZERO_BUDGET_N2));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 3, SIG_OUTFLOW_REARM_N3));
    agent_spend(10, &mut f);
    f.end();
}

/// Lowering the per-agent cap binds cards already issued. The card keeps its
/// stored limit of 500 and the epoch cap would still allow it, but from the
/// lowered policy on it spends at most 50 per epoch.
#[test, expected_failure(abort_code = vault::E_EXCEEDED_DAILY_QUOTA, location = agent_vault::vault)]
fun lowering_the_agent_budget_binds_cards_already_issued() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 500, &mut f);
    f.next_tx!(RELAYER, |f| set_outflow(f, DELEGATED_OUTFLOW, 50, 2, SIG_OUTFLOW_LOWER_BUDGET_N2));
    f.next_tx!(RELAYER, |f| {
        // The card is neither revoked nor rewritten.
        let vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        assert!(vault::vault_version(&vault) == 1);
        assert!(vault::agent_count(&vault) == 1);
        assert!(vault::agent_daily_limit(&vault, AGENT) == 500);
        assert!(vault::max_agent_budget(&vault) == 50);
        ts::return_shared(vault);
    });
    // The new cap is spendable in full...
    agent_spend(50, &mut f);
    collect_payout(&mut f);
    // ...and one MIST past it is not.
    agent_spend(1, &mut f);
    f.end();
}

/// A later delegation moves the same ceilings: a card issued under the first
/// delegation is bound by the lower per-agent cap of the second.
#[test, expected_failure(abort_code = vault::E_EXCEEDED_DAILY_QUOTA, location = agent_vault::vault)]
fun a_later_delegation_with_lower_caps_binds_earlier_cards() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 500, &mut f);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR2, 800, 400, 2, SIG_DELEGATE_N2_OTHER_OPERATOR, f);
    });
    agent_spend(500, &mut f);
    f.end();
}

/// An operator can fill the agent registry with junk cards. The stop clears
/// the table, so an operator delegated afterwards can issue cards again;
/// without the clear a full registry blocked every future operator for good.
#[test]
fun a_stop_clears_a_registry_an_operator_has_filled() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(OPERATOR, |f| fill_registry(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 0, 0, 2, SIG_OUTFLOW_STOP_N2));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR2, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 3, SIG_DELEGATE_OPERATOR2_N3, f);
    });
    // One of the junk addresses can be spawned again, and the new card spends.
    let last = JUNK_AGENTS[99];
    spawn_card(OPERATOR2, last, 100, &mut f);
    let last = JUNK_AGENTS[99];
    agent_spend_as(last, 10, &mut f);
    collect_payout(&mut f);
    f.next_tx!(RELAYER, |f| assert_vault_state(f, f.vault_id, 90, DELEGATED_OUTFLOW, DELEGATED_BUDGET));
    f.end();
}

/// A full registry constrains card issuance only. An approved governance
/// transfer still executes under it.
#[test]
fun governance_transfers_ignore_a_full_registry() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(ALICE, |f| deposit(f, 5000));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(OPERATOR, |f| fill_registry(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| assert_balance(f, 5070));
    f.end();
}

/// The nonce counter is shared by every threshold action. Once a relayed outflow
/// update has consumed nonce 3, a transfer signed at nonce 3 no longer executes:
/// it stays pending and has to be signed again at a fresh nonce.
#[test, expected_failure(abort_code = proposal::E_INVALID_NONCE, location = agent_vault::asynchronous_proposal)]
fun a_relayed_outflow_update_stales_a_transfer_signed_at_the_same_nonce() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 3, SIG_OUTFLOW_REARM_N3));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

/// The organization, treasury, and vault are objects: no key signs for them, so
/// an OperatorCap issued to one would be dead on arrival with the authorization
/// nonce burned. All three signatures here are valid.
#[test, expected_failure(abort_code = treasury::EInvalidOperator, location = agent_vault::organization_treasury)]
fun delegation_rejects_the_treasury_address_as_operator() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        let operator = sui::object::id_to_address(&f.treasury_id);
        delegate_using(f.treasury_id, f.org_id, f.vault_id, operator, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_TO_TREASURY_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidOperator, location = agent_vault::organization_treasury)]
fun delegation_rejects_the_vault_address_as_operator() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        let operator = sui::object::id_to_address(&f.vault_id);
        delegate_using(f.treasury_id, f.org_id, f.vault_id, operator, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_TO_VAULT_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidOperator, location = agent_vault::organization_treasury)]
fun delegation_rejects_the_organization_address_as_operator() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        let operator = sui::object::id_to_address(&f.org_id);
        delegate_using(f.treasury_id, f.org_id, f.vault_id, operator, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_TO_ORG_N1, f);
    });
    f.end();
}

// --- Vault invariants the delegation relies on (red-team probes, kept) ---
//
// The treasury only borrows vault's MasterCap, so the guarantees below are
// vault's own. They were unpinned before the delegation made them reachable
// from a governed path.

/// A MasterCap minted anywhere else is not the sealed one: none of the six
/// master operations accepts it against the treasury's vault.
#[test, expected_failure(abort_code = vault::E_UNAUTHORIZED_OPERATOR, location = agent_vault::vault)]
fun foreign_master_cap_cannot_revoke_cards_on_treasury_vault() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ATTACKER, |f| {
        let attacker_cap = vault::initialize_vault<SUI>(f.ctx!());
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::revoke_agent_caps(&attacker_cap, &mut vault);
        vault::destroy_master_cap_for_testing(attacker_cap);
        ts::return_shared(vault);
    });
    f.end();
}

#[test, expected_failure(abort_code = vault::E_UNAUTHORIZED_OPERATOR, location = agent_vault::vault)]
fun foreign_master_cap_cannot_set_policy_on_treasury_vault() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ATTACKER, |f| {
        let attacker_cap = vault::initialize_vault<SUI>(f.ctx!());
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::set_outflow_policy(&attacker_cap, &mut vault, U64_MAX, U64_MAX);
        vault::destroy_master_cap_for_testing(attacker_cap);
        ts::return_shared(vault);
    });
    f.end();
}

#[test, expected_failure(abort_code = vault::E_UNAUTHORIZED_OPERATOR, location = agent_vault::vault)]
fun foreign_master_cap_cannot_issue_an_operator_for_treasury_vault() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ATTACKER, |f| {
        let attacker_cap = vault::initialize_vault<SUI>(f.ctx!());
        let vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::issue_operator_cap(&attacker_cap, &vault, ATTACKER, f.ctx!());
        vault::destroy_master_cap_for_testing(attacker_cap);
        ts::return_shared(vault);
    });
    f.end();
}

#[test, expected_failure(abort_code = vault::E_UNAUTHORIZED_OPERATOR, location = agent_vault::vault)]
fun foreign_master_cap_cannot_withdraw_from_treasury_vault() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ATTACKER, |f| {
        let attacker_cap = vault::initialize_vault<SUI>(f.ctx!());
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::withdraw(&attacker_cap, &mut vault, 100, ATTACKER, f.ctx!());
        vault::destroy_master_cap_for_testing(attacker_cap);
        ts::return_shared(vault);
    });
    f.end();
}

#[test, expected_failure(abort_code = vault::E_UNAUTHORIZED_OPERATOR, location = agent_vault::vault)]
fun foreign_master_cap_cannot_purge_treasury_vault() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ATTACKER, |f| {
        let attacker_cap = vault::initialize_vault<SUI>(f.ctx!());
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::emergency_unilateral_purge(&attacker_cap, &mut vault, ATTACKER, f.ctx!());
        vault::destroy_master_cap_for_testing(attacker_cap);
        ts::return_shared(vault);
    });
    f.end();
}

#[test, expected_failure(abort_code = vault::E_UNAUTHORIZED_OPERATOR, location = agent_vault::vault)]
fun foreign_master_cap_cannot_unpause_treasury_vault() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ATTACKER, |f| {
        let attacker_cap = vault::initialize_vault<SUI>(f.ctx!());
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::unpause_vault(&attacker_cap, &mut vault);
        vault::destroy_master_cap_for_testing(attacker_cap);
        ts::return_shared(vault);
    });
    f.end();
}

/// Cards are bound to one vault: neither an OperatorCap nor an AgentCap issued
/// for the first treasury's vault works against a second treasury's vault, even
/// inside the same organization.
#[test, expected_failure(abort_code = vault::E_UNAUTHORIZED_OPERATOR, location = agent_vault::vault)]
fun operator_card_of_one_treasury_cannot_spawn_on_another() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(OPERATOR, |f| {
        let op_cap = ts::take_from_sender<OperatorCap>(&f.scenario);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::spawn_agent_card(&op_cap, &mut vault, AGENT, 100, b"cross-vault", f.ctx!());
        ts::return_to_sender(&f.scenario, op_cap);
        ts::return_shared(vault);
    });
    f.end();
}

#[test, expected_failure(abort_code = vault::E_UNAUTHORIZED_OPERATOR, location = agent_vault::vault)]
fun agent_card_of_one_treasury_cannot_spend_from_another() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(AGENT, |f| {
        let agent_cap = ts::take_from_sender<AgentCap>(&f.scenario);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::spend_x402_budget(&agent_cap, &mut vault, 1, RECIPIENT, f.ctx!());
        ts::return_to_sender(&f.scenario, agent_cap);
        ts::return_shared(vault);
    });
    f.end();
}

/// Pausing a card stops its spending: the registry flag is read at spend time.
#[test, expected_failure(abort_code = vault::E_AGENT_PAUSED, location = agent_vault::vault)]
fun paused_card_cannot_spend() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    f.next_tx!(OPERATOR, |f| {
        let op_cap = ts::take_from_sender<OperatorCap>(&f.scenario);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::pause_agent(&op_cap, &mut vault, AGENT);
        ts::return_to_sender(&f.scenario, op_cap);
        ts::return_shared(vault);
    });
    agent_spend(1, &mut f);
    f.end();
}

/// A card's budget cannot be set to zero: the operator pauses the card instead
/// of turning it into a silent no-op.
#[test, expected_failure(abort_code = vault::E_ZERO_AMOUNT, location = agent_vault::vault)]
fun zero_card_budget_is_rejected() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    spawn_card(OPERATOR, AGENT, 300, &mut f);
    f.next_tx!(OPERATOR, |f| {
        let op_cap = ts::take_from_sender<OperatorCap>(&f.scenario);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::set_agent_budget(&op_cap, &mut vault, AGENT, 0);
        ts::return_to_sender(&f.scenario, op_cap);
        ts::return_shared(vault);
    });
    f.end();
}

/// Purge is what the governance stop is modelled on: it raises the vault
/// version, so every issued card dies at its next use, even once the vault has
/// been unpaused. A standalone vault is used because the treasury never purges.
#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun purged_agent_card_cannot_spend_after_unpause() {
    let mut s = ts::begin(ATTACKER);
    let vault_id = purged_vault_with_card(&mut s);
    s.next_tx(ATTACKER);
    {
        let mut agent_cap = ts::take_from_sender<AgentCap>(&s);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&s, vault_id);
        vault::spend_x402_budget(&mut agent_cap, &mut vault, 1, RECIPIENT, s.ctx());
        ts::return_to_sender(&s, agent_cap);
        ts::return_shared(vault);
    };
    ts::end(s);
}

#[test, expected_failure(abort_code = vault::E_CAP_VERSION_MISMATCH, location = agent_vault::vault)]
fun purged_operator_card_cannot_spawn_after_unpause() {
    let mut s = ts::begin(ATTACKER);
    let vault_id = purged_vault_with_card(&mut s);
    s.next_tx(ATTACKER);
    {
        let op_cap = ts::take_from_sender<OperatorCap>(&s);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&s, vault_id);
        vault::spawn_agent_card(&op_cap, &mut vault, AGENT, 100, b"purge probe", s.ctx());
        ts::return_to_sender(&s, op_cap);
        ts::return_shared(vault);
    };
    ts::end(s);
}

/// Standalone vault with one operator and one agent card, then purged and
/// unpaused. The master cap stays with ATTACKER; both cards stay with it too.
fun purged_vault_with_card(s: &mut Scenario): ID {
    s.next_tx(ATTACKER);
    let master = vault::initialize_vault<SUI>(s.ctx());
    let vault_id = vault::master_vault_id(&master);
    sui::transfer::public_transfer(master, ATTACKER);
    s.next_tx(ATTACKER);
    {
        let master = ts::take_from_sender<MasterCap>(s);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(s, vault_id);
        let funds = coin::mint_for_testing<SUI>(100, s.ctx());
        vault::deposit(&mut vault, funds);
        vault::set_outflow_policy(&master, &mut vault, 1000, 500);
        vault::issue_operator_cap(&master, &vault, ATTACKER, s.ctx());
        ts::return_to_sender(s, master);
        ts::return_shared(vault);
    };
    s.next_tx(ATTACKER);
    {
        let op_cap = ts::take_from_sender<OperatorCap>(s);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(s, vault_id);
        vault::spawn_agent_card(&op_cap, &mut vault, ATTACKER, 100, b"purge probe", s.ctx());
        ts::return_to_sender(s, op_cap);
        ts::return_shared(vault);
    };
    s.next_tx(ATTACKER);
    {
        let master = ts::take_from_sender<MasterCap>(s);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(s, vault_id);
        vault::emergency_unilateral_purge(&master, &mut vault, ATTACKER, s.ctx());
        ts::return_to_sender(s, master);
        ts::return_shared(vault);
    };
    s.next_tx(ATTACKER);
    {
        let master = ts::take_from_sender<MasterCap>(s);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(s, vault_id);
        vault::unpause_vault(&master, &mut vault);
        ts::return_to_sender(s, master);
        ts::return_shared(vault);
    };
    vault_id
}

/// The epoch cap is a ceiling on every outflow, governance transfers included.
/// With 10 of a 30 cap spent by an agent, the approved 30 transfer aborts in
/// vault::withdraw; the whole transaction rolls back, so the nonce is not
/// consumed and the proposal stays pending.
#[test, expected_failure(abort_code = vault::E_EXCEEDS_EPOCH_OUTFLOW, location = agent_vault::vault)]
fun agent_spend_inside_the_epoch_cap_can_block_an_approved_governance_transfer() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 30, 20, 2, SIG_OUTFLOW_TIGHT_N2));
    spawn_card(OPERATOR, AGENT, 20, &mut f);
    agent_spend(10, &mut f);
    collect_payout(&mut f);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test]
fun governance_transfer_within_the_delegated_epoch_cap_still_executes() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| {
        execute(f);
        assert_executed_event(f, 30, RECIPIENT);
    });
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 70);
        assert_nonce(f, f.org_id, 3);
    });
    f.end();
}

/// A delegation whose epoch cap is below the transfer amount blocks that
/// approved transfer even with no agent activity at all.
#[test, expected_failure(abort_code = vault::E_EXCEEDS_EPOCH_OUTFLOW, location = agent_vault::vault)]
fun delegated_epoch_cap_below_the_amount_blocks_governance_transfers() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, 20, 10, 1, SIG_DELEGATE_SMALL_N1, f);
    });
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

/// A stop returns the vault to its pre-delegation rule: with a zero epoch cap
/// the same transfer executes.
#[test]
fun stop_switch_lifts_the_epoch_cap_off_governance_transfers() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, 20, 10, 1, SIG_DELEGATE_SMALL_N1, f);
    });
    f.next_tx!(RELAYER, |f| set_outflow(f, 0, 0, 2, SIG_OUTFLOW_STOP_N2));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| {
        execute(f);
        assert_executed_event(f, 30, RECIPIENT);
    });
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 70);
        assert_state(f, 2, 3, 0);
        assert_nonce(f, f.org_id, 3);
    });
    f.end();
}

/// The operator card grants card management only. vault::withdraw requires
/// &MasterCap, which stays sealed inside the treasury: no address owns one,
/// and the pending governance proposal is untouched by the delegation.
#[test]
fun operator_cap_cannot_reach_the_sealed_master_authority() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| {
        assert!(ts::ids_for_address<OperatorCap>(OPERATOR).length() == 1);
        assert!(ts::ids_for_address<MasterCap>(OPERATOR).is_empty());
        assert!(ts::ids_for_address<MasterCap>(ALICE).is_empty());
        assert!(ts::ids_for_address<MasterCap>(BOB).is_empty());
        assert!(ts::ids_for_address<MasterCap>(RELAYER).is_empty());
        assert!(ts::ids_for_address<MasterCap>(AGENT).is_empty());
        assert!(!ts::has_most_recent_shared<MasterCap>());
        assert_custody(f);
        assert_state(f, 1, 0, 0);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun delegation_rejects_signature_from_a_foreign_key() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_WRONG_KEY, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun delegation_rejects_signature_bound_to_another_organization() {
    let mut f = start_treasury(ALICE);
    // The second treasury replaces the fixture's ids; the signature is bound to
    // the first one, so that is what it has to be submitted with.
    let bound_treasury = f.treasury_id;
    let bound_vault = f.vault_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(bound_treasury, f.org_id, bound_vault, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_FOREIGN_ORG, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun delegation_rejects_signature_bound_to_another_vault() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    let bound_vault = f.vault_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(bound_treasury, f.org_id, bound_vault, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_FOREIGN_VAULT, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun delegation_rejects_signature_bound_to_another_treasury() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    let bound_vault = f.vault_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(bound_treasury, f.org_id, bound_vault, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_FOREIGN_TREASURY, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun delegation_rejects_signature_with_tampered_operator() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR2, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun delegation_rejects_signature_with_tampered_caps() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, 501, 1, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_signature_from_a_foreign_key() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 1, SIG_OUTFLOW_WRONG_KEY));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_signature_bound_to_another_organization() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    let bound_vault = f.vault_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(RELAYER, |f| set_outflow_using(bound_treasury, f.org_id, bound_vault, 50, 20, 1, SIG_OUTFLOW_FOREIGN_ORG, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_signature_bound_to_another_vault() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    let bound_vault = f.vault_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| {
        set_outflow_using(bound_treasury, f.org_id, bound_vault, 50, 20, 1, SIG_OUTFLOW_FOREIGN_VAULT, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_signature_bound_to_another_treasury() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    let bound_vault = f.vault_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| {
        set_outflow_using(bound_treasury, f.org_id, bound_vault, 50, 20, 1, SIG_OUTFLOW_FOREIGN_TREASURY, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_signature_with_tampered_caps() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| set_outflow(f, 51, 20, 1, SIG_OUTFLOW_SET_N1));
    f.end();
}

// === Digest layout, pinned across implementations ===
//
// Every input below has its own value. Dropping, swapping or reordering any
// field of the digest, here or in the SDK, breaks the equality, whether or not
// the signatures above were fitted to the new layout. That is what the
// signature tests cannot show on their own: a layout change plus refitted
// signatures passes all of them.

#[test]
fun agent_digest_equals_the_sdk_golden_vector() {
    let chain = b"sui-testnet:";
    let org_id = sui::object::id_from_address(@0x1111111111111111111111111111111111111111111111111111111111111111);
    let treasury_id = sui::object::id_from_address(@0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee);
    let vault_id = sui::object::id_from_address(@0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
    let operator = @0x9999999999999999999999999999999999999999999999999999999999999999;
    assert!(
        treasury::compute_agent_delegation_digest(
            &chain, &org_id, 2, 31, &treasury_id, &vault_id, &operator, 700, 80, 4,
        ) == SDK_GOLDEN_AGENT_DIGEST,
        1,
    );
}

#[test]
fun outflow_digest_equals_the_sdk_golden_vector() {
    let chain = b"sui-testnet:";
    let org_id = sui::object::id_from_address(@0x1111111111111111111111111111111111111111111111111111111111111111);
    let treasury_id = sui::object::id_from_address(@0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee);
    let vault_id = sui::object::id_from_address(@0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
    assert!(
        treasury::compute_outflow_policy_digest(
            &chain, &org_id, 2, 32, &treasury_id, &vault_id, 700, 80, 4,
        ) == SDK_GOLDEN_OUTFLOW_DIGEST,
        1,
    );
}

#[test]
fun agent_and_outflow_digests_differ_only_by_design() {
    // Same inputs, different domain: one signature cannot serve both actions.
    let chain = b"sui-testnet:";
    let org_id = sui::object::id_from_address(@0x1111111111111111111111111111111111111111111111111111111111111111);
    let treasury_id = sui::object::id_from_address(@0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee);
    let vault_id = sui::object::id_from_address(@0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
    let operator = @0x9999999999999999999999999999999999999999999999999999999999999999;
    let agent = treasury::compute_agent_delegation_digest(
        &chain, &org_id, 2, 31, &treasury_id, &vault_id, &operator, 700, 80, 4,
    );
    let outflow = treasury::compute_outflow_policy_digest(
        &chain, &org_id, 2, 31, &treasury_id, &vault_id, 700, 80, 4,
    );
    assert!(agent != outflow && agent.length() == 32 && outflow.length() == 32, 1);
}

// === Epoch binding ===
//
// An organization leaves epoch 1 in two ways that keep the group key:
// advance_organization_epoch and a roster update. A signature prepared before
// either one still verifies against its own digest. The epoch inside the
// digest is what makes it unusable afterwards.

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun epoch_advance_rejects_a_delegation_signed_for_the_old_epoch() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| advance_epoch(f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 3, SIG_DELEGATE_N3_EPOCH1, f);
    });
    f.end();
}

#[test]
fun epoch_advance_accepts_a_delegation_signed_for_the_new_epoch() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| advance_epoch(f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 3, SIG_DELEGATE_N3_EPOCH2, f);
    });
    f.next_tx!(RELAYER, |f| {
        assert_vault_state(f, f.vault_id, 100, DELEGATED_OUTFLOW, DELEGATED_BUDGET);
        assert_nonce(f, f.org_id, 3);
        assert!(ts::ids_for_address<OperatorCap>(OPERATOR).length() == 1);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun epoch_advance_rejects_an_outflow_update_signed_for_the_old_epoch() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| advance_epoch(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 3, SIG_OUTFLOW_REARM_N3));
    f.end();
}

#[test]
fun epoch_advance_accepts_an_outflow_update_signed_for_the_new_epoch() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| advance_epoch(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 3, SIG_OUTFLOW_N3_EPOCH2));
    f.next_tx!(RELAYER, |f| {
        assert_vault_state(f, f.vault_id, 100, 50, 20);
        assert_nonce(f, f.org_id, 3);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun roster_update_rejects_a_delegation_signed_for_the_old_epoch() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| update_roster(f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 3, SIG_DELEGATE_N3_EPOCH1, f);
    });
    f.end();
}

#[test]
fun roster_update_accepts_a_delegation_signed_for_the_new_epoch() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| update_roster(f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 3, SIG_DELEGATE_N3_EPOCH2, f);
    });
    f.next_tx!(RELAYER, |f| {
        assert_vault_state(f, f.vault_id, 100, DELEGATED_OUTFLOW, DELEGATED_BUDGET);
        assert_nonce(f, f.org_id, 3);
        assert!(ts::ids_for_address<OperatorCap>(OPERATOR).length() == 1);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidNonce, location = agent_vault::organization_treasury)]
fun delegation_rejects_nonce_at_or_below_last_nonce() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 0, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidNonce, location = agent_vault::organization_treasury)]
fun delegation_rejects_replay_at_the_consumed_nonce() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| delegate(f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun delegation_rejects_replayed_signature_at_a_fresh_nonce() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 2, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidNonce, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_stale_nonce() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| delegate(f));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 1, SIG_OUTFLOW_SET_N1));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_replayed_signature_at_a_fresh_nonce() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 1, SIG_OUTFLOW_SET_N1));
    f.next_tx!(RELAYER, |f| set_outflow(f, 50, 20, 2, SIG_OUTFLOW_SET_N1));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun delegation_signature_cannot_authorize_an_outflow_update() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| set_outflow(f, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_N1));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun outflow_signature_cannot_authorize_a_delegation() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, 50, 20, 1, SIG_OUTFLOW_SET_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidOperator, location = agent_vault::organization_treasury)]
fun zero_operator_precedes_zero_caps() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, @0x0, 0, 0, 1, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EZeroOutflowCap, location = agent_vault::organization_treasury)]
fun zero_outflow_cap_precedes_zero_agent_budget() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, 0, 0, 1, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EZeroAgentBudget, location = agent_vault::organization_treasury)]
fun zero_agent_budget_is_rejected() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, 0, 1, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongOrganization, location = agent_vault::organization_treasury)]
fun delegation_rejects_foreign_organization_first() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(f.treasury_id, f.other_org, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongVault, location = agent_vault::organization_treasury)]
fun delegation_rejects_foreign_vault_first() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| {
        delegate_using(bound_treasury, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongOrganization, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_foreign_organization() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(RELAYER, |f| {
        set_outflow_using(f.treasury_id, f.other_org, f.vault_id, 50, 20, 1, SIG_OUTFLOW_SET_N1, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongVault, location = agent_vault::organization_treasury)]
fun outflow_update_rejects_foreign_vault() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| {
        set_outflow_using(bound_treasury, f.org_id, f.vault_id, 50, 20, 1, SIG_OUTFLOW_SET_N1, f);
    });
    f.end();
}

// === I3 key-generation regressions (rt9 fixture keys and layout) ===

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun old_key_cannot_delegate_after_group_key_rotation() {
    let mut s = ts::begin(ALICE);
    let org_id = org::create_organization_for_testing(PK1, 2, 2, vector[ALICE, BOB], vector[1, 1], ts::ctx(&mut s));
    ts::next_tx(&mut s, ALICE);
    {
        let mut o = ts::take_shared_by_id<Organization>(&mut s, org_id);
        org::rotate_group_key_for_testing(&mut o, 1, PK2, vector[ALICE, BOB], 2, ts::ctx(&mut s));
        ts::return_shared(o);
    };
    ts::next_tx(&mut s, ALICE);
    let (treasury_id, vault_id) = {
        let o = ts::take_shared_by_id<Organization>(&mut s, org_id);
        let t = treasury::new(&o, ts::ctx(&mut s));
        let id = object::id(&t);
        let (_, v, _) = treasury::custody_ids(&t);
        treasury::share(t);
        ts::return_shared(o);
        (id, v)
    };
    ts::next_tx(&mut s, RELAYER);
    {
        let treas = ts::take_shared_by_id<OrganizationTreasury>(&mut s, treasury_id);
        let mut organization = ts::take_shared_by_id<Organization>(&mut s, org_id);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&mut s, vault_id);
        // Pre-rotate shards signed (epoch 2, nonce 2, kg 2); the live key is
        // PK2, so verification must fail and the delegation must abort.
        treasury::delegate_agent_authority(
            &treas, &mut organization, &mut vault, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 2, SIG_ROT_OLDKEY, ts::ctx(&mut s),
        );
        // Unreachable at runtime: the call above aborts before these returns.
        ts::return_shared(vault);
        ts::return_shared(organization);
        ts::return_shared(treas);
    };
    ts::end(s);
}

#[test]
fun new_key_delegates_after_group_key_rotation() {
    let mut s = ts::begin(ALICE);
    let org_id = org::create_organization_for_testing(PK1, 2, 2, vector[ALICE, BOB], vector[1, 1], ts::ctx(&mut s));
    ts::next_tx(&mut s, ALICE);
    {
        let mut o = ts::take_shared_by_id<Organization>(&mut s, org_id);
        org::rotate_group_key_for_testing(&mut o, 1, PK2, vector[ALICE, BOB], 2, ts::ctx(&mut s));
        ts::return_shared(o);
    };
    ts::next_tx(&mut s, ALICE);
    let (treasury_id, vault_id) = {
        let o = ts::take_shared_by_id<Organization>(&mut s, org_id);
        let t = treasury::new(&o, ts::ctx(&mut s));
        let id = object::id(&t);
        let (_, v, _) = treasury::custody_ids(&t);
        treasury::share(t);
        ts::return_shared(o);
        (id, v)
    };
    ts::next_tx(&mut s, RELAYER);
    {
        let treas = ts::take_shared_by_id<OrganizationTreasury>(&mut s, treasury_id);
        let mut organization = ts::take_shared_by_id<Organization>(&mut s, org_id);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&mut s, vault_id);
        treasury::delegate_agent_authority(
            &treas, &mut organization, &mut vault, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 2, SIG_ROT_NEWKEY, ts::ctx(&mut s),
        );
        ts::return_shared(vault);
        ts::return_shared(organization);
        ts::return_shared(treas);
    };
    ts::next_tx(&mut s, RELAYER);
    {
        let organization = ts::take_shared_by_id<Organization>(&mut s, org_id);
        let vault = ts::take_shared_by_id<AgentVault<SUI>>(&mut s, vault_id);
        assert!(org::last_nonce(&organization) == 2);
        assert!(vault::max_epoch_outflow(&vault) == DELEGATED_OUTFLOW);
        assert!(vault::max_agent_budget(&vault) == DELEGATED_BUDGET);
        assert!(ts::ids_for_address<OperatorCap>(OPERATOR).length() == 1);
        ts::return_shared(vault);
        ts::return_shared(organization);
    };
    ts::end(s);
}

#[test, expected_failure(abort_code = treasury::EInvalidSignature, location = agent_vault::organization_treasury)]
fun old_key_cannot_update_outflow_policy_after_rotation() {
    let mut s = ts::begin(ALICE);
    let org_id = org::create_organization_for_testing(PK1, 2, 2, vector[ALICE, BOB], vector[1, 1], ts::ctx(&mut s));
    ts::next_tx(&mut s, ALICE);
    {
        let mut o = ts::take_shared_by_id<Organization>(&mut s, org_id);
        org::rotate_group_key_for_testing(&mut o, 1, PK2, vector[ALICE, BOB], 2, ts::ctx(&mut s));
        ts::return_shared(o);
    };
    ts::next_tx(&mut s, ALICE);
    let (treasury_id, vault_id) = {
        let o = ts::take_shared_by_id<Organization>(&mut s, org_id);
        let t = treasury::new(&o, ts::ctx(&mut s));
        let id = object::id(&t);
        let (_, v, _) = treasury::custody_ids(&t);
        treasury::share(t);
        ts::return_shared(o);
        (id, v)
    };
    ts::next_tx(&mut s, RELAYER);
    {
        let treas = ts::take_shared_by_id<OrganizationTreasury>(&mut s, treasury_id);
        let mut organization = ts::take_shared_by_id<Organization>(&mut s, org_id);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&mut s, vault_id);
        treasury::set_agent_outflow_policy(&treas, &mut organization, &mut vault, 0, 0, 2, SIG_ROT_OLDKEY_OUTFLOW);
        // Unreachable at runtime: the call above aborts before these returns.
        ts::return_shared(vault);
        ts::return_shared(organization);
        ts::return_shared(treas);
    };
    ts::end(s);
}

// === Test-Only Types ===

public struct TreasuryFixture {
    scenario: Scenario,
    clock: Clock,
    org_id: ID,
    treasury_id: ID,
    vault_id: ID,
    proposal_id: ID,
    binding_id: ID,
    other_org: ID,
}

// === Test-Only Functions ===

fun start_treasury(creator: address): TreasuryFixture {
    let mut scenario = ts::begin(ALICE);
    let clock = clock::create_for_testing(scenario.ctx());
    let org_id = org::create_organization_for_testing(
        GROUP_PK, 2, 3, vector[ALICE, BOB, ZERO_WEIGHT], vector[2, 1, 0], scenario.ctx(),
    );
    scenario.next_tx(creator);
    let mut f = TreasuryFixture {
        scenario, clock, org_id,
        treasury_id: org_id, vault_id: org_id, proposal_id: org_id,
        binding_id: org_id, other_org: org_id,
    };
    create_treasury(org_id, &mut f);
    // The newly shared vault has no returned reference. Deposit uses the next
    // transaction's shared input; taking it earlier would misrepresent a PTB.
    f.scenario.next_tx(ALICE);
    deposit(&mut f, 100);
    create_transfer(f.treasury_id, org_id, 30, RECIPIENT, &mut f);
    f.scenario.next_tx(ALICE);
    f
}

macro fun fixture_next_tx($f: &mut TreasuryFixture, $sender: address, $action: |&mut TreasuryFixture|) {
    let f = $f;
    f.scenario.next_tx($sender);
    $action(f);
}

macro fun fixture_ctx($f: &mut TreasuryFixture): &mut TxContext {
    let f = $f;
    f.scenario.ctx()
}

fun create_organization(f: &mut TreasuryFixture): ID {
    org::create_organization_for_testing(GROUP_PK, 2, 3, vector[ALICE, BOB], vector[2, 1], f.ctx!())
}

fun create_treasury(org_id: ID, f: &mut TreasuryFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    let self = treasury::new(&organization, f.ctx!());
    let (stored_org, vault_id, cap_id) = treasury::custody_ids(&self);
    let id = object::id(&self);
    let events = event::events_by_type<TreasuryCreated>();
    let (event_id, event_org, event_vault) = treasury::treasury_created_fields(&events[events.length() - 1]);
    assert!(stored_org == org_id && event_id == id && event_org == org_id && event_vault == vault_id);
    assert!(cap_id != id && cap_id != vault_id);
    // 3 fixed-length IDs: no sender, asset selector, or arbitrary payload.
    assert!(sui::bcs::to_bytes(&events[events.length() - 1]).length() == 96);
    treasury::share(self);
    ts::return_shared(organization);
    f.treasury_id = id;
    f.vault_id = vault_id;
}

fun create_transfer(treasury_id: ID, org_id: ID, amount: u64, recipient: address, f: &mut TreasuryFixture) {
    create_transfer_with(treasury_id, org_id, b"Approved SUI payment", recipient, amount, 100, f);
}

fun create_transfer_with(
    treasury_id: ID, org_id: ID, title: vector<u8>, recipient: address, amount: u64, deadline: u64, f: &mut TreasuryFixture,
) {
    let self = ts::take_shared_by_id<OrganizationTreasury>(&f.scenario, treasury_id);
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    let proposal_id = treasury::create_transfer(&self, &organization, title, recipient, amount, deadline, &f.clock, f.ctx!());
    let events = event::events_by_type<TransferCreated>();
    let (binding_id, event_treasury, event_proposal) = treasury::transfer_created_fields(&events[events.length() - 1]);
    assert!(event_treasury == treasury_id && event_proposal == proposal_id);
    assert!(sui::bcs::to_bytes(&events[events.length() - 1]).length() == 96);
    f.proposal_id = proposal_id;
    f.binding_id = binding_id;
    ts::return_shared(organization);
    ts::return_shared(self);
}

fun deposit(f: &mut TreasuryFixture, amount: u64) {
    let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
    let funds = coin::mint_for_testing<SUI>(amount, f.ctx!());
    vault::deposit(&mut vault, funds);
    ts::return_shared(vault);
}

fun approve(f: &mut TreasuryFixture) {
    let mut p = ts::take_shared_by_id<Proposal>(&f.scenario, f.proposal_id);
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let weight = org::member_weight(&organization, f.scenario.sender());
    proposal::submit_async_vote(&mut p, &organization, &f.clock, weight, vector[], f.ctx!());
    ts::return_shared(organization);
    ts::return_shared(p);
}

fun reject(f: &mut TreasuryFixture) {
    let mut p = ts::take_shared_by_id<Proposal>(&f.scenario, f.proposal_id);
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    proposal::reject_async_vote(&mut p, &organization, &f.clock, f.ctx!());
    ts::return_shared(organization);
    ts::return_shared(p);
}

fun execute(f: &mut TreasuryFixture) {
    execute_using(f.treasury_id, f.binding_id, f.org_id, f.proposal_id, f.vault_id, f);
}

fun execute_using(treasury_id: ID, binding_id: ID, org_id: ID, proposal_id: ID, vault_id: ID, f: &mut TreasuryFixture) {
    let self = ts::take_shared_by_id<OrganizationTreasury>(&f.scenario, treasury_id);
    let binding = ts::take_shared_by_id<TransferBinding>(&f.scenario, binding_id);
    let mut organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    let mut p = ts::take_shared_by_id<Proposal>(&f.scenario, proposal_id);
    let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, vault_id);
    treasury::execute_for_testing(&self, &binding, &mut organization, &mut p, &mut vault, 3, &f.clock, f.ctx!());
    ts::return_shared(vault);
    ts::return_shared(p);
    ts::return_shared(organization);
    ts::return_shared(binding);
    ts::return_shared(self);
}

fun assert_custody(f: &TreasuryFixture) {
    let self = ts::take_shared_by_id<OrganizationTreasury>(&f.scenario, f.treasury_id);
    let (org_id, vault_id, _) = treasury::custody_ids(&self);
    assert!(org_id == f.org_id && vault_id == f.vault_id);
    let binding = ts::take_shared_by_id<TransferBinding>(&f.scenario, f.binding_id);
    let (binding_treasury, binding_proposal) = treasury::binding_ids(&binding);
    assert!(binding_treasury == f.treasury_id && binding_proposal == f.proposal_id);
    assert!(ts::ids_for_address<MasterCap>(ALICE).is_empty());
    assert!(ts::ids_for_address<MasterCap>(BOB).is_empty());
    assert!(ts::ids_for_address<MasterCap>(RELAYER).is_empty());
    assert!(!ts::has_most_recent_shared<MasterCap>());
    assert!(!ts::has_most_recent_shared<OperatorCap>());
    assert!(!ts::has_most_recent_shared<AgentCap>());
    assert!(ts::ids_for_address<OperatorCap>(ALICE).is_empty());
    assert!(ts::ids_for_address<AgentCap>(ALICE).is_empty());
    ts::return_shared(binding);
    ts::return_shared(self);
}

fun assert_balance(f: &TreasuryFixture, expected: u64) {
    let vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
    assert!(vault::vault_balance(&vault) == expected);
    ts::return_shared(vault);
}

fun assert_state(f: &TreasuryFixture, status: u8, approved: u64, rejected: u64) {
    let p = ts::take_shared_by_id<Proposal>(&f.scenario, f.proposal_id);
    assert!(proposal::status(&p) == status);
    assert!(proposal::accumulated_weight(&p) == approved);
    assert!(proposal::rejected_weight(&p) == rejected);
    ts::return_shared(p);
}

fun assert_executed_event(f: &TreasuryFixture, amount: u64, recipient: address) {
    // Existing event has { proposal_id: ID, amount: u64, recipient: address }.
    // Decode in tests only; no production getter is added for event inspection.
    let events = event::events_by_type<ProposalExecutedEvent>();
    let mut fields = sui::bcs::new(sui::bcs::to_bytes(&events[events.length() - 1]));
    assert!(object::id_from_address(fields.peel_address()) == f.proposal_id);
    assert!(fields.peel_u64() == amount && fields.peel_address() == recipient);
    assert!(fields.into_remainder_bytes().is_empty());
}

/// A roster update signed at nonce 2 (weights [2, 1, 0] -> [2, 1, 1]): same
/// group key, epoch 1 -> 2.
fun update_roster(f: &mut TreasuryFixture) {
    let mut organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    org::update_organization_roster(
        &mut organization,
        2,
        vector[ALICE, BOB, ZERO_WEIGHT],
        vector[ALICE, BOB, ZERO_WEIGHT],
        vector[2, 1, 1],
        3,
        SIG_ROSTER_N2,
        f.ctx!(),
    );
    assert!(org::epoch_version(&organization) == 2);
    ts::return_shared(organization);
}

fun advance_epoch(f: &mut TreasuryFixture) {
    let mut organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    // V2 epoch-advance fixture (SUI_ORG_EPOCH_ADVANCE_V2: || chain || org || epoch 1 ||
    // nonce 2 || next 2 || key_generation 1), signed by the sk=0x01*32 fixture key.
    // Org UID = derive_id(txn0, ids=2) — runtime-verified in Round-9 fixture migration.
    let signature = x"0dfd086e1d1686cb032f4a8aa3b46f56dd221314c0c3ffe503a89d1bf0d1fa8336d7840835eb9876d7fa94277477cc90794a9ee438fd73f7df90cdb8fb7a9a02";
    org::advance_organization_epoch(&mut organization, 2, signature, f.ctx!());
    assert!(org::epoch_version(&organization) == 2);
    ts::return_shared(organization);
}

// --- I3 delegation helpers ---

/// The standard delegation: OPERATOR with caps (1000, 500) at nonce 1.
fun delegate(f: &mut TreasuryFixture) {
    delegate_using(f.treasury_id, f.org_id, f.vault_id, OPERATOR, DELEGATED_OUTFLOW, DELEGATED_BUDGET, 1, SIG_DELEGATE_N1, f);
}

fun delegate_using(
    treasury_id: ID, org_id: ID, vault_id: ID, operator: address,
    max_epoch_outflow: u64, max_agent_budget: u64, nonce: u64, signature: vector<u8>, f: &mut TreasuryFixture,
) {
    let self = ts::take_shared_by_id<OrganizationTreasury>(&f.scenario, treasury_id);
    let mut organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, vault_id);
    treasury::delegate_agent_authority(
        &self, &mut organization, &mut vault, operator, max_epoch_outflow, max_agent_budget, nonce, signature, f.ctx!(),
    );
    ts::return_shared(vault);
    ts::return_shared(organization);
    ts::return_shared(self);
}

fun set_outflow(f: &mut TreasuryFixture, max_epoch_outflow: u64, max_agent_budget: u64, nonce: u64, signature: vector<u8>) {
    set_outflow_using(f.treasury_id, f.org_id, f.vault_id, max_epoch_outflow, max_agent_budget, nonce, signature, f);
}

fun set_outflow_using(
    treasury_id: ID, org_id: ID, vault_id: ID,
    max_epoch_outflow: u64, max_agent_budget: u64, nonce: u64, signature: vector<u8>, f: &mut TreasuryFixture,
) {
    let self = ts::take_shared_by_id<OrganizationTreasury>(&f.scenario, treasury_id);
    let mut organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, vault_id);
    treasury::set_agent_outflow_policy(&self, &mut organization, &mut vault, max_epoch_outflow, max_agent_budget, nonce, signature);
    ts::return_shared(vault);
    ts::return_shared(organization);
    ts::return_shared(self);
}

/// The operator spawns a card for `agent` with daily limit `limit` (must fit
/// the delegated budget). Sender and OperatorCap owner are both `operator`.
fun spawn_card(operator: address, agent: address, limit: u64, f: &mut TreasuryFixture) {
    f.next_tx!(operator, |f| {
        let op_cap = ts::take_from_sender<OperatorCap>(&f.scenario);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::spawn_agent_card(&op_cap, &mut vault, agent, limit, b"treasury delegation", f.ctx!());
        ts::return_to_sender(&f.scenario, op_cap);
        ts::return_shared(vault);
    });
}

/// The agent spends `amount` from its card to RECIPIENT.
fun agent_spend(amount: u64, f: &mut TreasuryFixture) {
    agent_spend_as(AGENT, amount, f);
}

/// `agent` spends `amount` to RECIPIENT with the AgentCap it holds.
fun agent_spend_as(agent: address, amount: u64, f: &mut TreasuryFixture) {
    f.next_tx!(agent, |f| {
        let mut agent_cap = ts::take_from_sender<AgentCap>(&f.scenario);
        let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
        vault::spend_x402_budget(&mut agent_cap, &mut vault, amount, RECIPIENT, f.ctx!());
        ts::return_to_sender(&f.scenario, agent_cap);
        ts::return_shared(vault);
    });
}

/// The sender (an operator holding its OperatorCap) spawns the smallest card it
/// may for each junk address, which fills the agent registry.
fun fill_registry(f: &mut TreasuryFixture) {
    let op_cap = ts::take_from_sender<OperatorCap>(&f.scenario);
    let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
    let ctx = f.ctx!();
    let mut i = 0;
    while (i < JUNK_AGENTS.length()) {
        vault::spawn_agent_card(&op_cap, &mut vault, JUNK_AGENTS[i], 1, b"junk", ctx);
        i = i + 1;
    };
    assert!(vault::agent_count(&vault) == 100);
    ts::return_to_sender(&f.scenario, op_cap);
    ts::return_shared(vault);
}

/// Keep the payout ledger clean after a successful agent spend.
fun collect_payout(f: &mut TreasuryFixture) {
    f.next_tx!(RECIPIENT, |f| {
        let payout = ts::take_from_sender<Coin<SUI>>(&f.scenario);
        ts::return_to_sender(&f.scenario, payout);
    });
}

/// test_scenario refuses a second take of the same shared object inside one
/// transaction, so balance and policy assertions share a single borrow.
fun assert_vault_state(f: &TreasuryFixture, vault_id: ID, balance: u64, outflow: u64, budget: u64) {
    let vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, vault_id);
    assert!(vault::vault_balance(&vault) == balance);
    assert!(vault::max_epoch_outflow(&vault) == outflow);
    assert!(vault::max_agent_budget(&vault) == budget);
    ts::return_shared(vault);
}

fun assert_nonce(f: &TreasuryFixture, org_id: ID, nonce: u64) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    assert!(org::last_nonce(&organization) == nonce);
    ts::return_shared(organization);
}

fun assert_delegation_event(
    f: &TreasuryFixture, treasury_id: ID, vault_id: ID, operator: address, outflow: u64, budget: u64, nonce: u64,
) {
    let events = event::events_by_type<AgentAuthorityDelegated>();
    let (t, v, op, o, b, n) = treasury::agent_delegated_fields(&events[events.length() - 1]);
    assert!(t == treasury_id && v == vault_id && op == operator);
    assert!(o == outflow && b == budget && n == nonce);
    // 3 fixed-length IDs + address + 3 u64: no sender or unbounded payload.
    assert!(sui::bcs::to_bytes(&events[events.length() - 1]).length() == 120);
}

fun assert_outflow_event(treasury_id: ID, vault_id: ID, outflow: u64, budget: u64, nonce: u64) {
    let events = event::events_by_type<TreasuryOutflowPolicyUpdated>();
    let (t, v, o, b, n) = treasury::outflow_policy_updated_fields(&events[events.length() - 1]);
    assert!(t == treasury_id && v == vault_id);
    assert!(o == outflow && b == budget && n == nonce);
    // 2 fixed-length IDs + 3 u64: no sender or unbounded payload.
    assert!(sui::bcs::to_bytes(&events[events.length() - 1]).length() == 88);
}

fun fixture_end(f: TreasuryFixture) {
    let TreasuryFixture { scenario, clock, org_id: _, treasury_id: _, vault_id: _, proposal_id: _, binding_id: _, other_org: _ } = f;
    clock.destroy_for_testing();
    scenario.end();
}
