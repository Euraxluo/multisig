#[test_only]
module agent_vault::governance_poll_tests {
    use std::string;
    use sui::{clock::{Self, Clock}, event, test_scenario::{Self, Scenario}};
    use agent_vault::{governance_poll::{Self as poll, Poll, BallotCast, PollPublished}, cryptographic_org::{Self, Organization}};

    // === Constants ===

    const ALICE: address = @0xa;
    const BOB: address = @0xb;
    const EVE: address = @0xe;

    // === Public Types ===

    public struct PollFixture { scenario: Scenario, clock: Clock, publication: vector<PollPublished>, ballots: vector<BallotCast> }

    // === Tests ===

    #[test]
    fun single_ballots_replay_weights_and_preserve_shared_object() {
        let mut f = start_poll(0);
        let events = &f.publication;
        let (id, title, description, options, mode, electorate, weights, deadline, org_id, epoch, group_count, during, link) = poll::published_fields(&events[0]);
        assert!(title == string::utf8(b"Budget") && description == string::utf8(b"Public"), 0);
        assert!(options == option_texts() && mode == 0 && electorate == vector[ALICE, BOB] && weights == vector[3, 2], 0);
        assert!(deadline == 100 && org_id.is_none() && epoch == 0 && group_count == 0 && during && link, 0);
        cast(&mut f, ALICE, vector[1]);
        cast(&mut f, BOB, vector[0]);
        let self = f.scenario.take_shared<Poll>();
        assert!(object::id(&self) == id && poll::scores(&self) == vector[2, 3, 0], 0);
        assert!(poll::ballot_for_testing(&self, 0) == vector[1], 0);
        test_scenario::return_shared(self);
        let ballots = &f.ballots;
        let (first_id, first_choices, first_weight, first_time) = poll::ballot_fields(&ballots[0]);
        let (second_id, second_choices, second_weight, second_time) = poll::ballot_fields(&ballots[1]);
        assert!(first_id == id && first_choices == vector[1] && first_weight == 3 && first_time == 0, 0);
        assert!(second_id == id && second_choices == vector[0] && second_weight == 2 && second_time == 0, 0);
        finish(f);
    }

    #[test]
    fun multiple_approval_counts_each_selected_option_at_full_weight() {
        let mut f = start_poll(1);
        cast(&mut f, ALICE, vector[0, 2]);
        cast(&mut f, BOB, vector[2]);
        assert_scores(&f, vector[3, 0, 5]);
        finish(f);
    }

    #[test]
    fun full_rankings_use_weighted_borda_and_keep_ties() {
        let mut f = start_poll(2);
        cast(&mut f, ALICE, vector[2, 0, 1]);
        cast(&mut f, BOB, vector[1, 0, 2]);
        assert_scores(&f, vector[5, 4, 6]);
        finish(f);
    }

    #[test]
    fun voting_one_millisecond_before_deadline_succeeds() {
        let mut f = start_poll(0);
        f.clock.set_for_testing(99);
        cast(&mut f, ALICE, vector[0]);
        assert_scores(&f, vector[3, 0, 0]);
        finish(f);
    }

    #[test, expected_failure(abort_code = poll::EClosed, location = agent_vault::governance_poll)]
    fun exact_deadline_precedes_membership_and_ballot_checks() {
        let mut f = start_poll(0);
        f.clock.set_for_testing(100);
        cast(&mut f, EVE, vector[99]);
        finish(f);
    }

    #[test, expected_failure(abort_code = poll::EClosed, location = agent_vault::governance_poll)]
    fun after_deadline_rejects_ballots() {
        let mut f = start_poll(0);
        f.clock.set_for_testing(101);
        cast(&mut f, ALICE, vector[0]);
        finish(f);
    }

    #[test, expected_failure(abort_code = poll::ENotVoter, location = agent_vault::governance_poll)]
    fun outsider_cannot_claim_a_voters_weight() {
        let mut f = start_poll(0);
        cast(&mut f, EVE, vector[0]);
        finish(f);
    }

