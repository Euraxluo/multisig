import { SUI_TYPE_ARG, isValidSuiAddress, normalizeStructTag, normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils';
import { Transaction, type TransactionArgument, type TransactionObjectArgument } from '@mysten/sui/transactions';

export const FINANCE_MAX_U64 = (1n << 64n) - 1n;
export const FINANCE_ZERO_ADDRESS = normalizeSuiAddress('0x0');
/** SUI 币种身份以官方常量为准，不要自己拼字符串。 */
export const FINANCE_SUI_TYPE = SUI_TYPE_ARG;

/**
 * 地址校验走官方组合：`normalizeSuiAddress` 补齐短形态但**不会**对非法字符抛错
 * （`'0xzz'` 会被补成 `0x000…zz`），所以必须再拿 `isValidSuiAddress` 验结果。
 */
export function financeAddress(value: string, allowZero = false): string {
  if (typeof value !== 'string') throw new Error('需要有效的非零 Sui 对象 ID 或地址。');
  const normalized = normalizeSuiAddress(value);
  if (!isValidSuiAddress(normalized) || (!allowZero && BigInt(normalized) === 0n)) {
    throw new Error('需要有效的非零 Sui 对象 ID 或地址。');
  }
  return normalized;
}

export function financeCoinType(value: string): string {
  const tag = parseStructTag(value);
  financeAddress(tag.address);
  if (!/^[A-Za-z_]\w*$/.test(tag.module) || !/^[A-Za-z_]\w*$/.test(tag.name)) throw new Error('代币原始类型无效。');
  return normalizeStructTag(tag);
}

export function financeU64(value: bigint | number, positive = false): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('金额和时间必须使用 bigint 或安全整数。');
  const result = BigInt(value);
  if (result < (positive ? 1n : 0n) || result > FINANCE_MAX_U64) throw new Error(positive ? '金额必须大于零且在 u64 范围内。' : '数值超出 u64 范围。');
  return result;
}

/** Pass the transaction being composed; omitted means a new PTB. */
export interface FinanceTransactionOptions {
  packageId?: string;
  transaction?: Transaction;
}

/**
 * 一枚具体 Coin 的引用：对象 ID、本 PTB 里切币/铸币的句柄，或返回该句柄的 thunk。
 * 纯值不是 Coin，所以这里用对象参数类型而不是 TransactionArgument。
 */
export type FinanceCoinInput = string | TransactionObjectArgument;

/**
 * 支付来源——所有付款入口共用这一个形状，`coin` 与 `amount` 二选一：
 *
 * - `{ coin }`：用现成的币。单枚（对象 ID / 本 PTB 句柄）或对象 ID 列表；
 *   列表会先 merge 成一枚再付。金额由调用方保证（合约侧自行校验阈值）。
 * - `{ amount }`：只给金额，由 `tx.coin()` 生成一枚精确的 `Coin<coinType>`。
 *   这是 Sui 的 CoinWithBalance 意图：执行时客户端在**地址余额**（address
 *   balance）与**owned coin 对象**之间自动择优，必要时合并碎片币，调用方
 *   既不必预知自己有哪些币，也不受币碎片化影响。
 *
 * 为便于书写，也接受裸值简写：`'0x…'` 等价 `{ coin: '0x…' }`，
 * 数组等价 `{ coin: [...] }`。
 */
export type FinanceCoinSource =
  | { coin: FinanceCoinInput | FinanceCoinInput[]; amount?: never }
  | { coin?: never; amount: bigint | number }
  | FinanceCoinInput
  | FinanceCoinInput[];

/** 判断是 {coin}/{amount} 形状的来源对象，还是直接给的 Coin 引用（后者是参数/对象/thunk）。 */
function isSourceObject(value: unknown): value is { coin?: FinanceCoinInput | FinanceCoinInput[]; amount?: bigint | number } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && ('coin' in value || 'amount' in value);
}

/** 参数对象（`tx.object(…)` / 纯值句柄等）：靠 Sui 的 Argument 判别字段识别。 */
function isArgumentObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return ['$kind', 'Input', 'Result', 'NestedResult', 'GasCoin'].some((key) => key in value);
}

