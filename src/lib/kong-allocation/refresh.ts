import { DoaConfigurationError, DoaUpstreamError, readDoaOptimizations } from '@/lib/doa/client'
import { selectVaultDoaOptimizations } from '@/lib/doa/select'
import { allocatorAssignmentEvents, resolveAllocatorAssignment } from './allocators'
import { buildTransitions, type TransitionPoint } from './classify'
import { processDoa } from './doa'
import {
  AllocationCoverageError,
  type AllocationEventReader,
  assertEvidence,
  type EventCoverage,
  isAllocationTransitionEvent
} from './evidence'
import { historicalCache } from './historical-cache'
import { materializeStates, type StateBlock } from './materialize'
import { buildRestAllocationEntries } from './rest'
import {
  type AllocatorTriggerReplayInput,
  readAllocatorTriggerReplays,
  readBlockIdentities,
  readBlockTimestamps,
  readContractNames,
  readLatestSafeBlock,
  readTransactionContexts,
  readVaultMetadata
} from './rpc'
import type {
  Address,
  AllocationHistoryStrategy,
  AllocationSourceEvent,
  AllocationState,
  AllocatorDeploymentEvidence,
  Hash,
  NormalizedAllocationTimeline,
  RpcTransactionContext,
  TimelineDirection,
  VaultAllocationHistoryResponse
} from './types'
import type { TestVault } from './vaults'

const DEFAULT_MAX_MATERIALIZATION_EVENTS = 250_000

function stateId(chainId: number, vaultAddress: Address, blockNumber: number): string {
  return `allocation-state:${chainId}:${vaultAddress.toLowerCase()}:${blockNumber}`
}

export interface EventBlock {
  blockNumber: number
  blockTimestamp: number
}

export function eventBlocks(events: readonly AllocationSourceEvent[], limit?: number): EventBlock[] {
  const timestamps = new Map<number, number>()
  for (const event of events) {
    if (isAllocationTransitionEvent(event)) timestamps.set(event.blockNumber, event.blockTimestamp)
  }
  const blocks = [...timestamps]
    .sort(([left], [right]) => left - right)
    .map(([blockNumber, blockTimestamp]) => ({ blockNumber, blockTimestamp }))
  if (limit === undefined) return blocks
  return limit === 0 ? [] : blocks.slice(-limit)
}

export function firstVaultEventBlock(
  events: readonly AllocationSourceEvent[],
  vault: Address,
  fallback: number
): number {
  return events.reduce(
    (start, event) =>
      event.sourceAddress.toLowerCase() === vault.toLowerCase() ||
      event.vaultAddress?.toLowerCase() === vault.toLowerCase()
        ? Math.min(start, event.blockNumber)
        : start,
    fallback
  )
}

async function pairedStateBlocks(
  chainId: number,
  transitions: readonly EventBlock[],
  safeBlock: EventBlock,
  coverageStartBlock = 0
): Promise<StateBlock[]> {
  const eventBlockNumbers = new Set(transitions.map((block) => block.blockNumber))
  const timestamps = new Map(transitions.map((block) => [block.blockNumber, block.blockTimestamp]))
  timestamps.set(safeBlock.blockNumber, safeBlock.blockTimestamp)
  const blockNumbers = new Set<number>([safeBlock.blockNumber])
  for (const transition of transitions) {
    blockNumbers.add(transition.blockNumber)
    if (transition.blockNumber > coverageStartBlock) blockNumbers.add(transition.blockNumber - 1)
  }
  const missingTimestamps = [...blockNumbers].filter((blockNumber) => !timestamps.has(blockNumber))
  const rpcTimestamps = await readBlockTimestamps(chainId, missingTimestamps)
  for (const [blockNumber, blockTimestamp] of rpcTimestamps) timestamps.set(blockNumber, blockTimestamp)

  return [...blockNumbers]
    .sort((left, right) => left - right)
    .map((blockNumber) => ({
      blockNumber,
      blockTimestamp: timestamps.get(blockNumber) as number,
      stateGranularity:
        blockNumber === safeBlock.blockNumber && !eventBlockNumbers.has(blockNumber) ? 'latest' : 'block_end'
    }))
}

function hydrateTransactions(
  events: readonly AllocationSourceEvent[],
  contexts: Awaited<ReturnType<typeof readTransactionContexts>>
): AllocationSourceEvent[] {
  return events.map((event) => {
    const context = contexts.get(event.transactionHash)
    if (!context) return event
    return {
      ...event,
      transactionFrom: context.from ?? event.transactionFrom,
      transactionTo: context.to,
      inputSelector: context.inputSelector
    }
  })
}