    #[test, expected_failure(abort_code = poll::EAlreadyVoted, location = agent_vault::governance_poll)]
    fun duplicate_vote_precedes_invalid_ballot() {
        let mut f = start_poll(0);
        cast(&mut f, ALICE, vector[0]);
        cast(&mut f, ALICE, vector[99]);
        finish(f);
    }

    #[test, expected_failure(abort_code = poll::EInvalidBallot, location = agent_vault::governance_poll)]
    fun duplicate_choices_cannot_inflate_weight() {
        let mut f = start_poll(1);
        cast(&mut f, ALICE, vector[0, 0]);
        finish(f);
    }

    #[test, expected_failure(abort_code = poll::EInvalidBallot, location = agent_vault::governance_poll)]
    fun partial_rankings_are_rejected() {
        let mut f = start_poll(2);
        cast(&mut f, ALICE, vector[0, 1]);
        finish(f);
    }

    #[test, expected_failure(abort_code = poll::EInvalidBallot, location = agent_vault::governance_poll)]
    fun single_vote_cannot_approve_multiple_options() {
        let mut f = start_poll(0);
        cast(&mut f, ALICE, vector[0, 1]);
        finish(f);
    }

    #[test]
    fun group_and_hybrid_weights_come_from_organization_not_caller() {
        let mut scenario = test_scenario::begin(ALICE);
        let clock = clock::create_for_testing(scenario.ctx());
        cryptographic_org::create_organization_for_testing(vector::tabulate!(32, |_| 1), 2, 3, vector[ALICE, BOB], vector[7, 3], scenario.ctx());
        scenario.next_tx(ALICE);
        let org = scenario.take_shared<Organization>();
        let self = poll::new_group(&org, string::utf8(b"Budget"), string::utf8(b"Public"), option_texts(), 0,
            vector[ALICE, BOB], vector[EVE], vector[2], 100, true, true, &clock, scenario.ctx());
        assert!(poll::weights_for_testing(&self) == vector[7, 3, 2], 0);
        poll::share(self);
        test_scenario::return_shared(org);
        clock.destroy_for_testing();
        scenario.end();
    }

    #[test, expected_failure(abort_code = poll::EManualGroupMember, location = agent_vault::governance_poll)]
    fun hybrid_cannot_override_group_member_weight() {
        let mut scenario = test_scenario::begin(ALICE);
        let clock = clock::create_for_testing(scenario.ctx());
        cryptographic_org::create_organization_for_testing(vector::tabulate!(32, |_| 1), 2, 3, vector[ALICE, BOB], vector[7, 3], scenario.ctx());
        scenario.next_tx(ALICE);
        let org = scenario.take_shared<Organization>();
        let self = poll::new_group(&org, string::utf8(b"Budget"), string::utf8(b"Public"), option_texts(), 0,
            vector[ALICE], vector[BOB], vector[100], 100, true, true, &clock, scenario.ctx());
        poll::share(self);
        test_scenario::return_shared(org);
        clock.destroy_for_testing();
        scenario.end();
    }

    #[test]
    fun maximum_voters_weights_and_options_remain_within_u64() {
        let mut scenario = test_scenario::begin(ALICE);
        let clock = clock::create_for_testing(scenario.ctx());
        let voters = vector::tabulate!(128, |i| sui::address::from_u256((i + 1) as u256));
        let self = poll::new_manual(string::utf8(b"Max"), string::utf8(b""),
            vector::tabulate!(16, |i| std::u64::to_string(i)), 2, voters, vector::tabulate!(128, |_| 1_000_000_000),
            100, false, true, &clock, scenario.ctx());
        poll::share(self);
        let mut i = 0;
        while (i < 128) {
            scenario.next_tx(voters[i]);
            let mut self = scenario.take_shared<Poll>();
            poll::cast_ballot(&mut self, vector::tabulate!(16, |option| option), &clock, scenario.ctx());
            test_scenario::return_shared(self);
            i = i + 1;
        };
        scenario.next_tx(ALICE);
        let self = scenario.take_shared<Poll>();
        assert!(poll::scores(&self) == vector::tabulate!(16, |rank| 128_000_000_000 * (15 - rank)), 0);
        test_scenario::return_shared(self);
        clock.destroy_for_testing();
        scenario.end();
    }

