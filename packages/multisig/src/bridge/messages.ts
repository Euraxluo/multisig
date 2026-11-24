/**
 * 桥接层文案解析器。
 *
 * SDK 默认使用与前端 zh 字典逐字相同的中文文案；应用可通过
 * `configureBridgeLocale` 注入自己的 i18n 函数（如前端 lib/i18n/t），
 * 使桥接层错误信息随应用语言切换。`{{name}}` 占位符与前端
 * `translate` 的插值语义一致。
 */
export type BridgeTranslateParams = Record<string, string | number | bigint>;
export type BridgeTranslate = (key: string, params?: BridgeTranslateParams) => string;

/** 与 lib/i18n/dictionaries 的 zh 条目逐字一致；改文案必须两处同步。 */
export const BRIDGE_DEFAULT_MESSAGES: Readonly<Record<string, string>> = {
  'dkg.nonceLengthInvalid': '密封的 FROST nonce 长度无效。',
  'dkg.invalidAddress': '无效的 Sui 地址。',
  'dkg.epochMustBeU64': '密钥 Epoch 必须是 u64。',
  'dkg.shareMustBeScalar': '分片必须是规范标量。',
  'dkg.commitmentBytes': '承诺点必须是 32 字节规范压缩点。',
  'dkg.commitmentNotCanonical': '承诺点不是规范 Ed25519 点。',
  'dkg.commitmentInvalidPoint': '承诺点必须是非单位元、素数阶的规范 Ed25519 点。',
  'dkg.networkUnsupported': '设备密钥仅支持 sui:testnet。',
  'dkg.sessionNotCanonical': '会话地址必须规范化。',
  'dkg.emptyRoster': '参与者名册不能为空。',
  'dkg.duplicateParticipants': '参与者地址重复或未规范化。',
  'dkg.invalidThreshold': '无效的 DKG 门限。',
  'dkg.oneOfOneOnly': '单签路径仅支持 1-of-1。',
  'dkg.dealersBelowThreshold': '冻结 dealer 集合 Q 低于门限。',
  'dkg.dealerOrderInvalid': 'dealer 必须属于原始名册且按名册顺序唯一排列。',
  'dkg.commitmentCountMismatch': '承诺系数数量与门限不符。',
  'dkg.packageGroupKeyMismatch': '群公钥与常数项承诺不符。',
  'dkg.keyPackageIdMismatch': '公开 key package 标识不匹配。',
  'dkg.holderNotCanonical': 'holder 地址必须规范化。',
  'dkg.indexRosterMismatch': '本机索引与原始参与者名册不符。',
  'dkg.zeroShare': '最终签名分片不能为零。',
  'dkg.oneOfOneShareMismatch': '1-of-1 分片与群公钥不符。',
  'dkg.finalizeVerifyFailed': '最终分片未通过 FROST key package 校验。',
  'dkg.invalidDealerIndex': '无效的 dealer 索引。',
  'dkg.emptyDealerCommitments': 'dealer 承诺不能为空。',
  'dkg.dealerShareVerifyFailed': 'dealer 分片未通过承诺校验。',
  'dkg.holderNotInRoster': 'holder 不在原始参与者名册中。',
  'dkg.dealerCoeffMismatch': 'dealer 承诺系数数量与门限不符。',
  'dkg.invalidPackageFields': '无效的公开 key package 字段。',
  'dkg.nonCanonicalInteger': '公开 key package 包含非规范整数。',
  'dkg.nonCanonicalPoint': '公开 key package 包含非规范点编码。',
  'dkg.missingCommitments': '公开 key package 缺少承诺。',
  'misc.msgCrypto.empty': '消息不能为空，且最多 1000 字节。',
  'misc.msgCrypto.tooLong': '消息长度超限。',
  'misc.msgCrypto.unsupported': '暂不支持该消息格式。',
  'misc.dmLib.openFailed': '无法打开本机密钥存储，请检查浏览器权限。',
  'misc.dmLib.blocked': '密钥存储被其他页面占用，请关闭其他页面后重试。',
  'misc.dmLib.readFailed': '无法读取本机私聊密钥。',
  'misc.dmLib.saveFailed': '本机私聊密钥未保存，请勿启用私聊。',
  'misc.dmLib.saveRetry': '本机私聊密钥未保存，请重试。',
  'misc.dmLib.enableFirst': '请先在此设备启用私聊。',
  'misc.dmLib.peerNotEnabled': '对方尚未启用私聊。',
  'misc.dmLib.pickOther': '请选择其他联系人。',
  'misc.dmLib.identityNotConfiguredInbox': '身份协议尚未配置，无法读取私信收件箱。',
  'misc.dmLib.inboxRangeInvalid': '私信收件箱查询范围无效。',
  'misc.dmLib.inboxPageStuck': '链上私信收件箱分页未前进。',
  'misc.dmLib.senderMismatch': '链上消息发送方与身份所有者不匹配。',
  'misc.dmLib.senderUnreadable': '发送方身份无法读取。',
  'misc.dmLib.txInvalid': '消息交易执行状态无效。',
  'misc.dmLib.txTimeMissing': '消息交易尚未提供有效的链上时间，请稍后刷新。',
  'misc.dmLib.recipientKeyMismatch': '接收密钥与链上记录不匹配。',
  'misc.dmLib.noKey': '此设备没有该消息的私钥，无法解密。',
  'misc.dmLib.undecryptable': '消息无法解密。',
  'misc.dmLib.historyPageStuck': '链上消息分页未前进。',
  'misc.dmLib.identityNotConfiguredHistory': '身份协议尚未配置，无法读取私信历史。',
  'misc.dmLib.historyRangeInvalid': '私信历史查询范围无效。',
  'misc.dmLib.conflict': '同一链上消息出现冲突记录。',
  'dkg.clickRequired': '必须由用户明确点击确认后发送 FROST 私信。',
  'dkg.dmInvalid': 'FROST 私信无效或发送方身份未认证。',
  'dkg.dmReadFailed': 'FROST 私信无法读取：{{reason}}',
  'dkg.dmTooLong': 'FROST 私信超过 1000 字节上限。',
  'dkg.dmUnavailable': 'FROST 私信不可用。',
  'dkg.identityNotConfigured': '身份协议尚未配置。',
  'dkg.identityNotConfiguredSend': '身份协议尚未配置，已拒绝发送 FROST 私信。',
  'dkg.invalidRoundJson': 'FROST compact round JSON 无效。',
  'dkg.invalidRoundShape': 'FROST compact round shape 无效。',
  'dkg.notInConversation': 'FROST 消息不属于当前私信会话。',
  'dkg.senderMismatch': 'FROST 消息身份与链上认证发送方不匹配。',
  'dkg.roundIdentityMismatch': 'FROST round index 与链上认证身份不匹配。',
  'dkg.transcriptMissingVerify': '缺少已认证的 FROST transcript，无法校验 round 2。',
  'dkg.transcriptMissingSend': '缺少已认证的 FROST transcript，无法发送 round 2。',
  'dkg.roundConflict': 'FROST 同一参与者的 round 出现冲突。',
  'dkg.roundRequestMismatch': 'FROST round 与发送者或请求身份不匹配。',
};

function defaultTranslate(key: string, params?: BridgeTranslateParams): string {
  let text = BRIDGE_DEFAULT_MESSAGES[key] ?? key;
  if (params) {
    text = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => String(params[name] ?? ''));
  }
  return text;
}

let activeTranslate: BridgeTranslate = defaultTranslate;

/** 注入应用 i18n；传 `undefined` 恢复内置中文默认文案。 */
export function configureBridgeLocale(translate?: BridgeTranslate): void {
  activeTranslate = translate ?? defaultTranslate;
}

/** 解析桥接层文案；未注入时返回与前端 zh 字典一致的中文。 */
export function bridgeT(key: string, params?: BridgeTranslateParams): string {
  return activeTranslate(key, params);
}
