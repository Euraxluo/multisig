module agent_vault::scallop_yield_adapter {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::event;
    use agent_vault::onchain_chat::{Self, ChatChannel};

    // 错误码
    const E_NOT_AUTHORIZED: u64 = 7001;
    const E_NO_YIELD_AVAILABLE: u64 = 7002;
    const E_INSUFFICIENT_SSUI: u64 = 7003;
    const E_WRONG_CHANNEL: u64 = 7004;
    const E_ZERO_DEPOSIT: u64 = 7005;
    /// 【I9 增量】赎回交割的收款地址为零地址：资金会随转账永久销毁。
    const E_ZERO_RECIPIENT: u64 = 7006;

    /// 【如实声明·I4】本地占位 Witness 类型：Move.toml 没有 Scallop 依赖，链上
    /// 不存在任何真实的 Coin<SSUI> 来源（仅测试可用 mint_for_testing 铸出）。
    /// 适配器只做记账，未接入任何借贷协议，不会产生收益。
    public struct SSUI has drop {}

    /// 频道资金的记账适配器（占位实现：管理 ChatChannel 对应的 sSUI 台账）。
    /// 未接入 Scallop 或任何借贷协议，不生息、不自动增值。
    public struct ScallopVaultAdapter has key {
        id: UID,
        channel_id: ID,
        admin: address,
        total_staked_sui_principal: u64, // 存入的 SUI 原始本金 (保本基准线)
        ssui_balance: Balance<SSUI>,      // 持有的占位 sSUI 份额 (无升值；真实 sSUI 未接入)
        total_harvested_yield_sui: u64,   // 累计注入群聊的补贴/收益资金 (MIST，全部来自外部存入)
    }

    // --- 事件定义 ---
    /// 适配器为 shared 对象且无 owner 反查：创建必须发事件，供频道 → 适配器索引重建。
    public struct ScallopAdapterCreatedEvent has copy, drop {
        adapter_id: ID,
        channel_id: ID,
        admin: address,
    }

    public struct StakedIntoScallopEvent has copy, drop {
        adapter_id: ID,
        channel_id: ID,
        sui_amount: u64,
        ssui_minted: u64,
        total_principal: u64,
    }

    public struct YieldHarvestedAndDistributedEvent has copy, drop {
        adapter_id: ID,
        channel_id: ID,
        yield_sui_harvested: u64,
        total_harvested_so_far: u64,
    }

    public struct PrincipalRedeemedEvent has copy, drop {
        adapter_id: ID,
        channel_id: ID,
        recipient: address,
        sui_returned: u64,
        ssui_burned: u64,
    }

    /// 1. 为指定聊天群创建记账适配金库（占位实现：不生息，未接入借贷协议）
    public fun create_scallop_adapter(
        channel: &ChatChannel,
        ctx: &mut TxContext
    ): ID {
        let uid = object::new(ctx);
        let adapter_id = object::uid_to_inner(&uid);
        let channel_id = object::id(channel);
        let admin = ctx.sender();

        event::emit(ScallopAdapterCreatedEvent {
            adapter_id,
            channel_id,
            admin,
        });

        let adapter = ScallopVaultAdapter {
            id: uid,
            channel_id,
            admin,
            total_staked_sui_principal: 0,
            ssui_balance: balance::zero<SSUI>(),
            total_harvested_yield_sui: 0,
        };

        transfer::share_object(adapter);
        adapter_id
    }

    /// 2. 记录一笔存入：把调用方传入的 Coin<SSUI> 全额转入本适配器。记账的
    /// 事实源是**实际收到的 sSUI 币值**——函数不收任何裸 u64，调用方无法申报
    /// 未发生的存入。
    /// 注意（I4）：占位实现里没有 Scallop::deposit 可调，链上也没有真实
    /// Coin<SSUI> 的铸造来源——接入真实协议前，此入口没有可用的生产路径。
    /// （修复 #21：旧签名收 sui_amount: u64 且无鉴权，任何人可用 coin::zero<SSUI>
    /// 把 total_staked_sui_principal 写成任意值。）
    public fun deposit_to_scallop(
        adapter: &mut ScallopVaultAdapter,
        ctx: &TxContext,
        ssui_minted_coin: Coin<SSUI>
    ) {
        assert!(ctx.sender() == adapter.admin, E_NOT_AUTHORIZED);
        let ssui_val = ssui_minted_coin.value();
        assert!(ssui_val > 0, E_ZERO_DEPOSIT);
        adapter.total_staked_sui_principal = adapter.total_staked_sui_principal + ssui_val;
        adapter.ssui_balance.join(ssui_minted_coin.into_balance());

        event::emit(StakedIntoScallopEvent {
            adapter_id: object::uid_to_inner(&adapter.id),
            channel_id: adapter.channel_id,
            sui_amount: ssui_val,
            ssui_minted: ssui_val,
            total_principal: adapter.total_staked_sui_principal,
        });
    }

    /// 3. PTB 第一步：从 sSUI 台账中切出用于赎回本金（或外部处置）的 sSUI 份额
    public fun split_ssui_for_redemption(
        adapter: &mut ScallopVaultAdapter,
        ssui_to_redeem: u64,
        ctx: &mut TxContext
    ): Coin<SSUI> {
        assert!(ctx.sender() == adapter.admin, E_NOT_AUTHORIZED);
        assert!(adapter.ssui_balance.value() >= ssui_to_redeem, E_INSUFFICIENT_SSUI);
        let split_bal = adapter.ssui_balance.split(ssui_to_redeem);
        coin::from_balance(split_bal, ctx)
    }

    /// 4. 把一笔调用方自备的原生 SUI 注入群聊合约（I4：本适配器未接入任何
    /// 借贷协议，不会自己产出收益——注入的每笔资金都来自外部）。
    /// 无论由机器人定期执行，还是由发信人随手触发，都能单笔 PTB 完成注入。
    public fun feed_harvested_yield_to_chat(
        adapter: &mut ScallopVaultAdapter,
        channel: &mut ChatChannel,
        yield_sui: Coin<SUI>,
        ctx: &TxContext
    ) {
        // 修复 #22：适配器只能向自己绑定频道注入收益；且仅 admin 可触发注入。
        assert!(ctx.sender() == adapter.admin, E_NOT_AUTHORIZED);
        assert!(object::id(channel) == adapter.channel_id, E_WRONG_CHANNEL);
        let yield_val = yield_sui.value();
        assert!(yield_val > 0, E_NO_YIELD_AVAILABLE);

        adapter.total_harvested_yield_sui = adapter.total_harvested_yield_sui + yield_val;

        // 原子注入 onchain_chat，按频道各自配置的 bps 三路分润（示例 7000/2000/1000 并非固定值）
        onchain_chat::distribute_staking_yield(channel, yield_sui);

        event::emit(YieldHarvestedAndDistributedEvent {
            adapter_id: object::uid_to_inner(&adapter.id),
            channel_id: adapter.channel_id,
            yield_sui_harvested: yield_val,
            total_harvested_so_far: adapter.total_harvested_yield_sui,
        });
    }

    /// 5. 成员退群或群解散：本金对账清算。PTB 先用 split_ssui_for_redemption 切出
    /// sSUI、在外部把份额处置成 Coin<SUI>（占位实现没有 Scallop::withdraw 可调），
    /// 再把**实际收到的币**传入本函数。
    /// 事实源 = coin.value()（修复 #21 同病：旧签名收裸 u64，可对虚构基线"赎回"）。
    /// 币在函数内真实交付 recipient；ssui_burned 由传入的 sSUI 份额扣减记账。
    public fun record_principal_redemption(
        adapter: &mut ScallopVaultAdapter,
        sui_returned: Coin<SUI>,
        ssui_burned: u64,
        recipient: address,
        ctx: &TxContext
    ) {
        assert!(ctx.sender() == adapter.admin, E_NOT_AUTHORIZED);
        let sui_val = sui_returned.value();
        assert!(sui_val > 0, E_NO_YIELD_AVAILABLE);
        // 【I9 增量】零地址收款 = 资金永久销毁，先于台账扣减与真实交割拒绝。
        assert!(recipient != @0x0, E_ZERO_RECIPIENT);

        if (adapter.total_staked_sui_principal >= sui_val) {
            adapter.total_staked_sui_principal = adapter.total_staked_sui_principal - sui_val;
        } else {
            adapter.total_staked_sui_principal = 0;
        };

        // 真实交割：本金直接转给退群成员
        transfer::public_transfer(sui_returned, recipient);

        event::emit(PrincipalRedeemedEvent {
            adapter_id: object::uid_to_inner(&adapter.id),
            channel_id: adapter.channel_id,
            recipient,
            sui_returned: sui_val,
            ssui_burned,
        });
    }

    // --- 查询与视图方法 ---
    public fun total_staked_sui_principal(adapter: &ScallopVaultAdapter): u64 {
        adapter.total_staked_sui_principal
    }

    public fun ssui_balance(adapter: &ScallopVaultAdapter): u64 {
        adapter.ssui_balance.value()
    }

    public fun total_harvested_yield(adapter: &ScallopVaultAdapter): u64 {
        adapter.total_harvested_yield_sui
    }
}
