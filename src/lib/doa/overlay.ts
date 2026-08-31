import type { AllocationStateStrategy } from '@/lib/allocation/processor'
import { type AllocationTimeline, stateAtTimestamp } from '@/lib/allocation/service'
import type {
  DoaAllocationSnapshot,
  DoaAllocationSnapshotStrategy,
  DoaOptimizationRecord,
  DoaStrategyDebtRatio,
  EnrichedDoaOptimizationRecord
} from './types'

function timestampSeconds(timestampUtc: string | null): number | null {
  if (!timestampUtc) return null
  const milliseconds = Date.parse(timestampUtc.replace(' UTC', 'Z').replace(' ', 'T'))
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null
}

function sortTimestamp(record: DoaOptimizationRecord): number {
  const parsed = timestampSeconds(record.freshness.optimizationTimestampUtc)
  if (parsed !== null) return parsed
  return record.source.isLatestAlias ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER
}

function recordIdentity(record: DoaOptimizationRecord): string {
  return JSON.stringify({
    timestampUtc: record.freshness.optimizationTimestampUtc,
    vault: record.vault,
    strategyDebtRatios: record.strategyDebtRatios,
    currentApr: record.currentApr,
    proposedApr: record.proposedApr,
    explain: record.explain
  })
}

export function selectVaultDoaOptimizations(
  records: readonly DoaOptimizationRecord[],
  vaultAddress: string,
  limit: number
): DoaOptimizationRecord[] {
  const vault = vaultAddress.toLowerCase()
  const sorted = records
    .filter((record) => record.vault.toLowerCase() === vault)
    .sort(
      (left, right) =>
        sortTimestamp(right) - sortTimestamp(left) ||
        Number(left.source.isLatestAlias) - Number(right.source.isLatestAlias) ||
        left.source.key.localeCompare(right.source.key)
    )
  const identities = new Set<string>()
  const selected: DoaOptimizationRecord[] = []
  for (const record of sorted) {
    const identity = recordIdentity(record)
    if (identities.has(identity)) continue
    identities.add(identity)
    selected.push(record)
    if (selected.length === limit) break
  }
  return selected
}

interface OptimizerStrategy {
  address: string
  name: string | null
  currentBps: number
  targetBps: number
}

function optimizerStrategies(strategies: readonly DoaStrategyDebtRatio[]): Map<string, OptimizerStrategy> {
  const values = new Map<string, OptimizerStrategy>()
  for (const strategy of strategies) {
    const address = strategy.strategy.toLowerCase()
    const current = values.get(address)
    values.set(address, {
      address,
      name: current?.name ?? strategy.name?.trim() ?? null,
      currentBps: (current?.currentBps ?? 0) + strategy.currentRatio,
      targetBps: (current?.targetBps ?? 0) + strategy.targetRatio
    })
  }
  return values
}

function snapshotStrategy(
  address: string,
  indexed: AllocationStateStrategy | undefined,
  optimized: OptimizerStrategy | undefined
): DoaAllocationSnapshotStrategy {
  return {
    address: indexed?.strategyAddress ?? optimized?.address ?? address,
    name: optimized?.name ?? indexed?.name ?? null,
    nameSource: optimized?.name ? 'optimizer' : null,
    currentBps: indexed?.currentDebtBps ?? 0,
    optimizerCurrentBps: optimized?.currentBps ?? null,
    targetBps: optimized?.targetBps ?? null,
    indexedTargetDebtRatioBps: indexed?.targetDebtRatioBps ?? null,
    optimizerScope: optimized ? 'optimized' : 'unknown'
  }
}

function fallbackSnapshot(record: DoaOptimizationRecord): DoaAllocationSnapshot {
  return {
    requestedTimestampUtc: record.freshness.optimizationTimestampUtc,
    stateTimestampUtc: null,
    blockNumber: null,
    indexedStateId: null,
    source: null,
    complete: false,
    strategies: [],
    unallocatedBps: null,
    unallocatedSource: null
  }
}

export function enrichDoaOptimization(
  record: DoaOptimizationRecord,
  timeline: AllocationTimeline | null
): EnrichedDoaOptimizationRecord {
  const timestamp = timestampSeconds(record.freshness.optimizationTimestampUtc)
  if (!timeline || timestamp === null) {
    return { ...record, allocationSnapshot: fallbackSnapshot(record) }
  }
  const latestState = timeline.states.at(-1)
  if (!latestState || latestState.blockTimestamp < timestamp) {
    return { ...record, allocationSnapshot: fallbackSnapshot(record) }
  }
  const state = stateAtTimestamp(timeline, timestamp)
  if (!state || !timeline.complete || !state.complete || state.unallocatedBps === null) {
    return { ...record, allocationSnapshot: fallbackSnapshot(record) }
  }

  const optimized = optimizerStrategies(record.strategyDebtRatios)
  const indexed = new Map(state.strategies.map((strategy) => [strategy.strategyAddress.toLowerCase(), strategy]))
  const addresses = [...new Set([...indexed.keys(), ...optimized.keys()])].sort()
  const strategies = addresses.map((address) => snapshotStrategy(address, indexed.get(address), optimized.get(address)))
  const unallocatedBps = state.unallocatedBps
  const unallocatedSource = 'same-timestamp-indexed' as const

  return {
    ...record,
    allocationCoverage: {
      ...record.allocationCoverage,
      unallocatedBps,
      unallocatedSource
    },
    allocationSnapshot: {
      requestedTimestampUtc: record.freshness.optimizationTimestampUtc,
      stateTimestampUtc: state.timestampUtc,
      blockNumber: state.blockNumber,
      indexedStateId: state.id,
      source: 'envio-allocation-history',
      complete: true,
      strategies,
      unallocatedBps,
      unallocatedSource
    }
  }
}

export function enrichDoaOptimizations(
  records: readonly DoaOptimizationRecord[],
  timeline: AllocationTimeline | null
): EnrichedDoaOptimizationRecord[] {
  return records.map((record) => enrichDoaOptimization(record, timeline))
}
