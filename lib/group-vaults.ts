import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils"
import {
  AgentVaultBcs, MasterCapBcs, OrganizationTreasuryBcs, TransferBindingBcs,
  TreasuryCreatedBcs, parseFinanceBcs,
  buildCreateOrganizationTreasury, buildCreateTreasuryTransfer as sdkBuildCreateTreasuryTransfer,
  buildExecuteTreasuryTransfer, buildDepositAgentVault,
} from "multisig/agent-vault/finance"
import { AGENT_VAULT_PACKAGE_ID } from "multisig/agent-vault/org"
import { OrganizationContent, ProposalContent, proposalClient } from "./proposal-chain"
import { t } from "@/lib/i18n/t"

const PROPOSAL_PACKAGE_ID = process.env.NEXT_PUBLIC_PROPOSAL_PACKAGE_ID || AGENT_VAULT_PACKAGE_ID
const PROPOSAL_TYPE_ORIGIN = AGENT_VAULT_PACKAGE_ID

const signal = () => AbortSignal.timeout(20_000)
const framework = (name: string) => normalizeStructTag(`0x2::${name}`)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const message = (cause: unknown) => cause instanceof Error ? cause.message : t("groups.chainReadFailed")
const abiError = (detail: string) => new Error(t("groups.vaultAbiIncompatible", { detail }))
const MAX_U64 = (1n << 64n) - 1n

/** A public-key address can be reused by multiple organizations; it is not an org registry. */
export const GROUP_VAULT_AUTHORITY_CONSTRAINTS = t("groups.authorityConstraints")
export interface GroupVaultConfig {
  packageId?: string; typeOrigin?: string; organizationTypeOrigin?: string; treasuryPackageId?: string; treasuryTypeOrigin?: string; maxPages?: number; pageSize?: number
}
export interface GroupVaultDeployment { packageId: string; typeOrigin: string; organizationTypeOrigin: string }
export interface GroupVaultOrganization { id: string; groupAddress: string; epoch: bigint; thresholdWeight: bigint }
export interface GroupVaultRow {
  id: string; orgId: string; coinType: string; balance: bigint; masterCapId: string | null
  paused: boolean; vaultVersion: bigint; totalSubagents: bigint; vaultOwnerAddress: string | null; treasuryId?: string
  authority: { verified: boolean; status: "org-key-owned" | "organization-treasury" | "unverified"; ownerAddress: string | null; reason: string }
}
export interface GroupVaultList {
  vaults: GroupVaultRow[]; groupAddress: string; errors: { id: string; error: string }[]; truncated: boolean; discoveryError?: string; treasuryDeploymentError?: string
}
type GetPackage = SuiGrpcClient["movePackageService"]["getPackage"]
type Package = NonNullable<Awaited<ReturnType<GetPackage>>["response"]["package"]>
type Datatype = Package["modules"][number]["datatypes"][number]
type Body = NonNullable<Datatype["fields"][number]["type"]>
export type GroupVaultClient = Pick<SuiGrpcClient, "getObject" | "listOwnedObjects" | "listEvents"> & {
  movePackageService: { getPackage: (...args: Parameters<GetPackage>) => PromiseLike<Pick<Awaited<ReturnType<GetPackage>>, "response">> }
}
export const groupVaultBcs = AgentVaultBcs
export const masterCapBcs = MasterCapBcs
export const vaultCreatedBcs = bcs.struct("VaultCreatedEvent", { vault_id: bcs.Address, initial_version: bcs.u64() })
export const organizationTreasuryBcs = OrganizationTreasuryBcs
export const treasuryCreatedBcs = TreasuryCreatedBcs
export const treasuryBindingBcs = TransferBindingBcs
export interface TreasuryTransferInput { title: string; recipient: string; amount: bigint; deadlineMs: bigint }
export interface TreasuryTransfer { proposalId: string; bindingId: string; treasuryId: string; vaultId: string }

