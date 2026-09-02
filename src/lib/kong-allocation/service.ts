import { AllocationCoverageError, allocationCoverageContractIssues } from '@/lib/allocation/service'
import { DatabaseConfigurationError } from '@/lib/database/client'
import { DoaConfigurationError, DoaUpstreamError, readDoaOptimizations } from '@/lib/doa/client'
import { selectVaultDoaOptimizations } from '@/lib/doa/overlay'
import {
  EnvioUpstreamError,
  fetchAccountingCheckpoints,
  fetchAllocationCoverage,
  fetchUnresolvedCheckpointFailures
} from '@/lib/envio/client'
import type {
  VaultAccountingCheckpoint,
  VaultAccountingCheckpointFailure,
  VaultAllocationCoverage
} from '@/lib/envio/types'
import { buildTransitions, type TransitionPoint } from './classify'
import { AllocationHistoryCursorError } from './cursor'
import { processDoa } from './doa'
import { fetchCompleteKongAllocationEvents, fetchKongAllocationEvents, isAllocationTransitionEvent } from './envio'
import { materializeStates, type StateBlock } from './materialize'
import {
  readMaterializedAllocationChart,
  readMaterializedAllocationEntry,
  readMaterializedAllocationHistory
} from './repository'
import { buildRestAllocationEntries, buildRestAllocationHistory } from './rest'
import {
  type AllocatorTriggerReplayInput,
  readAllocatorTriggerReplays,
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
  Hash,
  NormalizedAllocationTimeline,
  RpcTransactionContext,
  TimelineDirection,
  VaultAllocationChartResponse,
  VaultAllocationHistoryEntryResponse,
  VaultAllocationHistoryResponse
} from './types'
import type { TestVault } from './vaults'

const CACHE_TTL_MS = 15 * 60 * 1000
const REST_EVENT_SCAN_LIMIT = 100
const DEFAULT_MAX_MATERIALIZATION_EVENTS = 250_000

interface CachedHistory {
  expiresAt: number
  value: Promise<VaultAllocationHistoryResponse>
}

const historyCache = new Map<string, CachedHistory>()

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

interface AllocatorAssignment {
  address: Address
  blockNumber: number
}

function eventAddress(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value.toLowerCase() as Address) : null
}

function allocatorAssignments(events: readonly AllocationSourceEvent[]): AllocatorAssignment[] {
  return events
    .filter((event) => event.eventName === 'NewDebtAllocator' || event.eventName === 'UpdateDebtAllocator')
    .flatMap((event): AllocatorAssignment[] => {
      const allocator = eventAddress(
        event.eventName === 'UpdateDebtAllocator' ? event.args.debtAllocator : event.args.allocator
      )
      return allocator ? [{ address: allocator, blockNumber: event.blockNumber }] : []
    })
    .sort((left, right) => left.blockNumber - right.blockNumber)
}

function allocatorAtTransaction(
  assignments: readonly AllocatorAssignment[],
  blockNumber: number,
  context: RpcTransactionContext | undefined,
  stateAllocator: Address | null
): Address | null {
  const eligible = assignments.filter((assignment) => assignment.blockNumber <= blockNumber)
  const path = new Set([...(context?.callPath ?? []), context?.to].filter((value): value is Address => value != null))
  if (stateAllocator && path.has(stateAllocator)) return stateAllocator
  return [...eligible].reverse().find((assignment) => path.has(assignment.address))?.address ?? null
}