    #[test, expected_failure(abort_code = poll::EInvalidElectorate, location = agent_vault::governance_poll)]
    fun first_voter_above_capacity_is_rejected() {
        constructor_with(vector::tabulate!(129, |i| sui::address::from_u256((i + 1) as u256)), vector::tabulate!(129, |_| 1), 100);
    }

    #[test, expected_failure(abort_code = poll::EInvalidElectorate, location = agent_vault::governance_poll)]
    fun duplicate_voters_are_rejected_before_weight_validation() {
        constructor_with(vector[ALICE, ALICE], vector[0, 0], 100);
    }

    #[test, expected_failure(abort_code = poll::EInvalidElectorate, location = agent_vault::governance_poll)]
    fun empty_electorate_is_rejected() { constructor_with(vector[], vector[], 100); }

    #[test, expected_failure(abort_code = poll::EInvalidWeight, location = agent_vault::governance_poll)]
    fun zero_weight_is_rejected() { constructor_with(vector[ALICE], vector[0], 100); }

    #[test, expected_failure(abort_code = poll::EInvalidWeight, location = agent_vault::governance_poll)]
    fun first_weight_above_limit_is_rejected() { constructor_with(vector[ALICE], vector[1_000_000_001], 100); }

    #[test, expected_failure(abort_code = poll::EInvalidDeadline, location = agent_vault::governance_poll)]
    fun creation_at_deadline_is_rejected() { constructor_with(vector[ALICE], vector[1], 0); }

    #[test, expected_failure(abort_code = poll::EInvalidDeadline, location = agent_vault::governance_poll)]
    fun first_deadline_above_duration_bound_is_rejected() { constructor_with(vector[ALICE], vector[1], 31_536_000_001); }

    // === Fixture Functions ===

    fun constructor_with(electorate: vector<address>, weights: vector<u64>, deadline: u64) {
        let mut scenario = test_scenario::begin(ALICE);
        let clock = clock::create_for_testing(scenario.ctx());
        let self = poll::new_manual(string::utf8(b"Budget"), string::utf8(b""), option_texts(), 0,
            electorate, weights, deadline, false, true, &clock, scenario.ctx());
        poll::share(self);
        clock.destroy_for_testing();
        scenario.end();
    }

    fun option_texts(): vector<std::string::String> { vector[string::utf8(b"A"), string::utf8(b"B"), string::utf8(b"C")] }

    fun start_poll(mode: u8): PollFixture {
        let mut scenario = test_scenario::begin(ALICE);
        let clock = clock::create_for_testing(scenario.ctx());
        let self = poll::new_manual(string::utf8(b"Budget"), string::utf8(b"Public"), option_texts(), mode,
            vector[ALICE, BOB], vector[3, 2], 100, true, true, &clock, scenario.ctx());
        poll::share(self);
        let publication = event::events_by_type<PollPublished>();
        scenario.next_tx(ALICE);
        PollFixture { scenario, clock, publication, ballots: vector[] }
    }

    fun cast(f: &mut PollFixture, sender: address, choices: vector<u64>) {
        f.scenario.next_tx(sender);
        let mut self = f.scenario.take_shared<Poll>();
        poll::cast_ballot(&mut self, choices, &f.clock, f.scenario.ctx());
        let events = event::events_by_type<BallotCast>();
        f.ballots.push_back(events[0]);
        test_scenario::return_shared(self);
        f.scenario.next_tx(sender);
    }

    fun assert_scores(f: &PollFixture, expected: vector<u64>) {
        let self = f.scenario.take_shared<Poll>();
        assert!(poll::scores(&self) == expected, 0);
        test_scenario::return_shared(self);
    }

    fun finish(f: PollFixture) {
        let PollFixture { scenario, clock, publication: _, ballots: _ } = f;
        clock.destroy_for_testing();
        scenario.end();
    }
}
