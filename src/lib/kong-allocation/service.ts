import { readDoaOptimizations } from '@/lib/doa/client'
import { selectVaultDoaOptimizations } from '@/lib/doa/overlay'
import { buildTransitions, type TransitionPoint } from './classify'
import { processDoa } from './doa'
import { fetchKongAllocationEvents, isAllocationTransitionEvent } from './envio'
import { materializeStates, type StateBlock } from './materialize'
import { buildRestAllocationHistory } from './rest'
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
  VaultAllocationHistoryResponse
} from './types'
import type { TestVault } from './vaults'

const CACHE_TTL_MS = 15 * 60 * 1000
const REST_EVENT_SCAN_LIMIT = 100

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
  safeBlock: EventBlock
): Promise<StateBlock[]> {
  const eventBlockNumbers = new Set(transitions.map((block) => block.blockNumber))
  const timestamps = new Map(transitions.map((block) => [block.blockNumber, block.blockTimestamp]))
  timestamps.set(safeBlock.blockNumber, safeBlock.blockTimestamp)
  const blockNumbers = new Set<number>([safeBlock.blockNumber])
  for (const transition of transitions) {
    blockNumbers.add(transition.blockNumber)
    blockNumbers.add(Math.max(0, transition.blockNumber - 1))
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
  blocks: readonly EventBlock[]
): TransitionPoint[] {
  return blocks.map(({ blockNumber, blockTimestamp }) => ({
    blockNumber,
    blockTimestamp,
    fromStateId: stateId(chainId, vaultAddress, Math.max(0, blockNumber - 1)),
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
  safeBlock: EventBlock
): TransitionPoint[] {
  const points = eventTransitionPoints(chainId, vaultAddress, blocks)
  const liveTail = liveTailPoint(chainId, vaultAddress, blocks, safeBlock)
  if (liveTail) points.push(liveTail)
  return points
}

async function loadHistory(input: {
  vault: TestVault
  limit: number
  direction: TimelineDirection
}): Promise<VaultAllocationHistoryResponse> {
  const generatedAt = Math.floor(Date.now() / 1000)
  const safeBlock = await readLatestSafeBlock(input.vault.chainId)
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
  const selectedBlockNumbers = new Set(blocks.map((block) => block.blockNumber))
  const selectedEvents = eventBatch.events.filter((event) => selectedBlockNumbers.has(event.blockNumber))
  const transactionContexts = await readTransactionContexts(
    input.vault.chainId,
    selectedEvents.map((event) => event.transactionHash),
    input.vault.address
  )
  const hydratedEvents = hydrateTransactions(eventBatch.events, transactionContexts)

  const [materialized, vaultMetadata, doaRecords] = await Promise.all([
    materializeStates({
      chainId: input.vault.chainId,
      vaultAddress: input.vault.address,
      blocks,
      events: hydratedEvents
    }),
    readVaultMetadata(input.vault.chainId, input.vault.address, safeBlock.blockNumber),
    readDoaOptimizations(input.vault.chainId)
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
  const selectedDoaRecords = selectVaultDoaOptimizations(doaRecords, input.vault.address, 500)
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
    direction: input.direction,
    limit: input.limit,
    hasMore
  })
}

export async function getKongAllocationHistory(input: {
  vault: TestVault
  limit: number
  direction: TimelineDirection
}): Promise<VaultAllocationHistoryResponse> {
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

export function clearKongAllocationHistoryCache(): void {
  historyCache.clear()
}