function triggerReplayInputs(
  vaultAddress: Address,
  selectedEvents: readonly AllocationSourceEvent[],
  allEvents: readonly AllocationSourceEvent[],
  contexts: ReadonlyMap<Hash, RpcTransactionContext>,
  states: readonly AllocationState[],
  assetDecimals: number | null
): AllocatorTriggerReplayInput[] {
  const assignments = allocatorAssignments(allEvents)
  const stateAllocators = new Map(states.map((state) => [state.blockNumber, state.allocatorAddress]))
  const seen = new Set<string>()
  return selectedEvents.flatMap((event): AllocatorTriggerReplayInput[] => {
    if (event.eventName !== 'DebtUpdated' || !event.strategyAddress) return []
    const expectedDebt = typeof event.args.newDebt === 'string' ? event.args.newDebt : null
    if (!expectedDebt || !/^\d+$/.test(expectedDebt)) return []
    const allocatorAddress = allocatorAtTransaction(
      assignments,
      event.blockNumber,
      contexts.get(event.transactionHash),
      stateAllocators.get(event.blockNumber) ?? null
    )
    if (!allocatorAddress) return []
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
  if (blocks.some((block) => block.blockNumber === safeBlock.blockNumber)) return null
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

function proposalOrder<T extends { proposalTimestamp: number }>(
  values: readonly T[],
  direction: TimelineDirection
): T[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...values].sort((left, right) => multiplier * (left.proposalTimestamp - right.proposalTimestamp))
}

function matchingTransitionPoints(chainId: number, vaultAddress: Address, events: readonly AllocationSourceEvent[]) {
  return eventTransitionPoints(chainId, vaultAddress, eventBlocks(events))
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

function uniqueLimitations(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function provisionalCoverage(vault: TestVault, safeBlock: EventBlock, limitations: readonly string[]) {
  return {
    id: `provisional:${vault.chainId}:${vault.address.toLowerCase()}:${safeBlock.blockNumber}`,
    chainId: vault.chainId,
    vaultAddress: vault.address.toLowerCase(),
    coverageStartBlock: 0,
    coverageStartBlockHash: `0x${'0'.repeat(64)}`,
    validatedThroughBlock: safeBlock.blockNumber,
    validatedThroughBlockHash: `0x${'0'.repeat(64)}`,
    vaultDiscoveryComplete: false,
    eventHistoryComplete: false,
    allocatorDeploymentHistoryComplete: false,
    allocatorAssignmentHistoryComplete: false,
    checkpointTriggerAuditComplete: false,
    safeForTimeline: false,
    knownGaps: uniqueLimitations(limitations),
    coverageRevision: `provisional-event-rpc-${safeBlock.blockNumber}`,
    producerCommit: '0'.repeat(40),
    validatedAt: new Date().toISOString()
  } satisfies VaultAllocationCoverage
}

async function materializationHead(
  vault: TestVault,
  allowUncertified = false
): Promise<{
  coverage: VaultAllocationCoverage
  safeBlock: EventBlock
  limitations: string[]
}> {
  const rpcSafeBlock = await readLatestSafeBlock(vault.chainId)
  let coverage: VaultAllocationCoverage | null = null
  try {
    coverage = await fetchAllocationCoverage({
      chainId: vault.chainId,
      vaultAddress: vault.address.toLowerCase(),
      allowUnsafe: allowUncertified
    })
  } catch (error) {
    if (!allowUncertified || !(error instanceof EnvioUpstreamError)) throw error
    const limitations = ['Envio coverage metadata is unavailable; event replay begins at block 0']
    return { coverage: provisionalCoverage(vault, rpcSafeBlock, limitations), safeBlock: rpcSafeBlock, limitations }
  }
  if (!coverage) {
    if (!allowUncertified) throw new AllocationCoverageError('No certified Envio allocation coverage row was found')
    const limitations = ['Envio coverage metadata is unavailable; event replay begins at block 0']
    return { coverage: provisionalCoverage(vault, rpcSafeBlock, limitations), safeBlock: rpcSafeBlock, limitations }
  }

  const issues = allocationCoverageContractIssues(coverage)
  if ((!coverage.safeForTimeline || issues.length > 0) && !allowUncertified) {
    throw new AllocationCoverageError(
      coverage.safeForTimeline
        ? `Invalid Envio allocation coverage: ${issues.join(', ')}`
        : `Envio coverage revision ${coverage.coverageRevision} is not safe for timeline use`
    )
  }
  const validRange =
    Number.isSafeInteger(coverage.coverageStartBlock) &&
    Number.isSafeInteger(coverage.validatedThroughBlock) &&
    coverage.coverageStartBlock >= 0 &&
    coverage.coverageStartBlock <= coverage.validatedThroughBlock
  if (!validRange) {
    if (!allowUncertified) throw new AllocationCoverageError('Certified Envio coverage has an invalid block range')
    const limitations = ['Envio coverage has an invalid block range; event replay begins at block 0']
    return { coverage: provisionalCoverage(vault, rpcSafeBlock, limitations), safeBlock: rpcSafeBlock, limitations }
  }

  const blockNumber = Math.min(rpcSafeBlock.blockNumber, coverage.validatedThroughBlock)
  if (blockNumber < coverage.coverageStartBlock) {
    if (!allowUncertified) {
      throw new AllocationCoverageError('Certified Envio coverage does not contain a materializable block')
    }
    const limitations = ['Envio coverage does not contain the current safe block; event replay begins at block 0']
    return { coverage: provisionalCoverage(vault, rpcSafeBlock, limitations), safeBlock: rpcSafeBlock, limitations }
  }
  const safeBlock =
    blockNumber === rpcSafeBlock.blockNumber
      ? rpcSafeBlock
      : {
          blockNumber,
          blockTimestamp: (await readBlockTimestamps(vault.chainId, [blockNumber])).get(blockNumber) as number
        }
  const limitations = coverage.safeForTimeline
    ? issues.map((issue) => `Envio coverage issue: ${issue}`)
    : [
        'Envio coverage is not certified safe for timeline use',
        ...coverage.knownGaps.map((gap) => `Envio reported gap: ${gap}`),
        ...issues.map((issue) => `Envio coverage issue: ${issue}`)
      ]
  const effectiveCoverage =
    limitations.length === 0
      ? coverage
      : { ...coverage, safeForTimeline: false, knownGaps: uniqueLimitations(limitations) }
  return {
    coverage: effectiveCoverage,
    safeBlock,
    limitations: effectiveCoverage.safeForTimeline ? [] : effectiveCoverage.knownGaps
  }
}

async function checkpointEvidence(
  range: { chainId: number; vaultAddress: Address; fromBlock: number; toBlock: number },
  allowUncertified: boolean
): Promise<{
  checkpoints: VaultAccountingCheckpoint[]
  failures: VaultAccountingCheckpointFailure[]
  limitations: string[]
}> {
  const limitations: string[] = []
  let checkpoints: VaultAccountingCheckpoint[] = []
  let failures: VaultAccountingCheckpointFailure[] = []
  try {
    checkpoints = await fetchAccountingCheckpoints(range)
  } catch (error) {
    if (!allowUncertified || !(error instanceof EnvioUpstreamError)) throw error
    limitations.push('Envio accounting checkpoints are unavailable; unallocated values are omitted')
  }
  try {
    failures = await fetchUnresolvedCheckpointFailures(range)
  } catch (error) {
    if (!allowUncertified || !(error instanceof EnvioUpstreamError)) throw error
    limitations.push('Envio checkpoint-failure records are unavailable')
  }
  return { checkpoints, failures, limitations }
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
  coverage: VaultAllocationCoverage
  safeBlock: EventBlock
  vault: VaultAllocationHistoryResponse['vault']
  entries: VaultAllocationHistoryResponse['entries']
  sourceEvents: AllocationSourceEvent[]
  allowProvisional: boolean
}

export async function materializeCompleteKongAllocationHistory(
  vault: TestVault
): Promise<CompleteAllocationMaterialization> {
  const generatedAt = Math.floor(Date.now() / 1000)
  const allowUncertified = uncertifiedMaterializationAllowed()
  const head = await materializationHead(vault, allowUncertified)
  const { safeBlock } = head
  const range = {
    chainId: vault.chainId,
    vaultAddress: vault.address.toLowerCase() as Address,
    fromBlock: head.coverage.coverageStartBlock,
    toBlock: safeBlock.blockNumber
  }
  const [eventBatch, checkpointResult, doaFeed] = await Promise.all([
    fetchCompleteKongAllocationEvents({ ...range, vaultAddress: vault.address, maxEvents: maxMaterializationEvents() }),
    checkpointEvidence(range, allowUncertified),
    optionalDoaOptimizations(vault.chainId)
  ])
  const limitations = [...head.limitations, ...checkpointResult.limitations]
  if (!eventBatch.normalizedSupplementAvailable) {
    if (!allowUncertified) {
      throw new AllocationCoverageError('Envio normalized allocator configuration events are unavailable')
    }
    limitations.push('Envio normalized allocator configuration events are unavailable')
  }
  if (checkpointResult.failures.length > 0) {
    if (!allowUncertified) {
      throw new AllocationCoverageError(
        `Envio has ${checkpointResult.failures.length} unresolved checkpoint failures in the certified range`
      )
    }
    limitations.push(`Envio has ${checkpointResult.failures.length} unresolved checkpoint failures in this range`)
  }
  const materializationLimitations = uniqueLimitations(limitations)
  const transitionBlocks = eventBlocks(eventBatch.events)
  const firstTransitionBlock = transitionBlocks[0]?.blockNumber ?? safeBlock.blockNumber
  const coverageStartBlock = head.coverage.safeForTimeline
    ? head.coverage.coverageStartBlock
    : Math.max(head.coverage.coverageStartBlock, firstTransitionBlock)
  if (!head.coverage.safeForTimeline && coverageStartBlock > head.coverage.coverageStartBlock) {
    materializationLimitations.push(
      `Provisional state reconstruction begins at the first indexed transition block ${coverageStartBlock}`
    )
  }
  const coverage =
    materializationLimitations.length === 0
      ? head.coverage
      : {
          ...head.coverage,
          coverageStartBlock,
          safeForTimeline: false,
          knownGaps: uniqueLimitations(materializationLimitations)
        }

  const transitionBlockNumbers = new Set(transitionBlocks.map((block) => block.blockNumber))
  const blocks = await pairedStateBlocks(vault.chainId, transitionBlocks, safeBlock, coverage.coverageStartBlock)
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
      checkpoints: checkpointResult.checkpoints
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
      vaultMetadata.assetDecimals
    )
  )
  const latestState = materialized.states.find((state) => state.blockNumber === safeBlock.blockNumber)
  if (!latestState) throw new Error('No current allocation state was materialized')
  const names = await readContractNames(vault.chainId, materialized.strategyAddresses, safeBlock.blockNumber)
  const baseTransitions = buildTransitions({
    chainId: vault.chainId,
    vaultAddress: vault.address,
    points: selectedTransitionPoints(
      vault.chainId,
      vault.address,
      transitionBlocks,
      safeBlock,
      coverage.coverageStartBlock
    ),
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
    allowProvisional: !coverage.safeForTimeline,
    sourceEvents: hydratedEvents,
    entries: buildRestAllocationEntries({
      timeline: normalized,
      doaRecords: selectedDoaRecords,
      doaRecordsAvailable: doaFeed.available,
      materializationLimitations: coverage.knownGaps
    })
  }
}

async function loadHistory(input: {
  vault: TestVault
  limit: number
  direction: TimelineDirection
}): Promise<VaultAllocationHistoryResponse> {
  const generatedAt = Math.floor(Date.now() / 1000)
  const { safeBlock } = await materializationHead(input.vault)
  const eventBatch = await fetchKongAllocationEvents({
    chainId: input.vault.chainId,
    vaultAddress: input.vault.address,
    toBlock: safeBlock.blockNumber
  })
  const allEventBlocks = eventBlocks(eventBatch.events)
  const safeBlockIsEvent = allEventBlocks.some((block) => block.blockNumber === safeBlock.blockNumber)
  const selectedEventBlocks = eventBlocks(
    eventBatch.events,
    safeBlockIsEvent ? REST_EVENT_SCAN_LIMIT : REST_EVENT_SCAN_LIMIT - 1
  )
  const hasMore = allEventBlocks.length > selectedEventBlocks.length
  const blocks = await pairedStateBlocks(input.vault.chainId, selectedEventBlocks, safeBlock)
  const checkpointRange = {
    chainId: input.vault.chainId,
    vaultAddress: input.vault.address.toLowerCase(),
    fromBlock: Math.min(...blocks.map((block) => block.blockNumber)),
    toBlock: Math.max(...blocks.map((block) => block.blockNumber))
  }
  const [checkpoints, failures] = await Promise.all([
    fetchAccountingCheckpoints(checkpointRange),
    fetchUnresolvedCheckpointFailures(checkpointRange)
  ])
  if (failures.length > 0) {
    throw new AllocationCoverageError(
      `Envio has ${failures.length} unresolved checkpoint failures in the response range`
    )
  }
  const selectedBlockNumbers = new Set(blocks.map((block) => block.blockNumber))
  const selectedEvents = eventBatch.events.filter((event) => selectedBlockNumbers.has(event.blockNumber))
  const transactionContexts = await readTransactionContexts(
    input.vault.chainId,
    selectedEvents.map((event) => event.transactionHash),
    input.vault.address
  )
  const hydratedEvents = hydrateTransactions(eventBatch.events, transactionContexts)

  const [materialized, vaultMetadata, doaFeed] = await Promise.all([
    materializeStates({
      chainId: input.vault.chainId,
      vaultAddress: input.vault.address,
      blocks,
      events: hydratedEvents,
      checkpoints
    }),
    readVaultMetadata(input.vault.chainId, input.vault.address, safeBlock.blockNumber),
    optionalDoaOptimizations(input.vault.chainId)
  ])
  const triggerReplays = await readAllocatorTriggerReplays(
    input.vault.chainId,
    triggerReplayInputs(
      input.vault.address,
      hydratedEvents.filter((event) => selectedBlockNumbers.has(event.blockNumber)),
      hydratedEvents,
      transactionContexts,
      materialized.states,
      vaultMetadata.assetDecimals
    )
  )
  const latestState = materialized.states.find((state) => state.blockNumber === safeBlock.blockNumber)
  if (!latestState) throw new Error('No allocation states were materialized')
  const names = await readContractNames(input.vault.chainId, materialized.strategyAddresses, safeBlock.blockNumber)
  const baseTransitions = buildTransitions({
    chainId: input.vault.chainId,
    vaultAddress: input.vault.address,
    points: selectedTransitionPoints(input.vault.chainId, input.vault.address, selectedEventBlocks, safeBlock),
    events: hydratedEvents,
    transactionContexts,
    triggerReplays
  })

  const candidates = buildTransitions({
    chainId: input.vault.chainId,
    vaultAddress: input.vault.address,
    points: matchingTransitionPoints(input.vault.chainId, input.vault.address, hydratedEvents),
    events: hydratedEvents
  })
  const selectedDoaRecords = selectVaultDoaOptimizations(doaFeed.records, input.vault.address, 500)
  const doa = processDoa(selectedDoaRecords, candidates, hydratedEvents)
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
    unappliedDoaProposals: proposalOrder(doa.unappliedDoaProposals, input.direction),
    events: hydratedEvents.filter((event) => selectedBlockNumbers.has(event.blockNumber))
  }
  return buildRestAllocationHistory({
    timeline: normalized,
    doaRecords: selectedDoaRecords,
    doaRecordsAvailable: doaFeed.available,
    direction: input.direction,
    limit: input.limit,
    hasMore
  })
}

export async function getKongAllocationHistory(input: {
  vault: TestVault
  limit: number
  direction: TimelineDirection
  cursor?: string | null
}): Promise<VaultAllocationHistoryResponse> {
  const configuredSource = process.env.ALLOCATION_HISTORY_SOURCE?.trim().toLowerCase() || 'live'
  if (configuredSource !== 'database' && configuredSource !== 'live') {
    throw new DatabaseConfigurationError('ALLOCATION_HISTORY_SOURCE must be database or live')
  }
  if (configuredSource === 'database') return readMaterializedAllocationHistory(input)
  if (input.cursor) {
    throw new AllocationHistoryCursorError('Cursor pagination requires the Postgres allocation history read model')
  }

  const key = `${input.vault.chainId}:${input.vault.address.toLowerCase()}:${input.limit}:${input.direction}`
  const cached = historyCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = loadHistory(input)
  historyCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  try {
    return await value
  } catch (error) {
    historyCache.delete(key)
    throw error
  }
}

export async function getKongAllocationChart(input: {
  vault: TestVault
  limit: number
  direction: TimelineDirection
  cursor?: string | null
}): Promise<VaultAllocationChartResponse> {
  const configuredSource = process.env.ALLOCATION_HISTORY_SOURCE?.trim().toLowerCase() || 'live'
  if (configuredSource !== 'database') {
    throw new DatabaseConfigurationError('The chart projection requires the Postgres allocation history read model')
  }
  return readMaterializedAllocationChart(input)
}

export async function getKongAllocationHistoryEntry(input: {
  vault: TestVault
  entryId: string
  runId?: string | null
}): Promise<VaultAllocationHistoryEntryResponse> {
  const configuredSource = process.env.ALLOCATION_HISTORY_SOURCE?.trim().toLowerCase() || 'live'
  if (configuredSource !== 'database') {
    throw new DatabaseConfigurationError('Allocation history entry details require the Postgres read model')
  }
  return readMaterializedAllocationEntry(input)
}

export function clearKongAllocationHistoryCache(): void {
  historyCache.clear()
}
