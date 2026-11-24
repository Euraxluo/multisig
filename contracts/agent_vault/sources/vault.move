module agent_vault::vault {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::transfer;
    use sui::event;
    use sui::vec_map::{Self, VecMap};

    // === Constants ===

    // --- 错误码定义 ---
    const E_EXCEEDED_DAILY_QUOTA: u64 = 2001;
    const E_AGENT_PAUSED: u64 = 2002;
    const E_CAP_VERSION_MISMATCH: u64 = 2003;
    const E_INSUFFICIENT_VAULT_BALANCE: u64 = 2004;
    const E_UNAUTHORIZED_OPERATOR: u64 = 2005;
    const E_ZERO_AMOUNT: u64 = 2006;
    const E_UNCHANGED_VALUE: u64 = 2007;
    const E_AGENT_NOT_FOUND: u64 = 2008;
    const E_AGENT_LIMIT_REACHED: u64 = 2009;
    const E_AGENT_ALREADY_SPAWNED: u64 = 2010;
    const E_EXCEEDS_AGENT_BUDGET_CAP: u64 = 2012;
    const E_EXCEEDS_EPOCH_OUTFLOW: u64 = 2013;
    const E_ZERO_RECIPIENT: u64 = 2014;
    const E_INVALID_SERVICE_HASH: u64 = 2015;

    /// 单金库可孵化的 Agent 上限：VecMap 内联存储，必须有界。
    const MAX_AGENTS_PER_VAULT: u64 = 100;
    /// Agent 服务标识哈希上限：内联存在金库 agents 表里，持久化输入必须有界。
    const MAX_SERVICE_HASH_BYTES: u64 = 256;

    /// 共享对象：金库核心容器
    public struct AgentVault<phantom T> has key {
        id: UID,
        balance: Balance<T>,
        vault_version: u64,
        total_subagents: u64,
        paused: bool,
        /// 卡片管理状态的唯一事实源：Operator 凭 OperatorCap + Agent 地址即可
        /// 调额/启停，无需（也不可能）引用 Agent 钱包持有的 AgentCap——
        /// Sui 非 owner 不能引用他人 owned object，原先双卡同签的设计在跨账户
        /// 场景结构性不可用（E2E 实测确认）。内联 VecMap 保证 BCS 单对象可读。
        agents: VecMap<address, AgentRecord>,
        /// 金库级流出策略（deny-by-default：全部默认 0，Master 设置前任何
        /// Agent 都无法孵化/花费）。epoch_outflow 与 outflow_epoch 构成
        /// 金库级 epoch 累计，语义与 AgentRecord 的 per-agent 日切一致。
        max_epoch_outflow: u64,
        epoch_outflow: u64,
        outflow_epoch: u64,
        max_agent_budget: u64,
    }

    /// Agent 卡片的管理视图行（额度/支出/启停）：权威存储于金库，
    /// AgentCap 只作消费凭证，不再复制这些字段。
    public struct AgentRecord has copy, drop, store {
        daily_budget_limit: u64,
        spent_in_current_epoch: u64,
        last_spent_epoch: u64,
        service_target_hash: vector<u8>,
        is_active: bool,
    }

    /// 权限 1：MasterCap (老板/财务主管)
    /// - 拥有 key, store 能力，是提现本金与全局紧急单向熔断的唯一凭证
    public struct MasterCap has key, store {
        id: UID,
        vault_id: ID,
    }

    /// 权限 2：OperatorCap (副卡用户/运维经理)
    /// - 具备 key 能力、无 store：不能被包装进其它对象或当作动态字段。
    ///   持有者仍可在自己的签名下用 TransferObjects 把它转给任意地址，
    ///   所以 operator 身份是可转交的，并不绑定在某个人身上。
    /// - 仅能签发 AgentCap、调整额度、启停 Agent，绝对无法提现！
    public struct OperatorCap has key {
        id: UID,
        vault_id: ID,
        vault_version: u64,
        operator_address: address,
    }

    /// 权限 3：AgentCap (AI 打工卡/Subagent) —— 纯消费凭证
    /// - 具备 key 能力，签发后转给 Agent 地址；额度/启停以金库内
    ///   `agents` 表的记录为权威（防双源漂移），本对象只绑定身份与版本。
    public struct AgentCap has key {
        id: UID,
        vault_id: ID,
        vault_version: u64,
        agent_id: address,
    }

    // --- 审计事件 ---
    public struct VaultCreatedEvent has copy, drop {
        vault_id: ID,
        initial_version: u64,
    }

    public struct OperatorIssuedEvent has copy, drop {
        vault_id: ID,
        operator: address,
    }

    public struct AgentCardSpawnedEvent has copy, drop {
        vault_id: ID,
        agent_address: address,
        daily_budget: u64,
    }

    public struct AgentBudgetSpentEvent has copy, drop {
        vault_id: ID,
        agent_id: address,
        amount: u64,
        current_epoch: u64,
        recipient: address,
    }
    /// 【审计 M-01】Master 提现事件（监控口径：所有出金都可观测）
    public struct MasterWithdrawnEvent has copy, drop {
        vault_id: ID,
        amount: u64,
        recipient: address,
        epoch_outflow_after: u64,
    }

    public struct OutflowPolicyUpdatedEvent has copy, drop {
        vault_id: ID,
        max_epoch_outflow: u64,
        max_agent_budget: u64,
    }

    public struct AgentCapsRevokedEvent has copy, drop {
        vault_id: ID,
        new_version: u64,
    }

    public struct EmergencyPurgeEvent has copy, drop {
        vault_id: ID,
        new_version: u64,
        remaining_balance: u64,
    }

    public struct AgentStatusChangedEvent has copy, drop {
        vault_id: ID,
        agent_id: address,
        is_active: bool,
    }

    /// 【I9】Operator 按 Agent 地址调额的审计事件：改变资金上限必须可观测。
    public struct AgentBudgetUpdatedEvent has copy, drop {
        vault_id: ID,
        agent_id: address,
        old_daily_budget: u64,
        new_daily_budget: u64,
    }

    /// 【I9】Master 解除全金库暂停的审计事件：解 pause 与加 pause 必须同样可观测。
    public struct VaultUnpausedEvent has copy, drop {
        vault_id: ID,
    }

    // --- 核心方法 ---

    /// 1. 初始化金库 (颁发 MasterCap 给调用者)
    public fun initialize_vault<T>(ctx: &mut TxContext): MasterCap {
        let vault_uid = object::new(ctx);
        let vault_id = object::uid_to_inner(&vault_uid);
        let vault = AgentVault<T> {
            id: vault_uid,
            balance: balance::zero<T>(),
            vault_version: 1,
            total_subagents: 0,
            paused: false,
            agents: vec_map::empty(),
            max_epoch_outflow: 0,
            epoch_outflow: 0,
            outflow_epoch: 0,
            max_agent_budget: 0,
        };
        transfer::share_object(vault);

        event::emit(VaultCreatedEvent {
            vault_id,
            initial_version: 1,
        });

        MasterCap {
            id: object::new(ctx),
            vault_id,
        }
    }

    /// 存入资金到金库
    public fun deposit<T>(vault: &mut AgentVault<T>, coin: Coin<T>) {
        vault.balance.join(coin.into_balance());
    }

    /// Master 提现本金
    ///
    /// 【审计 T01/L — 显式豁免声明】出金限额的对称性设计（有意为之）：
    ///   - agents（spend 路径）：deny-by-default —— 未设置策略即拒绝花费；
    ///   - Master（本路径）：max_epoch_outflow == 0（从未调用 set_epoch_policy）
    ///     视为 UNLIMITED，Master 可自由提现；一旦设置过策略（>0），
    ///     Master 与 agents 受同一上限约束（见下方 M-01 门禁）。
    /// 理由：金库是 Master 的本金，策略是 Master 自愿给自己上的枷锁；
    /// 若在策略未设时也拒绝，等于初始注资后无法取回。每次提现均
    /// 发出 MasterWithdrawnEvent，链下可完整审计。
    public fun withdraw<T>(
        master: &MasterCap,
        vault: &mut AgentVault<T>,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext
    ) {
        assert!(master.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        assert!(amount > 0, E_ZERO_AMOUNT);
        // 【I9】零地址收款 = 资金永久销毁，与 spend 路径同一防线（E_ZERO_RECIPIENT）。
        assert!(recipient != @0x0, E_ZERO_RECIPIENT);
        assert!(vault.balance.value() >= amount, E_INSUFFICIENT_VAULT_BALANCE);

        // 【审计 M-01】Master 出口同样记账 epoch_outflow，使该上限对所有出金入口成立；
        // 且一旦设置过策略（max_epoch_outflow > 0），Master 也受同一上限约束。
        let current_epoch = ctx.epoch();
        if (vault.outflow_epoch != current_epoch) {
            vault.outflow_epoch = current_epoch;
            vault.epoch_outflow = 0;
        };
        if (vault.max_epoch_outflow > 0) {
            assert!(
                vault.epoch_outflow + amount <= vault.max_epoch_outflow,
                E_EXCEEDS_EPOCH_OUTFLOW
            );
        };
        vault.epoch_outflow = vault.epoch_outflow + amount;

        let split_bal = vault.balance.split(amount);
        let withdraw_coin = coin::from_balance(split_bal, ctx);
        transfer::public_transfer(withdraw_coin, recipient);

        event::emit(MasterWithdrawnEvent {
            vault_id: master.vault_id,
            amount,
            recipient,
            epoch_outflow_after: vault.epoch_outflow,
        });
    }

    /// 2. Master 颁发 OperatorCap 给运维经理
    public fun issue_operator_cap<T>(
        master: &MasterCap,
        vault: &AgentVault<T>,
        operator: address,
        ctx: &mut TxContext
    ) {
        assert!(master.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        let op_cap = OperatorCap {
            id: object::new(ctx),
            vault_id: object::uid_to_inner(&vault.id),
            vault_version: vault.vault_version,
            operator_address: operator,
        };
        event::emit(OperatorIssuedEvent {
            vault_id: master.vault_id,
            operator,
        });
        transfer::transfer(op_cap, operator);
    }

    /// Master 设置金库级流出策略（deny-by-default：默认全 0，任何 Agent
    /// 在策略设置前都无法孵化或花费）。max_epoch_outflow 限制单个 epoch
    /// 内金库总支出的硬上限；max_agent_budget 限制单张 Agent 卡的日额度，
    /// 对已发的卡同样成立——下调后已发卡在花费时按新上限判定（见
    /// spend_x402_budget），无需逐卡改额度。
    public fun set_outflow_policy<T>(
        master: &MasterCap,
        vault: &mut AgentVault<T>,
        max_epoch_outflow: u64,
        max_agent_budget: u64
    ) {
        assert!(master.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        vault.max_epoch_outflow = max_epoch_outflow;
        vault.max_agent_budget = max_agent_budget;
        event::emit(OutflowPolicyUpdatedEvent {
            vault_id: master.vault_id,
            max_epoch_outflow,
            max_agent_budget,
        });
    }

    /// Master 撤销全部副卡：版本号递增，所有已签发的 OperatorCap 与 AgentCap
    /// 永久失效，Agent 登记表清空。与 emergency_unilateral_purge 的区别是
    /// 资金原地不动、金库不进入 paused、已发生的 epoch 支出记录保留。
    /// 不改流出上限：上限归零靠 set_outflow_policy，两者各管一件事。
    public fun revoke_agent_caps<T>(
        master: &MasterCap,
        vault: &mut AgentVault<T>,
    ) {
        assert!(master.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        vault.vault_version = vault.vault_version + 1;
        vault.agents = vec_map::empty();
        vault.total_subagents = 0;

        event::emit(AgentCapsRevokedEvent {
            vault_id: master.vault_id,
            new_version: vault.vault_version,
        });
    }

    /// 3. Operator 孵化 AI Agent 虚拟打工卡
    public fun spawn_agent_card<T>(
        op: &OperatorCap,
        vault: &mut AgentVault<T>,
        agent_address: address,
        daily_budget: u64,
        service_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(op.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        assert!(op.vault_version == vault.vault_version, E_CAP_VERSION_MISMATCH);
        // 有界集合 + 一址一卡：重复孵化以稳定错误拒绝，防重置已发生的支出统计。
        assert!(vec_map::length(&vault.agents) < MAX_AGENTS_PER_VAULT, E_AGENT_LIMIT_REACHED);
        assert!(!vec_map::contains(&vault.agents, &agent_address), E_AGENT_ALREADY_SPAWNED);
        assert!(daily_budget > 0, E_ZERO_AMOUNT);
        assert!(service_hash.length() <= MAX_SERVICE_HASH_BYTES, E_INVALID_SERVICE_HASH);
        // 单卡日额度不得超过 Master 设定的金库级上限
        assert!(daily_budget <= vault.max_agent_budget, E_EXCEEDS_AGENT_BUDGET_CAP);

        vec_map::insert(&mut vault.agents, agent_address, AgentRecord {
            daily_budget_limit: daily_budget,
            spent_in_current_epoch: 0,
            last_spent_epoch: ctx.epoch(),
            service_target_hash: service_hash,
            is_active: true,
        });
        vault.total_subagents = vault.total_subagents + 1;

        let agent_cap = AgentCap {
            id: object::new(ctx),
            vault_id: object::uid_to_inner(&vault.id),
            vault_version: vault.vault_version,
            agent_id: agent_address,
        };

        event::emit(AgentCardSpawnedEvent {
            vault_id: op.vault_id,
            agent_address,
            daily_budget,
        });

        transfer::transfer(agent_cap, agent_address);
    }

    /// Operator 按 Agent 地址调整每日额度。管理状态在金库表内，Operator
    /// 无需（也无需持有）Agent 钱包的 AgentCap —— 跨账户管理自此可行。
    public fun set_agent_budget<T>(
        op: &OperatorCap,
        vault: &mut AgentVault<T>,
        agent_address: address,
        new_daily_budget: u64
    ) {
        assert!(op.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        assert!(op.vault_version == vault.vault_version, E_CAP_VERSION_MISMATCH);
        assert!(vec_map::contains(&vault.agents, &agent_address), E_AGENT_NOT_FOUND);
        assert!(new_daily_budget > 0, E_ZERO_AMOUNT);
        assert!(new_daily_budget <= vault.max_agent_budget, E_EXCEEDS_AGENT_BUDGET_CAP);

        let record = vec_map::get_mut(&mut vault.agents, &agent_address);
        assert!(record.daily_budget_limit != new_daily_budget, E_UNCHANGED_VALUE);
        let old_daily_budget = record.daily_budget_limit;
        record.daily_budget_limit = new_daily_budget;

        // 【I9】调额改变资金上限，必须发审计事件（与启停同一事件密度）。
        event::emit(AgentBudgetUpdatedEvent {
            vault_id: op.vault_id,
            agent_id: agent_address,
            old_daily_budget,
            new_daily_budget,
        });
    }

    /// Operator 按 Agent 地址暂停卡片
    public fun pause_agent<T>(
        op: &OperatorCap,
        vault: &mut AgentVault<T>,
        agent_address: address
    ) {
        assert!(op.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        assert!(op.vault_version == vault.vault_version, E_CAP_VERSION_MISMATCH);
        assert!(vec_map::contains(&vault.agents, &agent_address), E_AGENT_NOT_FOUND);

        let record = vec_map::get_mut(&mut vault.agents, &agent_address);
        assert!(record.is_active, E_UNCHANGED_VALUE);
        record.is_active = false;
        event::emit(AgentStatusChangedEvent {
            vault_id: op.vault_id,
            agent_id: agent_address,
            is_active: false,
        });
    }

    /// Operator 按 Agent 地址恢复卡片
    public fun resume_agent<T>(
        op: &OperatorCap,
        vault: &mut AgentVault<T>,
        agent_address: address
    ) {
        assert!(op.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        assert!(op.vault_version == vault.vault_version, E_CAP_VERSION_MISMATCH);
        assert!(vec_map::contains(&vault.agents, &agent_address), E_AGENT_NOT_FOUND);

        let record = vec_map::get_mut(&mut vault.agents, &agent_address);
        assert!(!record.is_active, E_UNCHANGED_VALUE);
        record.is_active = true;
        event::emit(AgentStatusChangedEvent {
            vault_id: op.vault_id,
            agent_id: agent_address,
            is_active: true,
        });
    }

    /// 4. Agent 执行微支付 (核心沙盒防爆与 Epoch 限额扣减)
    public fun spend_x402_budget<T>(
        agent: &AgentCap,
        vault: &mut AgentVault<T>,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext
    ) {
        // 校验 1: 金库暂停与版本匹配 (熔断检查)；卡片身份以金库表为权威
        assert!(!vault.paused, E_AGENT_PAUSED);
        assert!(agent.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        assert!(agent.vault_version == vault.vault_version, E_CAP_VERSION_MISMATCH);
        assert!(vec_map::contains(&vault.agents, &agent.agent_id), E_AGENT_NOT_FOUND);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(recipient != @0x0, E_ZERO_RECIPIENT);

        let record = vec_map::get_mut(&mut vault.agents, &agent.agent_id);
        assert!(record.is_active, E_AGENT_PAUSED);

        // 校验 2: Epoch 自动日切与额度计算
        let current_epoch = ctx.epoch();
        if (current_epoch > record.last_spent_epoch) {
            record.spent_in_current_epoch = 0;
            record.last_spent_epoch = current_epoch;
        };

        // 校验 3: 超出每日额度立刻 abort！直接中断 PTB，阻断死循环爆仓。
        // 有效额度取卡面额度与金库当前 max_agent_budget 的较小值：下调后的
        // 上限对已发卡立即生效，卡面额度高于新上限的部分花不出去。
        let effective_limit = if (record.daily_budget_limit < vault.max_agent_budget) {
            record.daily_budget_limit
        } else {
            vault.max_agent_budget
        };
        assert!(record.spent_in_current_epoch + amount <= effective_limit, E_EXCEEDED_DAILY_QUOTA);
        assert!(vault.balance.value() >= amount, E_INSUFFICIENT_VAULT_BALANCE);

        // 校验 4: 金库级 epoch 累计流出与硬上限（与 per-agent 记录同一套
        // epoch 语义；跨 epoch 自动清零）。测试环境 ctx.epoch() 恒定，
        // rollover 分支无法在单测中触发，但链上按 epoch 推进自然生效。
        if (current_epoch > vault.outflow_epoch) {
            vault.epoch_outflow = 0;
            vault.outflow_epoch = current_epoch;
        };
        assert!(vault.epoch_outflow + amount <= vault.max_epoch_outflow, E_EXCEEDS_EPOCH_OUTFLOW);
        vault.epoch_outflow = vault.epoch_outflow + amount;
        // 执行资金切分并转移给收款方
        record.spent_in_current_epoch = record.spent_in_current_epoch + amount;
        let split_bal = vault.balance.split(amount);
        let payout_coin = coin::from_balance(split_bal, ctx);
        transfer::public_transfer(payout_coin, recipient);

        event::emit(AgentBudgetSpentEvent {
            vault_id: agent.vault_id,
            agent_id: agent.agent_id,
            amount,
            current_epoch,
            recipient,
        });
    }

    /// 5. Master 独有：一键单向熔断并废除所有副卡 (Purge)
    ///
    /// 「废除所有副卡」包括登记表本身：递增 vault_version 让所有旧
    /// OperatorCap / AgentCap 失效，同时清空 `agents` 表并把
    /// `total_subagents` 置 0。包内没有单独移除 Agent 的入口，若只作废
    /// 凭证而保留登记，被废地址将永久占用 `MAX_AGENTS_PER_VAULT` 名额
    /// （重新签发 Operator 后也无法对同址再发卡），链下监控也会把已废
    /// Agent 读成仍处于激活状态。
    public fun emergency_unilateral_purge<T>(
        master: &MasterCap,
        vault: &mut AgentVault<T>,
        sweep_recipient: address,
        ctx: &mut TxContext
    ) {
        assert!(master.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        // 【I9】扫款目标不得为零地址，否则全部余额随转账永久销毁。
        assert!(sweep_recipient != @0x0, E_ZERO_RECIPIENT);
        // 递增全局版本号：所有旧的 OperatorCap 和 AgentCap 校验 vault_version 立即全部失效！
        vault.vault_version = vault.vault_version + 1;
        vault.paused = true;
        // 【审计 M-01】紧急出口不设限流（必须能扫空），但把 epoch_outflow 置满以便监控告警。
        vault.outflow_epoch = ctx.epoch();
        vault.epoch_outflow = vault.max_epoch_outflow;
        // 【I9】登记表随凭证一并废除：旧记录不再占用名额，重新签发 Operator
        // 后可对同址重新发卡。AgentRecord 具有 drop，直接以空表替换旧表。
        vault.agents = vec_map::empty();
        vault.total_subagents = 0;

        // 一键将所有余额全额归集到老板指定安全地址
        let total_val = vault.balance.value();
        if (total_val > 0) {
            let all_bal = vault.balance.split(total_val);
            let sweep_coin = coin::from_balance(all_bal, ctx);
            transfer::public_transfer(sweep_coin, sweep_recipient);
        };

        event::emit(EmergencyPurgeEvent {
            vault_id: master.vault_id,
            new_version: vault.vault_version,
            remaining_balance: total_val,
        });
    }

    /// Master 解除金库全局暂停
    public fun unpause_vault<T>(
        master: &MasterCap,
        vault: &mut AgentVault<T>
    ) {
        assert!(master.vault_id == object::uid_to_inner(&vault.id), E_UNAUTHORIZED_OPERATOR);
        vault.paused = false;
        // 【I9】解除全金库暂停改变资金可用性，必须发审计事件。
        event::emit(VaultUnpausedEvent {
            vault_id: master.vault_id,
        });
    }

    // --- 只读查询方法 ---

    /// Vault identity bound to this capability. Used by organization treasury
    /// custody without exposing or releasing the capability itself.
    public fun master_vault_id(master: &MasterCap): ID {
        master.vault_id
    }

    public fun vault_balance<T>(vault: &AgentVault<T>): u64 {
        vault.balance.value()
    }

    public fun vault_version<T>(vault: &AgentVault<T>): u64 {
        vault.vault_version
    }

    /// 【I9】累计签发副卡数读取（purge 后归零；与 agent_count 分列，便于
    /// 链下核对登记表与计数器是否一致）。
    public fun total_subagents<T>(vault: &AgentVault<T>): u64 {
        vault.total_subagents
    }

    public fun is_vault_paused<T>(vault: &AgentVault<T>): bool {
        vault.paused
    }

    /// 卡片管理读：以金库表为权威（AgentCap 已不再复制这些字段）。
    public fun agent_daily_limit<T>(vault: &AgentVault<T>, agent_address: address): u64 {
        assert!(vec_map::contains(&vault.agents, &agent_address), E_AGENT_NOT_FOUND);
        vec_map::get(&vault.agents, &agent_address).daily_budget_limit
    }

    public fun agent_spent_in_epoch<T>(vault: &AgentVault<T>, agent_address: address): u64 {
        assert!(vec_map::contains(&vault.agents, &agent_address), E_AGENT_NOT_FOUND);
        vec_map::get(&vault.agents, &agent_address).spent_in_current_epoch
    }

    public fun agent_last_spent_epoch<T>(vault: &AgentVault<T>, agent_address: address): u64 {
        assert!(vec_map::contains(&vault.agents, &agent_address), E_AGENT_NOT_FOUND);
        vec_map::get(&vault.agents, &agent_address).last_spent_epoch
    }

    public fun agent_is_active<T>(vault: &AgentVault<T>, agent_address: address): bool {
        assert!(vec_map::contains(&vault.agents, &agent_address), E_AGENT_NOT_FOUND);
        vec_map::get(&vault.agents, &agent_address).is_active
    }

    public fun agent_service_hash<T>(vault: &AgentVault<T>, agent_address: address): vector<u8> {
        assert!(vec_map::contains(&vault.agents, &agent_address), E_AGENT_NOT_FOUND);
        vec_map::get(&vault.agents, &agent_address).service_target_hash
    }

    public fun agent_count<T>(vault: &AgentVault<T>): u64 {
        vec_map::length(&vault.agents)
    }

    /// 金库级流出策略读接口
    public fun max_epoch_outflow<T>(vault: &AgentVault<T>): u64 {
        vault.max_epoch_outflow
    }

    public fun epoch_outflow<T>(vault: &AgentVault<T>): u64 {
        vault.epoch_outflow
    }

    public fun max_agent_budget<T>(vault: &AgentVault<T>): u64 {
        vault.max_agent_budget
    }

    #[test_only]
    public fun destroy_master_cap_for_testing(master: MasterCap) {
        let MasterCap { id, vault_id: _ } = master;
        id.delete();
    }

    // --- 【I9】测试专用：新审计事件的字段快照（生产读事件 BCS，不走这里） ---

    #[test_only]
    public fun agent_budget_updated_fields_for_testing(
        event: &AgentBudgetUpdatedEvent
    ): (ID, address, u64, u64) {
        (event.vault_id, event.agent_id, event.old_daily_budget, event.new_daily_budget)
    }

    #[test_only]
    public fun vault_unpaused_fields_for_testing(event: &VaultUnpausedEvent): ID {
        event.vault_id
    }
}
