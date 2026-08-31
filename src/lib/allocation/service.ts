import {
  fetchAccountingCheckpoints,
  fetchAllocationCoverage,
  fetchAllocationEvents,
  fetchUnresolvedCheckpointFailures
} from '@/lib/envio/client'
import type { VaultAccountingCheckpointFailure, VaultAllocationCoverage } from '@/lib/envio/types'
import { type AllocationState, buildAllocationStates } from './processor'

const CACHE_TTL_MS = 60_000
const DEFAULT_MAX_REPLAY_EVENTS = 20_000

export class AllocationCoverageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationCoverageError'
  }
}

export interface AllocationTimeline {
  chainId: number
  vaultAddress: string
  coverage: VaultAllocationCoverage
  complete: boolean
  provisional: boolean
  sourceEventCount: number
  checkpointCount: number
  unresolvedCheckpointFailures: VaultAccountingCheckpointFailure[]
  states: AllocationState[]
}

interface CachedTimeline {
  expiresAt: number
  value: Promise<AllocationTimeline>
}

const timelineCache = new Map<string, CachedTimeline>()

export function allocationCoverageContractIssues(coverage: VaultAllocationCoverage): string[] {
  const issues: string[] = []
  if (coverage.coverageStartBlock > coverage.validatedThroughBlock) issues.push('inverted-block-range')
  if (!/^0x[a-f0-9]{64}$/.test(coverage.coverageStartBlockHash)) issues.push('invalid-coverage-start-hash')
  if (!/^0x[a-f0-9]{64}$/.test(coverage.validatedThroughBlockHash)) issues.push('invalid-validated-through-hash')
  if (!/^[a-f0-9]{40}$/.test(coverage.producerCommit)) issues.push('invalid-producer-commit')
  if (coverage.safeForTimeline) {
    const complete = [
      coverage.vaultDiscoveryComplete,
      coverage.eventHistoryComplete,
      coverage.allocatorDeploymentHistoryComplete,
      coverage.allocatorAssignmentHistoryComplete,
      coverage.checkpointTriggerAuditComplete
    ].every(Boolean)
    if (!complete) issues.push('safe-row-has-incomplete-gates')
    if (coverage.knownGaps.length > 0) issues.push('safe-row-has-known-gaps')
  }
  return issues
}

function maxReplayEvents(): number {
  const parsed = Number.parseInt(process.env.ALLOCATION_MAX_REPLAY_EVENTS ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REPLAY_EVENTS
}

function cacheKey(input: {
  chainId: number
  vaultAddress: string
  coverageRevision?: string
  allowUnsafe: boolean
}): string {
  return [input.chainId, input.vaultAddress, input.coverageRevision ?? 'configured-or-latest', input.allowUnsafe].join(
    ':'
  )
}

async function loadAllocationTimeline(input: {
  chainId: number
  vaultAddress: string
  coverageRevision?: string
  allowUnsafe: boolean
}): Promise<AllocationTimeline> {
  const coverage = await fetchAllocationCoverage(input)
  if (!coverage) {
    throw new AllocationCoverageError('No matching Envio allocation coverage row was found')
  }
  if (!coverage.safeForTimeline && !input.allowUnsafe) {
    throw new AllocationCoverageError(
      `Envio coverage revision ${coverage.coverageRevision} is not certified safe for timeline use`
    )
  }
  const coverageIssues = allocationCoverageContractIssues(coverage)
  if (coverageIssues.length > 0) {
    throw new AllocationCoverageError(`Invalid Envio allocation coverage contract: ${coverageIssues.join(', ')}`)
  }

  const range = {
    chainId: input.chainId,
    vaultAddress: input.vaultAddress,
    fromBlock: coverage.coverageStartBlock,
    toBlock: coverage.validatedThroughBlock
  }
  const [events, checkpoints, failures] = await Promise.all([
    fetchAllocationEvents({ ...range, maxEvents: maxReplayEvents() }),
    fetchAccountingCheckpoints(range),
    fetchUnresolvedCheckpointFailures(range)
  ])
  const states = buildAllocationStates(events, checkpoints)
  const complete =
    coverage.safeForTimeline && failures.length === 0 && states.length > 0 && states.every((state) => state.complete)

  return {
    chainId: input.chainId,
    vaultAddress: input.vaultAddress,
    coverage,
    complete,
    provisional: !coverage.safeForTimeline,
    sourceEventCount: events.length,
    checkpointCount: checkpoints.length,
    unresolvedCheckpointFailures: failures,
    states
  }
}

export async function getAllocationTimeline(input: {
  chainId: number
  vaultAddress: string
  coverageRevision?: string
  allowUnsafe?: boolean
}): Promise<AllocationTimeline> {
  const normalized = {
    ...input,
    vaultAddress: input.vaultAddress.toLowerCase(),
    allowUnsafe: input.allowUnsafe ?? false
  }
  const key = cacheKey(normalized)
  const cached = timelineCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = loadAllocationTimeline(normalized)
  timelineCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  try {
    return await value
  } catch (error) {
    timelineCache.delete(key)
    throw error
  }
}

export function stateAtTimestamp(timeline: AllocationTimeline, unixSeconds: number): AllocationState | null {
  let match: AllocationState | null = null
  for (const state of timeline.states) {
    if (state.blockTimestamp > unixSeconds) break
    match = state
  }
  return match
}

export function clearAllocationTimelineCache(): void {
  timelineCache.clear()
}