function asPayment(source: FinanceCoinSource | undefined): { coins: FinanceCoinInput[]; amount?: bigint | number } {
  if (source === undefined) return { coins: [] };
  if (typeof source === 'string') return { coins: [source] };
  if (Array.isArray(source)) return { coins: source };
  if (!isSourceObject(source)) {
    // 既不是 {coin}/{amount} 形状，也不是可识别的参数对象——典型是空对象误传，
    // 当成币会静默构造出无来源的 moveCall，所以在这里拒绝。
    if (!isArgumentObject(source) && typeof source !== 'function') {
      throw new Error('缺少支付来源：提供 coin（对象 ID / 列表 / 本 PTB 句柄）或 amount。');
    }
    return { coins: [source as FinanceCoinInput] };
  }
  const coins = source.coin === undefined ? [] : Array.isArray(source.coin) ? source.coin : [source.coin];
  return { coins, amount: source.amount ?? undefined };
}

/** 把支付来源解析成唯一一个 Coin 参数（多枚 coin 先合并；只给金额则自动选币）。 */
export function financeCoin(tx: Transaction, coinType: string, source: FinanceCoinSource): TransactionObjectArgument {
  const { coins, amount } = asPayment(source);
  if (coins.length > 0 && amount !== undefined) {
    throw new Error('coin 与 amount 只能提供其一：有现成 Coin 就付它，没有才按金额生成。');
  }
  if (coins.length === 1) {
    const only = coins[0];
    return typeof only === 'string' ? tx.object(financeAddress(only)) : only;
  }
  if (coins.length > 1) {
    // mergeCoins 的目标必须是可变对象引用；PTB 里的结果句柄是值，不能当目标。
    // 所以多枚 coin 的第一枚必须是对象 ID，其余可以是对象 ID 或本 PTB 句柄。
    const [head, ...rest] = coins;
    if (typeof head !== 'string') {
      throw new Error('多枚 coin 合并时第一枚必须是对象 ID（合并目标需可变对象引用，本 PTB 句柄不能当目标）。');
    }
    const target = tx.object(financeAddress(head));
    tx.mergeCoins(target, rest.map((c) => (typeof c === 'string' ? tx.object(financeAddress(c)) : c)));
    return target;
  }
  if (amount === undefined) throw new Error('缺少支付来源：提供 coin（对象 ID / 列表 / 本 PTB 句柄）或 amount。');
  return tx.coin({ type: financeCoinType(coinType), balance: financeU64(amount, true) });
}

/**
 * 付款后把余款退回发送者。
 *
 * 有些入口按 `&mut Coin<T>` 收币、只从里面 split 走应收部分（门票+质押、
 * 红包托管额……），余下的找零仍留在币里。Move 不会自动丢弃有值的 Coin，
 * 不处理就是 `UnusedValueWithoutDrop` 整笔失败。传 `tx.gas` 时因为 gas 币
 * 会随交易一起结算，这个坑不显形；换成 SDK 生成的独立 Coin 就必须显式收尾。
 *
 * 余款为 0 时 `mergeCoins` 同样安全（合并空币是 no-op），所以统一走这一条路径。
 */
export function financeReturnChange(tx: Transaction, coin: TransactionObjectArgument, recipient?: string): void {
  if (recipient === undefined) {
    // 退给 gas 币：发送者自己承担 gas，找零自然回到本人。
    tx.mergeCoins(tx.gas, [coin]);
    return;
  }
  tx.transferObjects([coin], tx.pure.address(financeAddress(recipient)));
}

/** amount 必给、coin 可选：给了 coin 就付这枚，否则按 amount 自动选币。 */
export function financeFunding(tx: Transaction, coinType: string, amount: bigint, fundingCoin?: FinanceCoinInput): TransactionObjectArgument {
  return fundingCoin === undefined
    ? financeCoin(tx, coinType, { amount })
    : financeCoin(tx, coinType, { coin: fundingCoin });
}
