import { bcs } from "@mysten/sui/bcs"
import { ObjectError, type SuiClientTypes } from "@mysten/sui/client"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils"
import { t } from "./i18n/t"
import { AsyncTransferProposalBcs } from "multisig/agent-vault/finance"
import { AGENT_VAULT_PACKAGE_ID } from "multisig/agent-vault/org"

export const PROPOSAL_PACKAGE_ID = process.env.NEXT_PUBLIC_PROPOSAL_PACKAGE_ID || AGENT_VAULT_PACKAGE_ID
// 只认现行包：历史包的对象/事件不在支持范围内（需要旧行为时从 git 取当时的分支）。
export const PROPOSAL_TYPE_ORIGIN = AGENT_VAULT_PACKAGE_ID
export const PROTOCOL_MODULE_ORIGIN = AGENT_VAULT_PACKAGE_ID
export const proposalClient = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
const Table = bcs.struct("Table", { id: bcs.Address, size: bcs.u64() })
export const ProposalContent = AsyncTransferProposalBcs
export const OrganizationContent = bcs.struct("Organization", {
  id: bcs.Address, group_pk: bcs.vector(bcs.u8()), threshold_weight: bcs.u64(),
  epoch_version: bcs.u64(), last_nonce: bcs.u64(), chain_id: bcs.vector(bcs.u8()),
  members_weight: Table, executed_proposals: Table, key_signers: bcs.vector(bcs.Address),
})
const WeightField = bcs.struct("WeightField", { id: bcs.Address, name: bcs.Address, value: bcs.u64() })
const requestSignal = () => AbortSignal.timeout(20_000)

export function weightNumber(value: string): number {
  const weight = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(weight) || weight < 0) throw new Error(t("vault.weightPrecisionOutOfRange"))
  return weight
}

type GetDatatype = SuiGrpcClient["movePackageService"]["getDatatype"]
export type ProposalChainClient = Pick<SuiGrpcClient, "getObject" | "getObjects" | "getMoveFunction" | "getDynamicField"> & Pick<SuiClientTypes.TransportMethods, "listDynamicFields"> & {
  movePackageService: {
    getDatatype: (...args: Parameters<GetDatatype>) => PromiseLike<Pick<Awaited<ReturnType<GetDatatype>>, "response">>
  }
}