function triggerReplayInputs(
  vaultAddress: Address,
  selectedEvents: readonly AllocationSourceEvent[],
  allEvents: readonly AllocationSourceEvent[],
  contexts: ReadonlyMap<Hash, RpcTransactionContext>,
  states: readonly AllocationState[],
  assetDecimals: number | null,
  deployments: readonly AllocatorDeploymentEvidence[]
): AllocatorTriggerReplayInput[] {
  const statesByBlock = new Map(states.map((state) => [state.blockNumber, state]))
  const assignments = allocatorAssignmentEvents(allEvents)
  const seen = new Set<string>()
  return selectedEvents.flatMap((event): AllocatorTriggerReplayInput[] => {
    if (event.eventName !== 'DebtUpdated' || !event.strategyAddress) return []
    const expectedDebt = typeof event.args.newDebt === 'string' ? event.args.newDebt : null
    if (!expectedDebt || !/^\d+$/.test(expectedDebt)) return []
    const before = statesByBlock.get(event.blockNumber - 1)?.allocatorResolution
    const resolution = resolveAllocatorAssignment({
      vaultAddress,
      events: assignments,
      at: event,
      roleManagerAddress: before?.roleManagerAddress ?? null,
      deployments
    })
    const allocatorAddress = resolution.address
    const context = contexts.get(event.transactionHash)
    const path = [...(context?.callPath ?? []), context?.to]
    if (!allocatorAddress || !path.some((value) => value?.toLowerCase() === allocatorAddress)) return []
    const key = `${event.transactionHash}:${event.strategyAddress}`
    if (seen.has(key)) return []
    seen.add(key)
    const unitTolerance = assetDecimals === null ? 0n : 10n ** BigInt(Math.max(0, assetDecimals - 3))
    const relativeTolerance = BigInt(expectedDebt) / 1_000_000_000n
    const matchTolerance = (unitTolerance > relativeTolerance ? unitTolerance : relativeTolerance).toString()
    return [
      {
        transactionHash: event.transactionHash,
        allocatorAddress,
        family: resolution.support === 'supported' ? resolution.family : 'unknown',
        vaultAddress,
        strategyAddress: event.strategyAddress,
        blockNumber: event.blockNumber,
        expectedDebt,
        matchTolerance
      }
    ]
  })
}

function eventTransitionPoints(
  chainId: number,
  vaultAddress: Address,
  blocks: readonly EventBlock[],
  coverageStartBlock = 0
): TransitionPoint[] {
  return blocks.map(({ blockNumber, blockTimestamp }) => ({
    blockNumber,
    blockTimestamp,
    fromStateId: blockNumber > coverageStartBlock ? stateId(chainId, vaultAddress, blockNumber - 1) : null,
    toStateId: stateId(chainId, vaultAddress, blockNumber)
  }))
}

function liveTailPoint(
  chainId: number,
  vaultAddress: Address,
  blocks: readonly EventBlock[],
  safeBlock: EventBlock
): TransitionPoint | null {
  return {
    blockNumber: safeBlock.blockNumber,
    blockTimestamp: safeBlock.blockTimestamp,
    fromStateId: blocks.length > 0 ? stateId(chainId, vaultAddress, blocks[blocks.length - 1].blockNumber) : null,
    toStateId: stateId(chainId, vaultAddress, safeBlock.blockNumber),
    currentLiveTail: true
  }
}

export function orderByDirection<T extends { blockNumber: number; id?: string }>(
  values: readonly T[],
  direction: TimelineDirection
): T[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...values].sort(
    (left, right) =>
      multiplier * (left.blockNumber - right.blockNumber) || multiplier * (left.id ?? '').localeCompare(right.id ?? '')
  )
}

export function buildStrategyDirectory(
  addresses: readonly Address[],
  names: ReadonlyMap<Address, string | null>,
  latestState: AllocationState
): AllocationHistoryStrategy[] {
  const current = new Map(latestState.strategies.map((strategy) => [strategy.strategyAddress, strategy]))
  return addresses.map((strategyAddress) => {
    const state = current.get(strategyAddress)
    const status =
      state?.activation === null || state === undefined ? 'unknown' : state.activation > 0 ? 'active' : 'inactive'
    return {
      address: strategyAddress,
      name: names.get(strategyAddress) ?? null,
      status
    }
  })
}

