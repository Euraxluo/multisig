import { Transaction } from "@mysten/sui/transactions"
import type { SuiClientTypes } from "@mysten/sui/client"
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils"
import {
  PaymentBcs, PaymentCapBcs, PaymentCreatedBcs, ScheduleBcs, StatusBcs,
  buildCreatePayment as sdkBuildCreatePayment, buildPaymentAction as sdkBuildPaymentAction,
  claimableUnits, FREQUENCY_MS, paymentUnits, recurringCount, vestedUnits,
  type NewPayment, type NewRecurringPayment, type NewStreamPayment, type PaymentAction, type PaymentSnapshot,
} from "multisig/agent-vault/finance"
import { createFinanceReader } from "multisig/agent-vault/finance"
import { AGENT_VAULT_PACKAGE_ID } from "multisig/agent-vault/org"
import { listTransactionReceipts } from "./pending-transactions"
import { t } from "./i18n/t"
import { proposalClient } from "./proposal-chain"

export const PAYMENTS_PACKAGE_ID = process.env.NEXT_PUBLIC_SCHEDULED_PAYMENTS_PACKAGE_ID || AGENT_VAULT_PACKAGE_ID
export const ZERO_SCOPE = normalizeSuiAddress("0x0")
const signal = () => AbortSignal.timeout(20_000)

export { PaymentBcs, PaymentCapBcs, PaymentCreatedBcs, ScheduleBcs, StatusBcs, claimableUnits, FREQUENCY_MS, paymentUnits, recurringCount, vestedUnits }
export type { NewPayment, NewRecurringPayment, NewStreamPayment, PaymentAction, PaymentSnapshot }

function signature(body: SuiClientTypes.OpenSignatureBody): string {
  if (body.$kind === "datatype") return `${normalizeStructTag(body.datatype.typeName)}${body.datatype.typeParameters.length ? `<${body.datatype.typeParameters.map(signature).join(",")}>` : ""}`
  if (body.$kind === "vector") return `vector<${signature(body.vector)}>`
  if (body.$kind === "typeParameter") return `$${body.index}`
  return body.$kind
}
const framework = (name: string) => normalizeStructTag(`0x2::${name}`)

type ChainClient = Pick<typeof proposalClient, "getObject" | "getMoveFunction" | "listEvents" | "listOwnedObjects" | "movePackageService">

