/// Public, advisory governance polls. Electorates and weights are fixed at
/// publication; group weights are verified against Organization at that time.
/// Ballots remain publicly readable. These polls grant no asset authority.
module agent_vault::governance_poll {
    use std::string::String;
    use sui::{clock::Clock, event};
    use agent_vault::cryptographic_org::{Self, Organization};

    // === Constants ===

    const MAX_VOTERS: u64 = 128;
    const MAX_OPTIONS: u64 = 16;
    const MAX_WEIGHT: u64 = 1_000_000_000;
    const MAX_DURATION_MS: u64 = 31_536_000_000;

    // === Errors ===

    #[error(code = 1)]
    const EInvalidMode: vector<u8> = b"Mode must be single (0), multiple approval (1), or full Borda ranking (2).";
    #[error(code = 2)]
    const EInvalidText: vector<u8> = b"Title, description, or option text violates its byte bound, or options repeat.";
    #[error(code = 3)]
    const EInvalidOptions: vector<u8> = b"A poll requires between 2 and 16 options.";
    #[error(code = 4)]
    const EInvalidElectorate: vector<u8> = b"A poll requires 1 to 128 distinct, nonzero voters with matching weights.";
    #[error(code = 5)]
    const EInvalidWeight: vector<u8> = b"Each weight must be between 1 and 1000000000.";
    #[error(code = 6)]
    const EInvalidDeadline: vector<u8> = b"Deadline must be after Clock time and no more than 365 days away.";
    #[error(code = 7)]
    const ENotGroupMember: vector<u8> = b"Publisher and selected group voters must be members of this Organization.";
    #[error(code = 8)]
    const EManualGroupMember: vector<u8> = b"A group member cannot bypass their group weight through the manual electorate.";
    #[error(code = 9)]
    const EClosed: vector<u8> = b"Voting is closed at and after deadline_ms.";
    #[error(code = 10)]
    const ENotVoter: vector<u8> = b"The transaction sender is not in this poll's fixed electorate.";
    #[error(code = 11)]
    const EAlreadyVoted: vector<u8> = b"A voter may cast exactly one ballot in this poll.";
    #[error(code = 12)]
    const EInvalidBallot: vector<u8> = b"Ballot must contain distinct valid indices with the cardinality required by the poll mode.";

    // === Public Types ===

    /// Shared, retained public history with bounded inline ballots. No cap,
    /// token balance, NFT, encryption, or treasury execution is implied.
    public struct Poll has key {
        id: UID,
        creator: address,
        title: String,
        description: String,
        options: vector<String>,
        mode: u8,
        electorate: vector<address>,
        weights: vector<u64>,
        ballots: vector<vector<u64>>,
        cast_at_ms: vector<u64>,
        deadline_ms: u64,
        org_id: Option<ID>,
        org_epoch: u64,
        group_voter_count: u64,
        show_results_during: bool,
        allow_link_access: bool,
    }

    /// Immutable settings plus native sender metadata reconstruct publication.
    public struct PollPublished has copy, drop {
        poll_id: ID,
        title: String,
        description: String,
        options: vector<String>,
        mode: u8,
        electorate: vector<address>,
        weights: vector<u64>,
        deadline_ms: u64,
        org_id: Option<ID>,
        org_epoch: u64,
        group_voter_count: u64,
        show_results_during: bool,
        allow_link_access: bool,
    }

    /// Native sender identifies the ballot owner. Choices are public indices;
    /// their order matters only for the full Borda ranking mode.
    public struct BallotCast has copy, drop {
        poll_id: ID,
        choices: vector<u64>,
        weight: u64,
        cast_at_ms: u64,
    }

    // === Public Functions ===