function objectId(value: string): string {
  if (!/^0x[\da-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) throw new Error(t("groups.invalidObjectOrAddress"))
  return normalizeSuiAddress(value)
}
function coinTag(value: string): string {
  const tag = parseStructTag(value)
  objectId(tag.address)
  if (!/^[A-Za-z_][\w]*$/.test(tag.module) || !/^[A-Za-z_][\w]*$/.test(tag.name)) throw new Error(t("groups.invalidCoinType"))
  return normalizeStructTag(tag)
}
function parseExact<Output, Input>(codec: { parse(bytes: Uint8Array): Output; serialize(value: Input): { toBytes(): Uint8Array } }, bytes: Uint8Array): Output {
  try {
    return parseFinanceBcs(codec, bytes)
  } catch (error) {
    // 协议前缀：上游 SDK 永远抛中文错误，这里保持中文字面量做前缀匹配，只翻译包装层。
    if (error instanceof Error && error.message.startsWith("财务对象 BCS")) throw new Error(t("groups.vaultErrorPrefix", { detail: error.message.slice("财务对象 ".length) }))
    throw error
  }
}
function bodySignature(body: Body): string {
  const primitives = ["unknown", "address", "bool", "u8", "u16", "u32", "u64", "u128", "u256"]
  const args = body.typeParameterInstantiation
  if (body.type !== undefined && body.type >= 1 && body.type <= 8 && !args.length) return primitives[body.type]
  if (body.type === 9 && args.length === 1) return `vector<${bodySignature(args[0])}>`
  if (body.type === 10 && body.typeName) return normalizeStructTag(body.typeName) + (args.length ? `<${args.map(bodySignature).join(",")}>` : "")
  if (body.type === 11 && body.typeParameter !== undefined && !args.length) return `$${body.typeParameter}`
  throw abiError(t("groups.unknownTypeSignature"))
}

export function createGroupVaultReader(client: GroupVaultClient, config: GroupVaultConfig = {}) {
  const packageId = objectId(config.packageId || PROPOSAL_PACKAGE_ID)
  const expectedOrigin = config.typeOrigin || (packageId === objectId(PROPOSAL_PACKAGE_ID) ? PROPOSAL_TYPE_ORIGIN : undefined)
  const expectedOrgOrigin = config.organizationTypeOrigin || expectedOrigin
  const maxPages = config.maxPages ?? 8, pageSize = config.pageSize ?? 50
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error(t("groups.invalidVaultPaging"))
  const maxCandidates = maxPages * pageSize
  let deployment: Promise<GroupVaultDeployment> | undefined
  let treasuryDeployment: Promise<{ packageId: string; typeOrigin: string; proposalTypeOrigin: string }> | undefined
  const treasuryPackageId = objectId(config.treasuryPackageId || process.env.NEXT_PUBLIC_ORGANIZATION_TREASURY_PACKAGE_ID || packageId)

  async function requireDeployment(): Promise<GroupVaultDeployment> {
    if (!deployment) deployment = (async () => {
      const { response } = await client.movePackageService.getPackage({ packageId }, { abort: signal() })
      const pkg = response.package
      if (!pkg?.storageId || objectId(pkg.storageId) !== packageId) throw abiError(t("groups.abiPackageMismatch"))
      const datatype = (moduleName: string, name: string) => {
        const modules = pkg.modules.filter(candidate => candidate.name === moduleName)
        const matches = modules[0]?.datatypes.filter(type => type.name === name)
        if (modules.length !== 1 || matches?.length !== 1) throw abiError(t("groups.abiMissingUnique", { module: moduleName, name }))
        return matches[0]
      }
      const typeOrigin = objectId(datatype("vault", "AgentVault").definingId || "")
      const organizationTypeOrigin = objectId(datatype("cryptographic_org", "Organization").definingId || "")
      if ((expectedOrigin && objectId(expectedOrigin) !== typeOrigin) || (expectedOrgOrigin && objectId(expectedOrgOrigin) !== organizationTypeOrigin)) throw abiError(t("groups.abiTypeOriginMismatch"))
      const vaultType = `${typeOrigin}::vault::AgentVault`
      const capType = `${typeOrigin}::vault::MasterCap`
      const specs: Array<[string, string, string, number[], boolean, string[]]> = [
        ["vault", "AgentVault", typeOrigin, [4], true, ["id:" + framework("object::UID"), "balance:" + framework("balance::Balance") + "<$0>", "vault_version:u64", "total_subagents:u64", "paused:bool", "agents:" + framework("vec_map::VecMap") + "<address,", "max_epoch_outflow:u64", "epoch_outflow:u64", "outflow_epoch:u64", "max_agent_budget:u64"]],
        ["vault", "MasterCap", typeOrigin, [3, 4], false, ["id:" + framework("object::UID"), "vault_id:" + framework("object::ID")]],
        ["vault", "VaultCreatedEvent", typeOrigin, [1, 2], false, ["vault_id:" + framework("object::ID"), "initial_version:u64"]],
        ["cryptographic_org", "Organization", organizationTypeOrigin, [4], false, ["id:" + framework("object::UID"), "group_pk:vector<u8>", "threshold_weight:u64", "epoch_version:u64", "last_nonce:u64", "chain_id:vector<u8>", "members_weight:" + framework("table::Table") + "<address,u64>", "executed_proposals:" + framework("table::Table") + "<vector<u8>,bool>", "key_signers:vector<address>"]],
      ]
      for (const [moduleName, name, origin, abilities, generic, fields] of specs) {
        const type = datatype(moduleName, name)
        const labels = [`${origin}::${moduleName}::${name}`, `${packageId}::${moduleName}::${name}`]
        if (!type.typeName || !labels.includes(normalizeStructTag(type.typeName)) || type.module !== moduleName || objectId(type.definingId || "") !== origin) throw abiError(t("groups.abiTypeIdentities"))
        const origins = pkg.typeOrigins.filter(entry => entry.moduleName === moduleName && entry.datatypeName === name)
        // Some gRPC servers omit the origin table; definingId still supplies the original type identity.
        if (pkg.typeOrigins.length && (origins.length !== 1 || objectId(origins[0].packageId || "") !== origin)) throw abiError(t("groups.abiTypeOriginTable"))
        if (type.kind !== 1 || type.variants.length || !same([...type.abilities].sort(), abilities) || type.typeParameters.length !== (generic ? 1 : 0) || (generic && (!type.typeParameters[0].isPhantom || type.typeParameters[0].constraints.length))) throw abiError(t("groups.abiAbilitiesOrGenerics"))
        const layoutOk = (field: Datatype['fields'][number] | undefined, index: number): boolean => !!field?.type && field.position === index
          && ((name === "AgentVault" && field.name === "agents")
            ? `${field.name}:${bodySignature(field.type)}`.startsWith(fields[index])
            : `${field.name}:${bodySignature(field.type)}` === fields[index])
        if (type.fields.length !== fields.length || type.fields.some((field, index) => !layoutOk(field, index))) throw abiError(t("groups.abiFieldLayout", { name }))
      }
      const expectedFunctions: Record<string, string[]> = {
        deposit: [`&mut ${vaultType}<$0>`, framework("coin::Coin") + "<$0>"],
        withdraw: [`&${capType}`, `&mut ${vaultType}<$0>`, "u64", "address", "&mut " + framework("tx_context::TxContext")],
      }
      const functions = pkg.modules.find(candidate => candidate.name === "vault")!.functions
      for (const [name, parameters] of Object.entries(expectedFunctions)) {
        const matches = functions.filter(fn => fn.name === name)
        const fn = matches[0]
        const signature = (parameter: typeof fn.parameters[number]) => {
          if (!parameter.body || (parameter.reference !== undefined && ![0, 1, 2].includes(parameter.reference))) throw abiError(t("groups.abiFunctionParameters"))
          return `${parameter.reference === 2 ? "&mut " : parameter.reference === 1 ? "&" : ""}${bodySignature(parameter.body)}`
        }
        if (matches.length !== 1 || fn.visibility !== 2 || (fn.isEntry ?? false) || fn.typeParameters.length !== 1 || fn.typeParameters[0].constraints.length || fn.typeParameters[0].isPhantom === true || fn.returns.length || !same(fn.parameters.map(signature), parameters)) throw abiError(t("groups.abiFunction", { name }))
      }
      return { packageId, typeOrigin, organizationTypeOrigin }
    })().catch(cause => { deployment = undefined; throw cause })
    return deployment
  }

  async function requireTreasuryDeployment() {
    if (!treasuryDeployment) treasuryDeployment = (async () => {
      const d = await requireDeployment()
      const { response } = await client.movePackageService.getPackage({ packageId: treasuryPackageId }, { abort: signal() })
      const pkg = response.package
      if (!pkg?.storageId || objectId(pkg.storageId) !== treasuryPackageId) throw abiError(t("groups.abiTreasuryPackage"))
      const modules = pkg.modules.filter(candidate => candidate.name === "organization_treasury")
      if (!modules.length) throw new Error(t("groups.treasuryModuleMissing"))
      if (modules.length !== 1) throw abiError(t("groups.abiDuplicateTreasuryModule"))
      const moduleDef = modules[0]
      const types = moduleDef.datatypes
      const own = types.find(type => type.name === "OrganizationTreasury")
      if (!own?.definingId) throw abiError(t("groups.abiMissingTreasuryType"))
      const typeOrigin = objectId(own.definingId)
      if (config.treasuryTypeOrigin && objectId(config.treasuryTypeOrigin) !== typeOrigin) throw abiError(t("groups.abiTreasuryOrigin"))
      const local = (name: string) => `${typeOrigin}::organization_treasury::${name}`
      const layouts: Record<string, string[]> = {
        OrganizationTreasury: ["id:" + framework("object::UID"), "org_id:" + framework("object::ID"), "vault_id:" + framework("object::ID"), `master_cap:${d.typeOrigin}::vault::MasterCap`],
        TransferBinding: ["id:" + framework("object::UID"), "treasury_id:" + framework("object::ID"), "proposal_id:" + framework("object::ID")],
        TreasuryCreated: ["treasury_id:" + framework("object::ID"), "org_id:" + framework("object::ID"), "vault_id:" + framework("object::ID")],
        TransferCreated: ["binding_id:" + framework("object::ID"), "treasury_id:" + framework("object::ID"), "proposal_id:" + framework("object::ID")],
      }
      if (types.length !== 4 || new Set(types.map(type => type.name)).size !== 4) throw abiError(t("groups.abiTreasuryTypeSet"))
      for (const type of types) {
        const fields = type.name && layouts[type.name]
        if (!fields || type.module !== "organization_treasury" || objectId(type.definingId || "") !== typeOrigin || !type.typeName || ![local(type.name!), `${treasuryPackageId}::organization_treasury::${type.name}`].includes(normalizeStructTag(type.typeName))) throw abiError(t("groups.abiTreasuryTypeOrigin"))
        const origins = pkg.typeOrigins.filter(entry => entry.moduleName === "organization_treasury" && entry.datatypeName === type.name)
        if (pkg.typeOrigins.length && (origins.length !== 1 || objectId(origins[0].packageId || "") !== typeOrigin)) throw abiError(t("groups.abiTreasuryOriginTable"))
        const abilities = ["OrganizationTreasury", "TransferBinding"].includes(type.name!) ? [4] : [1, 2]
        if (type.kind !== 1 || type.variants.length || type.typeParameters.length || !same([...type.abilities].sort(), abilities) || type.fields.length !== fields.length || type.fields.some((field, index) => !field.type || field.position !== index || `${field.name}:${bodySignature(field.type)}` !== fields[index])) throw abiError(t("groups.abiTreasuryFields"))
      }
      const proposals = pkg.modules.filter(candidate => candidate.name === "asynchronous_proposal").flatMap(candidate => candidate.datatypes.filter(type => type.name === "Proposal"))
      const proposal = proposals[0]
      if (proposals.length !== 1 || !proposal.definingId || !proposal.typeName || ![`${objectId(proposal.definingId)}::asynchronous_proposal::Proposal`, `${treasuryPackageId}::asynchronous_proposal::Proposal`].includes(normalizeStructTag(proposal.typeName))) throw abiError(t("groups.abiTreasuryProposalOrigin"))
      const proposalTypeOrigin = objectId(proposal.definingId)
      const proposalFields = ["id:" + framework("object::UID"), "org_id:" + framework("object::ID"), "epoch:u64", "proposer:address", "title:vector<u8>", "recipient:address", "amount:u64", "threshold_weight:u64", "accumulated_weight:u64", "voters:" + framework("table::Table") + "<address,u64>", "partial_signatures:" + framework("table::Table") + "<address,vector<u8>>", "deadline_ms:u64", "status:u8"]
      if (proposal.kind !== 1 || proposal.variants.length || proposal.typeParameters.length || !same(proposal.abilities, [4]) || proposal.fields.length !== proposalFields.length || proposal.fields.some((field, index) => !field.type || field.position !== index || `${field.name}:${bodySignature(field.type)}` !== proposalFields[index])) throw abiError(t("groups.abiTreasuryProposalFields"))
      const org = `&${d.organizationTypeOrigin}::cryptographic_org::Organization`, treasury = local("OrganizationTreasury")
      const ctx = "&mut " + framework("tx_context::TxContext")
      const expected: Record<string, { parameters: string[]; returns: string[] }> = {
        new: { parameters: [org, ctx], returns: [treasury] },
        share: { parameters: [treasury], returns: [] },
        create_transfer: { parameters: [`&${treasury}`, org, "vector<u8>", "address", "u64", "u64", "&" + framework("clock::Clock"), ctx], returns: [framework("object::ID")] },
        execute: { parameters: [`&${treasury}`, "&" + local("TransferBinding"), org, `&mut ${proposalTypeOrigin}::asynchronous_proposal::Proposal`, `&mut ${d.typeOrigin}::vault::AgentVault<${framework("sui::SUI")}>`, "&" + framework("clock::Clock"), ctx], returns: [] },
      }
      const callable = moduleDef.functions.filter(fn => fn.visibility !== 1 || fn.isEntry)
      if (callable.length !== 4 || new Set(callable.map(fn => fn.name)).size !== 4) throw abiError(t("groups.abiTreasuryCallableSet"))
      for (const fn of callable) {
        const schema = fn.name && expected[fn.name]
        const signature = (parameter: typeof fn.parameters[number]) => {
          if (!parameter.body || (parameter.reference !== undefined && ![0, 1, 2].includes(parameter.reference))) throw abiError(t("groups.abiTreasuryFnParameters"))
          return `${parameter.reference === 2 ? "&mut " : parameter.reference === 1 ? "&" : ""}${bodySignature(parameter.body)}`
        }
        if (!schema || fn.visibility !== 2 || (fn.isEntry ?? false) || fn.typeParameters.length || !same(fn.parameters.map(signature), schema.parameters) || !same(fn.returns.map(signature), schema.returns)) throw abiError(t("groups.abiTreasuryFunction", { name: fn.name ?? "" }))
      }
      return { packageId: treasuryPackageId, typeOrigin, proposalTypeOrigin }
    })().catch(cause => { treasuryDeployment = undefined; throw cause })
    return treasuryDeployment
  }

  async function readOrganization(orgId: string): Promise<GroupVaultOrganization> {
    const id = objectId(orgId), d = await requireDeployment()
    const { object } = await client.getObject({ objectId: id, include: { content: true }, signal: signal() })
    if (objectId(object.objectId) !== id || normalizeStructTag(object.type) !== `${d.organizationTypeOrigin}::cryptographic_org::Organization` || object.owner.$kind !== "Shared") throw new Error(t("groups.notSharedOrg"))
    const org = parseExact(OrganizationContent, object.content)
    if (org.id !== id || org.group_pk.length !== 32 || BigInt(org.threshold_weight) <= 0n) throw new Error(t("groups.invalidOrgIdentity"))
    objectId(org.members_weight.id); objectId(org.executed_proposals.id)
    const groupAddress = new Ed25519PublicKey(Uint8Array.from(org.group_pk)).toSuiAddress()
    return { id, groupAddress, epoch: BigInt(org.epoch_version), thresholdWeight: BigInt(org.threshold_weight) }
  }

  async function readVaultObject(vaultId: string, d: GroupVaultDeployment) {
    const id = objectId(vaultId)
    const { object } = await client.getObject({ objectId: id, include: { content: true }, signal: signal() })
    const tag = parseStructTag(object.type)
    if (objectId(object.objectId) !== id || normalizeSuiAddress(tag.address) !== d.typeOrigin || tag.module !== "vault" || tag.name !== "AgentVault" || tag.typeParams.length !== 1 || typeof tag.typeParams[0] !== "object" || !["Shared", "AddressOwner"].includes(object.owner.$kind)) throw new Error(t("groups.notPrimitiveVault"))
    const coinType = coinTag(normalizeStructTag(tag.typeParams[0]))
    const expectedType = `${d.typeOrigin}::vault::AgentVault<${coinType}>`
    if (normalizeStructTag(object.type) !== expectedType) throw new Error(t("groups.vaultTypeMismatch"))
    const vault = parseExact(groupVaultBcs, object.content)
    if (vault.id !== id || BigInt(vault.vault_version) < 1n) throw new Error(t("groups.vaultIdOrVersionMismatch"))
    const vaultOwnerAddress = object.owner.$kind === "AddressOwner" ? objectId(object.owner.AddressOwner) : null
    return { id, coinType, balance: BigInt(vault.balance), paused: vault.paused, vaultVersion: BigInt(vault.vault_version), totalSubagents: BigInt(vault.total_subagents), vaultOwnerAddress }
  }

  async function readCaps(org: GroupVaultOrganization, d: GroupVaultDeployment) {
    const caps = new Map<string, string>(), errors: GroupVaultList["errors"] = []
    const capType = `${d.typeOrigin}::vault::MasterCap`
    const seen = new Set<string>(), cursors = new Set<string>()
    let cursor: string | null = null, truncated = false
    const parseCap = (object: SuiClientTypes.Object<{ content: true }>, expectedId: string) => {
      if (objectId(object.objectId) !== expectedId || normalizeStructTag(object.type) !== capType || object.owner.$kind !== "AddressOwner" || objectId(object.owner.AddressOwner) !== org.groupAddress) throw new Error(t("groups.masterCapCustodyMismatch"))
      const cap = parseExact(masterCapBcs, object.content)
      if (cap.id !== expectedId) throw new Error(t("groups.masterCapBcsMismatch"))
      objectId(cap.vault_id)
      return cap
    }
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      try {
        const page: SuiClientTypes.ListOwnedObjectsResponse<{ content: true }> = await client.listOwnedObjects({ owner: org.groupAddress, type: capType, include: { content: true }, cursor, limit: pageSize, signal: signal() })
        if (page.objects.length > pageSize) throw new Error(t("groups.masterCapPagingLimit"))
        for (const object of page.objects) {
          try {
            const id = objectId(object.objectId)
            if (seen.has(id)) continue
            seen.add(id)
            parseCap(object, id)
            // Owned-object indexes may lag a transfer. Verify present custody using the object endpoint.
            const { object: current } = await client.getObject({ objectId: id, include: { content: true }, signal: signal() })
            const cap = parseCap(current, id)
            if (caps.has(cap.vault_id)) throw new Error(t("groups.duplicateMasterCap"))
            caps.set(cap.vault_id, cap.id)
          } catch (cause) { errors.push({ id: object.objectId, error: message(cause) }) }
        }
        truncated = page.hasNextPage
        if (!page.hasNextPage) break
        if (!page.cursor || cursors.has(page.cursor)) throw new Error(t("groups.masterCapPagingStuck"))
        cursors.add(page.cursor); cursor = page.cursor
      } catch (cause) { errors.push({ id: org.groupAddress, error: message(cause) }); truncated = true; break }
    }
    return { caps, errors, truncated }
  }

  function row(vault: Awaited<ReturnType<typeof readVaultObject>>, org: GroupVaultOrganization, capId?: string): GroupVaultRow {
    const verified = !!capId && (!vault.vaultOwnerAddress || vault.vaultOwnerAddress === org.groupAddress)
    return { ...vault, orgId: org.id, masterCapId: capId || null, authority: {
      verified, status: verified ? "org-key-owned" : "unverified", ownerAddress: capId ? org.groupAddress : null,
      reason: verified ? t("groups.masterCapHeldReason") : t("groups.masterCapUnverifiedReason"),
    } }
  }

  async function sharedObject(id: string, type: string) {
    const { object } = await client.getObject({ objectId: id, include: { content: true }, signal: signal() })
    if (objectId(object.objectId) !== id || normalizeStructTag(object.type) !== type || object.owner.$kind !== "Shared") throw new Error(t("groups.notSharedTreasuryOrProposal"))
    return object
  }

  async function readTreasury(treasuryId: string, orgId: string): Promise<GroupVaultRow> {
    const id = objectId(treasuryId), org = await readOrganization(orgId)
    const [d, dep] = await Promise.all([requireDeployment(), requireTreasuryDeployment()])
    const object = await sharedObject(id, `${dep.typeOrigin}::organization_treasury::OrganizationTreasury`)
    const treasury = parseExact(organizationTreasuryBcs, object.content)
    if (treasury.id !== id || treasury.org_id !== org.id || treasury.vault_id !== treasury.master_cap.vault_id) throw new Error(t("groups.treasuryLinkMismatch"))
    objectId(treasury.master_cap.id)
    if (new Set([id, org.id, treasury.vault_id, treasury.master_cap.id]).size !== 4) throw new Error(t("groups.treasuryDuplicateIds"))
    const vault = await readVaultObject(treasury.vault_id, d)
    if (vault.coinType !== framework("sui::SUI") || vault.vaultOwnerAddress) throw new Error(t("groups.treasuryRequiresNativeSui"))
    return { ...vault, orgId: org.id, treasuryId: id, masterCapId: treasury.master_cap.id, authority: {
      verified: true, status: "organization-treasury", ownerAddress: null,
      reason: t("groups.masterCapSealedReason"),
    } }
  }

  async function discoverTreasuries(orgId: string) {
    let dep: Awaited<ReturnType<typeof requireTreasuryDeployment>>
    try { dep = await requireTreasuryDeployment() }
    catch (cause) { return { vaults: [] as GroupVaultRow[], errors: [] as GroupVaultList["errors"], truncated: false, treasuryDeploymentError: message(cause) } }
    const vaults: GroupVaultRow[] = [], errors: GroupVaultList["errors"] = []
    const ids = new Set<string>(), cursors = new Set<string>()
    const eventType = `${dep.typeOrigin}::organization_treasury::TreasuryCreated`
    let before: string | null = null, truncated = false
    try {
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        const page: SuiClientTypes.ListEventsResponse = await client.listEvents({ filter: { eventType }, order: "descending", before, limit: pageSize, signal: signal() })
        if (page.events.length > pageSize) throw new Error(t("groups.treasuryEventsPagingLimit"))
        for (const event of page.events) {
          if (normalizeStructTag(event.eventType) !== eventType) throw new Error(t("groups.treasuryEventTypeMismatch"))
          const created = parseExact(treasuryCreatedBcs, event.bcs)
          objectId(created.treasury_id); objectId(created.org_id); objectId(created.vault_id)
          if (created.org_id !== orgId || ids.has(created.treasury_id)) continue
          ids.add(created.treasury_id)
          try {
            const row = await readTreasury(created.treasury_id, orgId)
            if (row.id !== created.vault_id) throw new Error(t("groups.treasuryEventVaultMismatch"))
            vaults.push(row)
          } catch (cause) { errors.push({ id: created.treasury_id, error: message(cause) }) }
        }
        truncated = page.hasNextPage
        if (!page.hasNextPage) break
        if (!page.endCursor || cursors.has(page.endCursor)) throw new Error(t("groups.treasuryEventsPagingStuck"))
        cursors.add(page.endCursor); before = page.endCursor
      }
    } catch (cause) { errors.push({ id: orgId, error: message(cause) }); truncated = true }
    return { vaults, errors, truncated, treasuryDeploymentError: undefined }
  }

  async function readBoundTransfer(bindingId: string, treasury: GroupVaultRow): Promise<TreasuryTransfer & { proposal: ReturnType<typeof ProposalContent.parse> }> {
    const id = objectId(bindingId), dep = await requireTreasuryDeployment()
    const binding = parseExact(treasuryBindingBcs, (await sharedObject(id, `${dep.typeOrigin}::organization_treasury::TransferBinding`)).content)
    if (binding.id !== id || binding.treasury_id !== treasury.treasuryId) throw new Error(t("groups.bindingNotOfTreasury"))
    const proposalId = objectId(binding.proposal_id)
    const proposal = parseExact(ProposalContent, (await sharedObject(proposalId, `${dep.proposalTypeOrigin}::asynchronous_proposal::Proposal`)).content)
    if (proposal.id !== proposalId || proposal.org_id !== treasury.orgId || ![1, 2, 3].includes(proposal.status) || BigInt(proposal.threshold_weight) <= 0n) throw new Error(t("groups.proposalOrgStatusMismatch"))
    return { bindingId: id, proposalId, treasuryId: treasury.treasuryId!, vaultId: treasury.id, proposal }
  }

  async function createdCandidateIds(ids: string[], expectedType: string): Promise<string[]> {
    if (ids.length > maxCandidates) throw new Error(t("groups.createdObjectsOverLimit"))
    const matches: string[] = []
    for (const rawId of new Set(ids)) {
      const id = objectId(rawId)
      const { object } = await client.getObject({ objectId: id, include: { content: true }, signal: signal() })
      if (objectId(object.objectId) !== id) throw new Error(t("groups.createdObjectIdMismatch"))
      if (normalizeStructTag(object.type) === expectedType) matches.push(id)
    }
    return matches
  }

  async function findCreatedTreasury(createdObjects: string[], orgId: string): Promise<GroupVaultRow> {
    const dep = await requireTreasuryDeployment()
    const ids = await createdCandidateIds(createdObjects, `${dep.typeOrigin}::organization_treasury::OrganizationTreasury`)
    if (ids.length !== 1) throw new Error(t("groups.noUniqueTreasuryInTx"))
    return readTreasury(ids[0], orgId)
  }

  async function findCreatedTransfer(createdObjects: string[], treasuryId: string, orgId: string): Promise<TreasuryTransfer> {
    const treasury = await readTreasury(treasuryId, orgId), dep = await requireTreasuryDeployment()
    const ids = await createdCandidateIds(createdObjects, `${dep.typeOrigin}::organization_treasury::TransferBinding`)
    if (ids.length !== 1) throw new Error(t("groups.noUniqueBindingInTx"))
    const { proposal: _proposal, ...transfer } = await readBoundTransfer(ids[0], treasury)
    if (!createdObjects.map(objectId).includes(transfer.proposalId)) throw new Error(t("groups.missingBoundProposal"))
    return transfer
  }

  async function discoverTreasuryTransfer(proposalId: string, orgId: string): Promise<TreasuryTransfer | null> {
    const id = objectId(proposalId), org = objectId(orgId), dep = await requireTreasuryDeployment()
    const eventType = `${dep.typeOrigin}::organization_treasury::TransferCreated`
    const codec = bcs.struct("TransferCreated", { binding_id: bcs.Address, treasury_id: bcs.Address, proposal_id: bcs.Address })
    const cursors = new Set<string>()
    let before: string | null = null
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page: SuiClientTypes.ListEventsResponse = await client.listEvents({ filter: { eventType }, order: "descending", before, limit: pageSize, signal: signal() })
      if (page.events.length > pageSize) throw new Error(t("groups.transferEventsPagingLimit"))
      for (const event of page.events) {
        if (normalizeStructTag(event.eventType) !== eventType) throw new Error(t("groups.transferEventTypeMismatch"))
        const created = parseExact(codec, event.bcs)
        if (created.proposal_id === id) return findCreatedTransfer([id, created.binding_id], created.treasury_id, org)
      }
      if (!page.hasNextPage) return null
      if (!page.endCursor || cursors.has(page.endCursor)) throw new Error(t("groups.transferEventsPagingStuck"))
      cursors.add(page.endCursor); before = page.endCursor
    }
    throw new Error(t("groups.transferHistoryOverLimit"))
  }

  async function buildCreateTreasury(sender: string, orgId: string): Promise<Transaction> {
    const account = objectId(sender), org = await readOrganization(orgId), dep = await requireTreasuryDeployment()
    // The linked SDK resolves its own @mysten/sui instance, so it builds the PTB
    // itself; only the returned transaction crosses the package boundary.
    const tx = buildCreateOrganizationTreasury({ packageId: dep.packageId, orgId: org.id }) as unknown as Transaction
    tx.setSender(account)
    return tx
  }

  async function buildCreateTreasuryTransfer(sender: string, treasuryId: string, orgId: string, input: TreasuryTransferInput): Promise<Transaction> {
    const account = objectId(sender), recipient = objectId(input.recipient)
    const now = BigInt(Date.now())
    if (!input.title.length || new TextEncoder().encode(input.title).length > 256 || typeof input.amount !== "bigint" || input.amount <= 0n || input.amount > MAX_U64 || typeof input.deadlineMs !== "bigint" || input.deadlineMs <= now || input.deadlineMs > MAX_U64 || input.deadlineMs - now > 31_536_000_000n) throw new Error(t("groups.invalidProposalInput"))
    const treasury = await readTreasury(treasuryId, orgId), dep = await requireTreasuryDeployment()
    const tx = sdkBuildCreateTreasuryTransfer({ packageId: dep.packageId, treasuryId: treasury.treasuryId!, orgId: treasury.orgId, recipient, title: input.title, amount: input.amount, deadlineMs: input.deadlineMs, nowMs: now }) as unknown as Transaction
    tx.setSender(account)
    return tx
  }

  async function buildExecuteTreasury(sender: string, treasuryId: string, orgId: string, proposalId: string, bindingId: string, threshold?: { nonce: bigint; frostSignature: Uint8Array }): Promise<Transaction> {
    const account = objectId(sender), id = objectId(proposalId)
    const treasury = await readTreasury(treasuryId, orgId), transfer = await readBoundTransfer(bindingId, treasury)
    const org = await readOrganization(orgId), proposal = transfer.proposal
    if (transfer.proposalId !== id) throw new Error(t("groups.bindingProposalMismatch"))
    if (proposal.status !== 1 || BigInt(proposal.epoch) !== org.epoch || BigInt(proposal.accumulated_weight) < BigInt(proposal.threshold_weight) || BigInt(proposal.deadline_ms) < BigInt(Date.now()) || BigInt(proposal.amount) <= 0n || BigInt(proposal.amount) > treasury.balance) throw new Error(t("groups.proposalNotExecutable"))
    if (!threshold || typeof threshold.nonce !== "bigint" || !(threshold.frostSignature instanceof Uint8Array)) throw new Error("执行 treasury 转出需要门限签名（nonce + FROST 签名），请先完成签名会话")
    const dep = await requireTreasuryDeployment()
    const tx = buildExecuteTreasuryTransfer({ packageId: dep.packageId, treasuryId: treasury.treasuryId!, bindingId: transfer.bindingId, orgId: treasury.orgId, proposalId: id, vaultId: treasury.id, nonce: threshold.nonce, frostSignature: threshold.frostSignature }) as unknown as Transaction
    tx.setSender(account)
    return tx
  }

  async function readVault(vaultId: string, orgId: string): Promise<GroupVaultRow> {
    const id = objectId(vaultId), org = await readOrganization(orgId), d = await requireDeployment()
    const [vault, custody] = await Promise.all([readVaultObject(id, d), readCaps(org, d)])
    const legacy = row(vault, org, custody.caps.get(id))
    if (legacy.authority.verified) return legacy
    const treasuries = await discoverTreasuries(org.id)
    const treasury = treasuries.vaults.find(row => row.id === id)
    if (treasury) return treasury
    if (custody.errors.length || treasuries.errors.length) throw new Error([...custody.errors, ...treasuries.errors].map(error => error.error).join(" "))
    if (custody.truncated || treasuries.truncated) throw new Error(t("groups.vaultPermissionsTruncated"))
    return legacy
  }

  async function listVaults(orgId: string, hints: string[] = []): Promise<GroupVaultList> {
    const org = await readOrganization(orgId), d = await requireDeployment()
    const [custody, treasuries] = await Promise.all([readCaps(org, d), discoverTreasuries(org.id)])
    const treasuryByVault = new Map(treasuries.vaults.map(row => [row.id, row]))
    const ids = new Set([...treasuryByVault.keys(), ...custody.caps.keys()]), hinted = new Set<string>()
    const errors = [...custody.errors, ...treasuries.errors]
    let truncated = custody.truncated || treasuries.truncated, discoveryError: string | undefined
    if (hints.length > maxCandidates) truncated = true
    for (const hint of hints.slice(0, maxCandidates)) {
      try { const id = objectId(hint); hinted.add(id); ids.add(id) }
      catch (cause) { errors.push({ id: hint, error: message(cause) }) }
    }
    const vaults: GroupVaultRow[] = []
    const candidates = [...ids]
    for (let offset = 0; offset < candidates.length; offset += 8) {
      await Promise.all(candidates.slice(offset, offset + 8).map(async id => {
        try {
          const result = treasuryByVault.get(id) || row(await readVaultObject(id, d), org, custody.caps.get(id))
          if (result.authority.verified) vaults.push(result)
          else if (hinted.has(id) || custody.caps.has(id)) errors.push({ id, error: result.authority.reason })
        } catch (cause) { errors.push({ id, error: message(cause) }) }
      }))
    }
    const order = new Map(candidates.map((id, index) => [id, index]))
    vaults.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    return { vaults, groupAddress: org.groupAddress, errors, truncated, discoveryError, treasuryDeploymentError: treasuries.treasuryDeploymentError }
  }

  async function buildDepositVault(sender: string, vaultId: string, coinType: string, units: bigint): Promise<Transaction> {
    const account = objectId(sender), id = objectId(vaultId), type = coinTag(coinType)
    if (typeof units !== "bigint" || units <= 0n || units > MAX_U64) throw new Error(t("groups.invalidDepositAmount"))
    const d = await requireDeployment(), vault = await readVaultObject(id, d)
    if (vault.coinType !== type) throw new Error(t("groups.depositTypeMismatch"))
    if (vault.vaultOwnerAddress && vault.vaultOwnerAddress !== account) throw new Error(t("groups.vaultNotAccessible"))
    const tx = buildDepositAgentVault({ packageId: d.packageId, coinType: type, vaultId: id, amount: units }) as unknown as Transaction
    tx.setSender(account)
    return tx
  }
  return { requireDeployment, requireTreasuryDeployment, readOrganization, readVault, listVaults, buildDepositVault, readTreasury, findCreatedTreasury, findCreatedTransfer, discoverTreasuryTransfer, buildCreateTreasury, buildCreateTreasuryTransfer, buildExecuteTreasury }
}

export const groupVaults = createGroupVaultReader(proposalClient)
export const buildDepositVault = groupVaults.buildDepositVault