export function createProposalReader(client: ProposalChainClient) {
  let rejectionSupport: Promise<boolean> | undefined
  const rejectionKeyTypes = new Map<string, Promise<string>>()

  async function readWeightTable(tableId: string): Promise<Record<string, number>> {
    const weights: Record<string, number> = {}
    const cursors = new Set<string>()
    let fieldsRead = 0
    let cursor: string | null = null
    do {
      const page: SuiClientTypes.ListDynamicFieldsResponse = await client.listDynamicFields({ parentId: tableId, cursor, limit: 50, signal: requestSignal() })
      fieldsRead += page.dynamicFields.length
      if (fieldsRead > 1000) throw new Error(t("vault.weightTableTooLarge"))
      if (page.dynamicFields.length) {
        const { objects } = await client.getObjects({ objectIds: page.dynamicFields.map(field => field.fieldId), include: { content: true }, signal: requestSignal() })
        for (const object of objects) {
          if (object instanceof Error) throw object
          if (normalizeStructTag(object.type) !== normalizeStructTag("0x2::dynamic_field::Field<address,u64>")) throw new Error(t("vault.weightTableTypeMismatch"))
          const field = WeightField.parse(object.content)
          weights[normalizeSuiAddress(field.name)] = weightNumber(field.value)
        }
      }
      if (page.hasNextPage) {
        if (!page.cursor || cursors.has(page.cursor)) throw new Error(t("vault.weightTableCursorStuck"))
        cursors.add(page.cursor)
      }
      cursor = page.hasNextPage ? page.cursor : null
    } while (cursor)
    return weights
  }

  function supportsRejection(): Promise<boolean> {
    if (!rejectionSupport) rejectionSupport = client.getMoveFunction({
      packageId: PROPOSAL_PACKAGE_ID, moduleName: "asynchronous_proposal", name: "reject_async_vote", signal: requestSignal(),
    }).then(() => true).catch(error => {
      if (error instanceof Error && error.message.includes("Function not found: reject_async_vote")) return false
      rejectionSupport = undefined
      throw error
    })
    return rejectionSupport
  }

  async function rejectionKeyType(name: string): Promise<string> {
    if (!rejectionKeyTypes.has(name)) rejectionKeyTypes.set(name, Promise.resolve(client.movePackageService.getDatatype({
      packageId: PROPOSAL_PACKAGE_ID, moduleName: "asynchronous_proposal", name,
    }, { abort: requestSignal() })).then(({ response }) => {
      if (!response.datatype?.typeName) throw new Error(t("vault.rejectionTypeUnresolvable"))
      return response.datatype.typeName
    }).catch(error => { rejectionKeyTypes.delete(name); throw error }))
    return rejectionKeyTypes.get(name)!
  }

  async function readRejectionValue(parentId: string, key: string, nameBytes: Uint8Array): Promise<number> {
    const type = await rejectionKeyType(key)
    try {
      const { dynamicField } = await client.getDynamicField({ parentId, name: { type, bcs: nameBytes }, signal: requestSignal() })
      if (dynamicField.value.type !== "u64") throw new Error(t("vault.rejectionValueTypeMismatch"))
      return weightNumber(bcs.u64().parse(dynamicField.value.bcs))
    } catch (error) {
      if (error instanceof ObjectError && error.reason === "notFound") return 0
      throw error
    }
  }

  async function readProposalSnapshot(proposalId: string, expectedOrgId?: string): Promise<ProposalSnapshot> {
    const { object } = await client.getObject({ objectId: proposalId, include: { content: true, previousTransaction: true }, signal: requestSignal() })
    if (normalizeStructTag(object.type) !== `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::Proposal`) throw new Error(t("vault.notAProtocolProposal"))
    const proposal = ProposalContent.parse(object.content)
    if (expectedOrgId && normalizeSuiAddress(expectedOrgId) !== proposal.org_id) throw new Error(t("vault.proposalOrgMismatch"))
    const { object: org } = await client.getObject({ objectId: proposal.org_id, include: { content: true }, signal: requestSignal() })
    if (normalizeStructTag(org.type) !== `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`) throw new Error(t("vault.orgTypeMismatch"))
    const organization = OrganizationContent.parse(org.content)
    const [members, votes, rejectionSupported] = await Promise.all([
      readWeightTable(organization.members_weight.id), readWeightTable(proposal.voters.id), supportsRejection(),
    ])
    const rejectionWeight = rejectionSupported ? await readRejectionValue(proposal.id, "RejectedWeightKey", new Uint8Array([0])) : 0
    const rejectingVoters = rejectionSupported ? (await Promise.all(Object.keys(votes).map(async voter =>
      await readRejectionValue(proposal.id, "RejectingVoterKey", bcs.Address.serialize(voter).toBytes()) > 0 ? voter : null,
    ))).filter((voter): voter is string => voter !== null) : []
    const threshold = weightNumber(proposal.threshold_weight)
    const approvedWeight = weightNumber(proposal.accumulated_weight)
    if (threshold <= 0 || ![1, 2, 3].includes(proposal.status)) throw new Error(t("vault.proposalThresholdInvalid"))
    return {
      id: proposal.id, orgId: proposal.org_id, epoch: proposal.epoch, organizationEpoch: organization.epoch_version,
      proposer: proposal.proposer, title: new TextDecoder().decode(new Uint8Array(proposal.title)), recipient: proposal.recipient,
      amountMist: proposal.amount, threshold, approvedWeight, deadlineMs: weightNumber(proposal.deadline_ms),
      status: proposal.status === 2 ? "executed" : proposal.status === 3 ? "rejected" : approvedWeight >= threshold ? "approved" : "pending",
      members, votes, rejectionSupported, rejectionWeight, rejectingVoters, previousTransaction: object.previousTransaction,
    }
  }

  return { readWeightTable, supportsRejection, readProposalSnapshot }
}

export const { readWeightTable, supportsRejection, readProposalSnapshot } = createProposalReader(proposalClient)

export interface ProposalSnapshot {
  id: string; orgId: string; epoch: string; organizationEpoch: string; proposer: string
  title: string; recipient: string; amountMist: string; threshold: number; approvedWeight: number
  deadlineMs: number; status: "pending" | "approved" | "executed" | "rejected"
  members: Record<string, number>; votes: Record<string, number>; rejectionWeight: number
  rejectingVoters: string[]; rejectionSupported: boolean; previousTransaction: string | null
}

export function validateApproval(snapshot: ProposalSnapshot, address: string, now = Date.now()): number {
  if (snapshot.status === "executed" || snapshot.status === "rejected") throw new Error(t("vault.proposalClosed"))
  if (now > snapshot.deadlineMs) throw new Error(t("vault.proposalExpired"))
  if (snapshot.epoch !== snapshot.organizationEpoch) throw new Error(t("vault.proposalEpochStale"))
  const sender = normalizeSuiAddress(address)
  const weight = snapshot.members[sender]
  if (!weight) throw new Error(t("vault.notAnOrgMember"))
  if (Object.hasOwn(snapshot.votes, sender)) throw new Error(t("vault.alreadyVoted"))
  return weight
}
