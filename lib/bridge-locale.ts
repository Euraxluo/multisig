/**
 * 把前端 i18n 注入 `multisig/bridge`。
 *
 * 前端 `t` 在调用时按当前 locale 求值，因此注入一次即可让桥接层错误文案
 * 随应用语言切换；SDK 在无宿主注入时回落到内置中文默认文案。
 */
import { configureBridgeLocale } from "multisig/bridge"
import { t } from "@/lib/i18n/t"

configureBridgeLocale(t)
