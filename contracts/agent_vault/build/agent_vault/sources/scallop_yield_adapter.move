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

    /// 标的 sSUI 模拟 Witness (对应 Scallop MarketCoin<SUI>)
    public struct SSUI has drop {}

    /// Scallop sSUI 智能群金库适配器 (管理 ChatChannel 对应的 sSUI 头寸与利息收割)
    public struct ScallopVaultAdapter has key {
        id: UID,
        channel_id: ID,
        admin: address,
        total_staked_sui_principal: u64, // 存入的 SUI 原始本金 (保本基准线)
        ssui_balance: Balance<SSUI>,      // 持有的 Scallop sSUI 份额 (按出块秒级连续升值)
        total_harvested_yield_sui: u64,   // 累计已提取并注入群聊的利息总量 (MIST)
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

    /// 1. 为指定聊天群创建 Scallop sSUI 生息适配金库
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

    /// 2. 记录一笔 Scallop 存入：PTB 里先调 Scallop::deposit(market, sui_coin) 拿到
    /// Coin<SSUI>，再把返回的 sSUI 全额转入本适配器。记账的事实源是**实际收到的
    /// sSUI 币值**——函数不收任何裸 u64，调用方无法申报未发生的存入。
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

    /// 3. PTB 第一步：从 sSUI 金库中切出用于赎回利息或本金的 sSUI 份额
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

    /// 4. PTB 第二步：将从 Scallop 借贷池兑回的原生 SUI 增值利息直接注入群聊合约！
    /// 无论由 24h AI 哨兵自动执行，还是由发信人随手触发，都能单笔 PTB 毫秒级分流！
    public fun feed_harvested_yield_to_chat(
        adapter: &mut ScallopVaultAdapter,
        channel: &mut ChatChannel,
        yield_sui: Coin<SUI>,
        ctx: &TxContext
    ) {
        // 修复 #22：适配器只能向自己绑定频道注入收益；且仅 admin 可触发收割。
        assert!(ctx.sender() == adapter.admin, E_NOT_AUTHORIZED);
        assert!(object::id(channel) == adapter.channel_id, E_WRONG_CHANNEL);
        let yield_val = yield_sui.value();
        assert!(yield_val > 0, E_NO_YIELD_AVAILABLE);

        adapter.total_harvested_yield_sui = adapter.total_harvested_yield_sui + yield_val;

        // 原子注入 onchain_chat 触发三路智能分润 (70% 创作者 + 20% Gas池 + 10% 粉丝分红)
        onchain_chat::distribute_staking_yield(channel, yield_sui);

        event::emit(YieldHarvestedAndDistributedEvent {
            adapter_id: object::uid_to_inner(&adapter.id),
            channel_id: adapter.channel_id,
            yield_sui_harvested: yield_val,
            total_harvested_so_far: adapter.total_harvested_yield_sui,
        });
    }

    /// 5. 成员退群或群解散：本金对账清算。PTB 先用 split_ssui_for_redemption 切出
    /// sSUI、经 Scallop::withdraw 兑回 Coin<SUI>，再把**实际兑回的币**传入本函数。
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