    /// Create a manually weighted poll. The creator chooses the entire roster.
    public fun new_manual(
        title: String,
        description: String,
        options: vector<String>,
        mode: u8,
        electorate: vector<address>,
        weights: vector<u64>,
        deadline_ms: u64,
        show_results_during: bool,
        allow_link_access: bool,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Poll {
        new_poll(title, description, options, mode, electorate, weights,
            deadline_ms, option::none(), 0, 0, show_results_during,
            allow_link_access, clock, ctx)
    }

    /// Snapshot selected group members with authoritative weights. Optional
    /// manual additions implement hybrid mode; members cannot override weights
    /// through that path. Later organization epochs do not alter this snapshot.
    public fun new_group(
        org: &Organization,
        title: String,
        description: String,
        options: vector<String>,
        mode: u8,
        group_voters: vector<address>,
        manual_voters: vector<address>,
        manual_weights: vector<u64>,
        deadline_ms: u64,
        show_results_during: bool,
        allow_link_access: bool,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Poll {
        assert!(cryptographic_org::is_member(org, ctx.sender()), ENotGroupMember);
        let group_voter_count = group_voters.length();
        assert!(group_voter_count > 0 && group_voter_count + manual_voters.length() <= MAX_VOTERS, EInvalidElectorate);
        assert!(manual_voters.length() == manual_weights.length(), EInvalidElectorate);
        let mut weights = vector[];
        group_voters.do_ref!(|voter| {
            let weight = cryptographic_org::member_weight(org, *voter);
            assert!(weight > 0, ENotGroupMember);
            weights.push_back(weight);
        });
        manual_voters.do_ref!(|voter| {
            assert!(!cryptographic_org::is_member(org, *voter), EManualGroupMember);
        });
        let mut electorate = group_voters;
        electorate.append(manual_voters);
        weights.append(manual_weights);

        new_poll(title, description, options, mode, electorate, weights,
            deadline_ms, option::some(object::id(org)), cryptographic_org::epoch_version(org),
            group_voter_count, show_results_during, allow_link_access, clock, ctx)
    }

    /// Publish as a top-level shared object, keeping its ID directly readable.
    public fun share(self: Poll) {
        event::emit(PollPublished {
            poll_id: self.id.to_inner(), title: self.title, description: self.description,
            options: self.options, mode: self.mode, electorate: self.electorate,
            weights: self.weights, deadline_ms: self.deadline_ms, org_id: self.org_id,
            org_epoch: self.org_epoch, group_voter_count: self.group_voter_count,
            show_results_during: self.show_results_during, allow_link_access: self.allow_link_access,
        });
        transfer::share_object(self);
    }

    /// Cast once, strictly before the deadline. Single: one index. Multiple:
    /// one or more approvals. Ranked: every index once, best first; N-1..0
    /// weighted Borda points. No replacement, delegation, or early closing.
    public fun cast_ballot(self: &mut Poll, choices: vector<u64>, clock: &Clock, ctx: &TxContext) {
        assert!(clock.timestamp_ms() < self.deadline_ms, EClosed);
        let (eligible, voter_index) = self.electorate.index_of(&ctx.sender());
        assert!(eligible, ENotVoter);
        assert!(self.ballots[voter_index].is_empty(), EAlreadyVoted);
        let count = choices.length();
        let option_count = self.options.length();
        assert!(count > 0 && count <= option_count, EInvalidBallot);
        assert!(self.mode != 0 || count == 1, EInvalidBallot);
        assert!(self.mode != 2 || count == option_count, EInvalidBallot);
        let mut seen = vector[];
        choices.do_ref!(|choice| {
            assert!(*choice < option_count && !seen.contains(choice), EInvalidBallot);
            seen.push_back(*choice);
        });

        *&mut self.ballots[voter_index] = choices;
        *&mut self.cast_at_ms[voter_index] = clock.timestamp_ms();

        event::emit(BallotCast {
            poll_id: self.id.to_inner(), choices, weight: self.weights[voter_index],
            cast_at_ms: clock.timestamp_ms(),
        });
    }

    /// Canonical public scores for trustless composition. A tie stays a tie;
    /// these advisory scores do not authorize treasury actions.
    public fun scores(self: &Poll): vector<u64> {
        let mut scores = vector::tabulate!(self.options.length(), |_| 0);
        let mut voter_index = 0;
        while (voter_index < self.electorate.length()) {
            let ballot = &self.ballots[voter_index];
            let mut rank = 0;
            while (rank < ballot.length()) {
                let points = if (self.mode == 2) self.options.length() - 1 - rank else 1;
                *&mut scores[ballot[rank]] = scores[ballot[rank]] + self.weights[voter_index] * points;
                rank = rank + 1;
            };
            voter_index = voter_index + 1;
        };
        scores
    }

    // === Private Functions ===

    fun new_poll(
        title: String, description: String, options: vector<String>, mode: u8,
        electorate: vector<address>, weights: vector<u64>, deadline_ms: u64,
        org_id: Option<ID>, org_epoch: u64, group_voter_count: u64,
        show_results_during: bool, allow_link_access: bool, clock: &Clock, ctx: &mut TxContext,
    ): Poll {
        assert!(mode <= 2, EInvalidMode);
        assert!(title.length() > 0 && title.length() <= 256 && description.length() <= 4096, EInvalidText);
        assert!(options.length() >= 2 && options.length() <= MAX_OPTIONS, EInvalidOptions);
        let mut seen_options = vector[];
        options.do_ref!(|text| {
            assert!(text.length() > 0 && text.length() <= 256 && !seen_options.contains(text), EInvalidText);
            seen_options.push_back(*text);
        });
        assert!(electorate.length() > 0 && electorate.length() <= MAX_VOTERS && electorate.length() == weights.length(), EInvalidElectorate);
        let mut seen_voters = vector[];
        electorate.do_ref!(|voter| {
            assert!(*voter != @0x0 && !seen_voters.contains(voter), EInvalidElectorate);
            seen_voters.push_back(*voter);
        });
        weights.do_ref!(|weight| assert!(*weight > 0 && *weight <= MAX_WEIGHT, EInvalidWeight));
        assert!(deadline_ms > clock.timestamp_ms() && deadline_ms - clock.timestamp_ms() <= MAX_DURATION_MS, EInvalidDeadline);

        Poll {
            id: object::new(ctx), creator: ctx.sender(), title, description, options, mode,
            ballots: vector::tabulate!(electorate.length(), |_| vector[]),
            cast_at_ms: vector::tabulate!(electorate.length(), |_| 0),
            electorate, weights, deadline_ms, org_id, org_epoch, group_voter_count,
            show_results_during, allow_link_access,
        }
    }

    // === Test-Only Functions ===

    #[test_only]
    public fun ballot_for_testing(self: &Poll, index: u64): vector<u64> { self.ballots[index] }

    #[test_only]
    public fun weights_for_testing(self: &Poll): vector<u64> { self.weights }

    #[test_only]
    public fun published_fields(event: &PollPublished): (ID, String, String, vector<String>, u8, vector<address>, vector<u64>, u64, Option<ID>, u64, u64, bool, bool) {
        (event.poll_id, event.title, event.description, event.options, event.mode, event.electorate,
            event.weights, event.deadline_ms, event.org_id, event.org_epoch, event.group_voter_count,
            event.show_results_during, event.allow_link_access)
    }

    #[test_only]
    public fun ballot_fields(event: &BallotCast): (ID, vector<u64>, u64, u64) {
        (event.poll_id, event.choices, event.weight, event.cast_at_ms)
    }
}