export function createScheduledPaymentsReader(client: ChainClient, packageId = PAYMENTS_PACKAGE_ID) {
  let deployment: Promise<{ origin: string }> | undefined
  const moduleName = "scheduled_payments"

  async function requireDeployment() {
    if (!deployment) deployment = (async () => {
      const names = ["Payment", "PaymentCap", "Schedule", "Status", "PaymentCreated"]
      let types: SuiClientTypes.DatatypeResponse[]
      try {
        types = await Promise.all(names.map(async name => {
          const { response } = await client.movePackageService.getDatatype({ packageId, moduleName, name }, { abort: signal() })
          if (!response.datatype) throw new Error(`Missing datatype ${name}`)
          const raw = response.datatype
          const body = (type: NonNullable<typeof raw.fields[number]["type"]>): SuiClientTypes.OpenSignatureBody => {
            const primitives = ["unknown", "address", "bool", "u8", "u16", "u32", "u64", "u128", "u256"] as const
            if (type.type !== undefined && type.type >= 0 && type.type <= 8) {
              const primitive = primitives.at(type.type)
              if (primitive) return { $kind: primitive }
            }
            if (type.type === 9 && type.typeParameterInstantiation.length === 1) return { $kind: "vector", vector: body(type.typeParameterInstantiation[0]) }
            if (type.type === 10 && type.typeName) return { $kind: "datatype", datatype: { typeName: type.typeName, typeParameters: type.typeParameterInstantiation.map(body) } }
            if (type.type === 11 && type.typeParameter !== undefined) return { $kind: "typeParameter", index: type.typeParameter }
            throw new Error(t("payments.errTypeSignatureMissing"))
          }
          const fields = (fields: typeof raw.fields): SuiClientTypes.FieldDescriptor[] => fields.map(field => {
            if (field.name === undefined || field.position === undefined || !field.type) throw new Error(t("payments.errAbiFieldMissing"))
            return { name: field.name, position: field.position, type: body(field.type) }
          })
          if (!raw.name || !raw.typeName || !raw.definingId || !raw.module) throw new Error(t("payments.errTypeIdentityMissing"))
          const base = { name: raw.name, typeName: raw.typeName, definingId: raw.definingId, moduleName: raw.module,
            abilities: raw.abilities.map(value => ["unknown", "copy", "drop", "store", "key"][value]) as SuiClientTypes.Ability[],
            typeParameters: raw.typeParameters.map(type => ({ isPhantom: type.isPhantom === true, constraints: type.constraints.map(value => ["unknown", "copy", "drop", "store", "key"][value]) as SuiClientTypes.Ability[] })),
          }
          if (raw.kind === 1) return { ...base, $kind: "struct" as const, fields: fields(raw.fields) }
          if (raw.kind === 2) return { ...base, $kind: "enum" as const, variants: raw.variants.map(variant => {
            if (!variant.name || variant.position === undefined) throw new Error(t("payments.errEnumFieldMissing"))
            return { name: variant.name, position: variant.position, fields: fields(variant.fields) }
          }) }
          throw new Error(t("payments.errUnknownPaymentType"))
        }))
      } catch (error) {
        throw new Error(t("payments.errCannotVerifyDeployment") + (error instanceof Error ? ` ${error.message}` : ""))
      }
      const origin = normalizeSuiAddress(types[0].definingId)
      const local = (name: string) => `${origin}::${moduleName}::${name}`
      const fields: Record<string, string[]> = {
        Payment: ["id:" + framework("object::UID"), "recipient:address", "refund_address:address", "scope:address", "name:vector<u8>", "schedule:" + local("Schedule"), "start_ms:u64", "paused_ms:u64", "status:" + local("Status"), "balance:" + framework("balance::Balance") + "<$0>", "funded:u64", "paid:u64", "refunded:u64", "installments_paid:u64"],
        PaymentCap: ["id:" + framework("object::UID"), "payment_id:" + framework("object::ID")],
        PaymentCreated: ["payment_id:" + framework("object::ID"), "recipient:address", "scope:address", "name:vector<u8>", "schedule:" + local("Schedule"), "start_ms:u64", "funded:u64"],
      }
      const expectedVariants: Record<string, Record<string, string[]>> = {
        Schedule: { Recurring: ["amount:u64", "interval_ms:u64", "max_count:u64", "end_ms:u64", "requires_approval:bool"], Stream: ["duration_ms:u64", "curve:u8"] },
        Status: { Active: [], Paused: ["at_ms:u64"], Terminated: [] },
      }
      const checkFields = (actual: SuiClientTypes.FieldDescriptor[], expected: string[]) => {
        if (actual.length !== expected.length || actual.some((field, index) => field.position !== index || `${field.name}:${signature(field.type)}` !== expected[index])) throw new Error(t("payments.errBcsAbiMismatch"))
      }
      for (const type of types) {
        const labels = [local(type.name), `${normalizeSuiAddress(packageId)}::${moduleName}::${type.name}`]
        if (type.moduleName !== moduleName || normalizeSuiAddress(type.definingId) !== origin || !labels.includes(normalizeStructTag(type.typeName))) throw new Error(t("payments.errTypeOriginMismatch"))
        const expectedAbilities = type.name === "Payment" ? ["key"] : type.name === "PaymentCap" ? ["key", "store"] : type.name === "PaymentCreated" ? ["copy", "drop"] : ["copy", "drop", "store"]
        if (JSON.stringify([...type.abilities].sort()) !== JSON.stringify(expectedAbilities.sort())) throw new Error(t("payments.errAbilitiesMismatch"))
        const generic = ["Payment", "PaymentCreated"].includes(type.name)
        if (type.typeParameters.length !== (generic ? 1 : 0) || (generic && (!type.typeParameters[0].isPhantom || type.typeParameters[0].constraints.length))) throw new Error(t("payments.errTypeParamsMismatch"))
        if (type.$kind === "struct" && fields[type.name]) checkFields(type.fields, fields[type.name])
        else if (type.$kind === "enum" && expectedVariants[type.name]) {
          const variants = Object.entries(expectedVariants[type.name])
          if (type.variants.length !== variants.length) throw new Error(t("payments.errStatusAbiMismatch"))
          type.variants.forEach((variant, index) => {
            if (variant.position !== index || variant.name !== variants[index][0]) throw new Error(t("payments.errStatusAbiMismatch"))
            checkFields(variant.fields, variants[index][1])
          })
        } else throw new Error(t("payments.errLayoutMismatch"))
      }
      const coin = framework("coin::Coin") + "<$0>"
      const clock = "&" + framework("clock::Clock")
      const ctx = "&mut " + framework("tx_context::TxContext")
      const payment = "&mut " + local("Payment") + "<$0>"
      const cap = "&" + local("PaymentCap")
      const functions: Record<string, string[]> = {
        create_recurring: [coin, "address", "address", "vector<u8>", "u64", "u64", "u64", "u64", "u64", "bool", clock, ctx],
        create_stream: [coin, "address", "address", "vector<u8>", "u64", "u64", "u8", clock, ctx],
        fund: [payment, cap, coin], claim: [payment, clock, ctx], execute_installment: [payment, cap, clock, ctx],
        pause: [payment, cap, clock], resume: [payment, cap, clock], terminate: [payment, cap, clock, ctx],
      }
      await Promise.all(Object.entries(functions).map(async ([name, expected]) => {
        const { function: fn } = await client.getMoveFunction({ packageId, moduleName, name, signal: signal() })
        const actual = fn.parameters.map(parameter => `${parameter.reference === "mutable" ? "&mut " : parameter.reference === "immutable" ? "&" : ""}${signature(parameter.body)}`)
        if (fn.visibility !== "public" || fn.typeParameters.length !== 1 || fn.typeParameters[0].constraints.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(t("payments.errFunctionAbiMismatch", { name }))
        const returns = fn.returns.map(result => signature(result.body))
        if (JSON.stringify(returns) !== JSON.stringify(name.startsWith("create_") ? [framework("object::ID")] : [])) throw new Error(t("payments.errFunctionReturnsMismatch", { name }))
      }))
      return { origin }
    })().catch(error => { deployment = undefined; throw error })
    return deployment
  }

  async function readPayment(objectId: string): Promise<PaymentSnapshot> {
    const { origin } = await requireDeployment()
    const { object } = await client.getObject({ objectId, include: { content: true }, signal: signal() })
    const tag = parseStructTag(object.type)
    if (normalizeSuiAddress(tag.address) !== origin || tag.module !== moduleName || tag.name !== "Payment" || tag.typeParams.length !== 1 || typeof tag.typeParams[0] !== "object" || object.owner.$kind !== "Shared") throw new Error(t("payments.errNotSharedPayment"))
    try {
      return await createFinanceReader(client, { packageId, paymentsTypeOrigin: origin }).readPayment(objectId, { signal: signal() })
    } catch (error) {
      // Keep the UI's established balance regression meaning while delegating
      // canonical BCS parsing and payment invariants to the shared SDK.
      if (error instanceof Error && error.message.includes("金额不守恒")) throw error
      throw error
    }
  }

  async function listPayments(owner: string, scope = ZERO_SCOPE) {
    const { origin } = await requireDeployment()
    const caps = new Map<string, string>()
    let cursor: string | null = null
    for (let pageCount = 0; ; pageCount++) {
      if (pageCount >= 20) throw new Error(t("payments.errCapReadLimit"))
      const page: SuiClientTypes.ListOwnedObjectsResponse<{ content: true }> = await client.listOwnedObjects({ owner, type: `${origin}::${moduleName}::PaymentCap`, include: { content: true }, cursor, limit: 50, signal: signal() })
      for (const object of page.objects) {
        if (normalizeStructTag(object.type) !== `${origin}::${moduleName}::PaymentCap`) throw new Error(t("payments.errCapTypeMismatch"))
        const cap = PaymentCapBcs.parse(object.content)
        caps.set(cap.payment_id, cap.id)
      }
      if (!page.hasNextPage) break
      if (!page.cursor || cursor === page.cursor) throw new Error(t("payments.errCapPaginationStalled"))
      cursor = page.cursor
    }
    const discovered = new Set(caps.keys())
    // Confirmed receipts recover creations even before event/owned-object indexes catch up.
    for (const receipt of listTransactionReceipts()) {
      if (receipt.status === "success" && receipt.network === "testnet" && receipt.account.address === normalizeSuiAddress(owner) && receipt.scope === `${normalizeSuiAddress(scope)}:${packageId}` && ["create-recurring", "create-stream"].includes(receipt.action)) {
        for (const objectId of receipt.createdObjects) discovered.add(objectId)
      }
    }
    let before: string | null = null
    let truncated = false
    for (let pageCount = 0; pageCount < 20; pageCount++) {
      const page = await client.listEvents({ filter: { eventType: `${origin}::${moduleName}` }, order: "descending", before, limit: 50, signal: signal() })
      for (const event of page.events) {
        const tag = parseStructTag(event.eventType)
        if (normalizeSuiAddress(tag.address) !== origin || tag.module !== moduleName || tag.name !== "PaymentCreated") continue
        const created = PaymentCreatedBcs.parse(event.bcs)
        if (created.scope === normalizeSuiAddress(scope) && (normalizeSuiAddress(event.sender) === normalizeSuiAddress(owner) || created.recipient === normalizeSuiAddress(owner))) discovered.add(created.payment_id)
      }
      if (!page.hasNextPage) break
      if (!page.endCursor || before === page.endCursor) throw new Error(t("payments.errEventPaginationStalled"))
      before = page.endCursor
      if (pageCount === 19) truncated = true
    }
    const payments: PaymentSnapshot[] = []
    const errors: string[] = []
    for (const id of discovered) {
      try {
        const payment = await readPayment(id)
        if (payment.scope === normalizeSuiAddress(scope)) payments.push({ ...payment, capId: caps.get(id) })
      } catch (error) { errors.push(`${id}: ${error instanceof Error ? error.message : t("payments.errReadFailed")}`) }
    }
    return { payments, truncated, errors }
  }
  return { requireDeployment, readPayment, listPayments }
}

export const scheduledPaymentsReader = createScheduledPaymentsReader(proposalClient)

export function buildCreatePayment(input: NewRecurringPayment | NewStreamPayment, packageId = PAYMENTS_PACKAGE_ID): Transaction {
  try {
    return sdkBuildCreatePayment(input, packageId) as unknown as Transaction
  } catch (error) {
    // Preserve the frontend's historical validation wording for callers and
    // tests while the SDK owns the actual PTB and arithmetic implementation.
    if (error instanceof Error && error.message === "付款名称超过 256 字节。") throw new Error(t("payments.errInvalidPaymentFields"))
    throw error
  }
}

export function buildPaymentAction(payment: PaymentSnapshot, action: PaymentAction, funding?: bigint, packageId = PAYMENTS_PACKAGE_ID): Transaction {
  return sdkBuildPaymentAction(payment, action, funding, packageId) as unknown as Transaction
}