/*
 * A transition at block N always links the immediately preceding RPC state
 * (N - 1) to the block-end RPC state (N), independent of response ordering.
 */
function selectedTransitionPoints(
  chainId: number,
  vaultAddress: Address,
  blocks: readonly EventBlock[],
  safeBlock: EventBlock,
  coverageStartBlock = 0
): TransitionPoint[] {
  const points = eventTransitionPoints(chainId, vaultAddress, blocks, coverageStartBlock)
  const liveTail = liveTailPoint(chainId, vaultAddress, blocks, safeBlock)
  if (liveTail) points.push(liveTail)
  return points
}

function maxMaterializationEvents(): number {
  const parsed = Number.parseInt(process.env.ALLOCATION_MAX_MATERIALIZATION_EVENTS ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MATERIALIZATION_EVENTS
}

function uncertifiedMaterializationAllowed(): boolean {
  return process.env.ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION?.trim().toLowerCase() === 'true'
}

async function optionalDoaOptimizations(chainId: number): Promise<{
  records: Awaited<ReturnType<typeof readDoaOptimizations>>
  available: boolean
}> {
  try {
    return { records: await readDoaOptimizations(chainId), available: true }
  } catch (error) {
    if (!(error instanceof DoaConfigurationError) && !(error instanceof DoaUpstreamError)) throw error
    console.warn('DOA proposal enrichment is unavailable; materializing executed history without it')
    return { records: [], available: false }
  }
}

function assertMaterializedAccounting(states: readonly AllocationState[]): void {
  for (const state of states) {
    const strategyDebt = state.strategies.reduce((sum, strategy) => sum + BigInt(strategy.currentDebt), 0n)
    if (strategyDebt !== BigInt(state.totalDebt)) {
      throw new AllocationCoverageError(`Strategy debt does not reconcile at block ${state.blockNumber}`)
    }
    if (state.totalIdle === null || BigInt(state.totalDebt) + BigInt(state.totalIdle) !== BigInt(state.totalAssets)) {
      throw new AllocationCoverageError(`Vault accounting identity does not reconcile at block ${state.blockNumber}`)
    }
  }
}

export interface CompleteAllocationMaterialization {
  generatedAt: number
  coverage: EventCoverage
  safeBlock: EventBlock
  vault: VaultAllocationHistoryResponse['vault']
  entries: VaultAllocationHistoryResponse['entries']
  sourceEvents: AllocationSourceEvent[]
  allocatorDeployments: AllocatorDeploymentEvidence[]
  allowProvisional: boolean
}

export async function materializeCompleteKongAllocationHistory(
  vault: TestVault,
  reader: AllocationEventReader
): Promise<CompleteAllocationMaterialization> {
  const generatedAt = Math.floor(Date.now() / 1000)
  const allowUncertified = uncertifiedMaterializationAllowed()
  const finalized = await readLatestSafeBlock(vault.chainId)
  const cap = process.env.ALLOCATION_MATERIALIZATION_TO_BLOCK
  const finalBlock = cap === undefined ? finalized.blockNumber : Number(cap)
  if (!Number.isSafeInteger(finalBlock) || finalBlock < 0 || finalBlock > finalized.blockNumber) {
    throw new AllocationCoverageError('Invalid materialization block cap')
  }
  const [evidence, doaFeed] = await Promise.all([
    reader.read({ vault, finalizedBlock: finalBlock, maxEvents: maxMaterializationEvents() }),
    optionalDoaOptimizations(vault.chainId)
  ])
  const coverage = { ...evidence.coverage, limitations: [...evidence.coverage.limitations] }
  const eventBatch = { events: evidence.events, deployments: evidence.deployments }
  const vaultEventStart = firstVaultEventBlock(eventBatch.events, vault.address, coverage.throughBlock)
  const transitionBlocks = eventBlocks(eventBatch.events).filter(
    (block) => block.blockNumber >= Math.max(coverage.fromBlock, vaultEventStart)
  )
  if (coverage.status === 'unverified') {
    coverage.fromBlock = Math.max(coverage.fromBlock, transitionBlocks[0]?.blockNumber ?? coverage.throughBlock)
    coverage.fromBlockHash = null
  }
  const boundaries = await readBlockIdentities(vault.chainId, [coverage.fromBlock, coverage.throughBlock])
  const first = boundaries.get(coverage.fromBlock)
  const last = boundaries.get(coverage.throughBlock)
  if (!first || !last) throw new AllocationCoverageError('Coverage block identities are unavailable')
  if (
    (coverage.fromBlockHash && coverage.fromBlockHash.toLowerCase() !== first.hash) ||
    (coverage.throughBlockHash && coverage.throughBlockHash.toLowerCase() !== last.hash)
  ) {
    throw new AllocationCoverageError('Event coverage conflicts with canonical block identity')
  }
  coverage.fromBlockHash = first.hash
  coverage.throughBlockHash = last.hash
  assertEvidence({ ...evidence, coverage }, vault, finalBlock)
  if (coverage.status !== 'verified' && !allowUncertified) {
    throw new AllocationCoverageError(
      'Event coverage is unverified; provisional reference runs must be explicitly enabled'
    )
  }
  const safeBlock = { blockNumber: last.number, blockTimestamp: last.timestamp }
  const transitionBlockNumbers = new Set(transitionBlocks.map((block) => block.blockNumber))
  await historicalCache()?.registerEvents(
    eventBatch.events.filter((event) => transitionBlockNumbers.has(event.blockNumber))
  )
  const blocks = await pairedStateBlocks(vault.chainId, transitionBlocks, safeBlock, coverage.fromBlock)
  const transactionContexts = await readTransactionContexts(
    vault.chainId,
    eventBatch.events
      .filter((event) => transitionBlockNumbers.has(event.blockNumber))
      .map((event) => event.transactionHash),
    vault.address
  )
  const hydratedEvents = hydrateTransactions(eventBatch.events, transactionContexts)
  const [materialized, vaultMetadata] = await Promise.all([
    materializeStates({
      chainId: vault.chainId,
      vaultAddress: vault.address,
      blocks,
      events: hydratedEvents,
      deployments: eventBatch.deployments
    }),
    readVaultMetadata(vault.chainId, vault.address, safeBlock.blockNumber)
  ])
  assertMaterializedAccounting(materialized.states)
  const triggerReplays = await readAllocatorTriggerReplays(
    vault.chainId,
    triggerReplayInputs(
      vault.address,
      hydratedEvents,
      hydratedEvents,
      transactionContexts,
      materialized.states,
      vaultMetadata.assetDecimals,
      eventBatch.deployments
    )
  )
  const latestState = materialized.states.find((state) => state.blockNumber === safeBlock.blockNumber)
  if (!latestState) throw new Error('No current allocation state was materialized')
  const names = await readContractNames(vault.chainId, materialized.strategyAddresses, safeBlock.blockNumber)
  const baseTransitions = buildTransitions({
    chainId: vault.chainId,
    vaultAddress: vault.address,
    points: selectedTransitionPoints(vault.chainId, vault.address, transitionBlocks, safeBlock, coverage.fromBlock),
    events: hydratedEvents,
    transactionContexts,
    triggerReplays
  })
  const selectedDoaRecords = selectVaultDoaOptimizations(doaFeed.records, vault.address, Number.MAX_SAFE_INTEGER)
  const doa = processDoa(selectedDoaRecords, baseTransitions, hydratedEvents)
  const classifiedById = new Map(doa.transitions.map((transition) => [transition.id, transition]))
  const classifiedTransitions = baseTransitions.map((transition) => {
    const classified = classifiedById.get(transition.id)
    if (!classified) return transition
    const classifiedEffects = new Map(classified.effects.map((effect) => [effect.transactionHash, effect]))
    return {
      ...transition,
      kind: classified.kind,
      effects: transition.effects.map((effect) => ({
        ...effect,
        kind: classifiedEffects.get(effect.transactionHash)?.kind ?? effect.kind
      })),
      ...(classified.doa ? { doa: classified.doa } : {})
    }
  })
  const normalized: NormalizedAllocationTimeline = {
    generatedAt,
    vault: vaultMetadata,
    strategies: buildStrategyDirectory(materialized.strategyAddresses, names, latestState),
    states: materialized.states,
    transitions: classifiedTransitions,
    unappliedDoaProposals: doa.unappliedDoaProposals,
    events: hydratedEvents
  }
  return {
    generatedAt,
    coverage,
    safeBlock,
    vault: vaultMetadata,
    allowProvisional: coverage.status !== 'verified',
    sourceEvents: hydratedEvents,
    allocatorDeployments: eventBatch.deployments,
    entries: buildRestAllocationEntries({
      timeline: normalized,
      doaRecords: selectedDoaRecords,
      doaRecordsAvailable: doaFeed.available,
      materializationLimitations: coverage.limitations
    })
  }
}
