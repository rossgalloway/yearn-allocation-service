import type { DoaOptimizationRecord } from '@/lib/doa/types'
import { knownDoaKeeper } from './known-actors'
import type { Address, AllocationSourceEvent, AllocationTransition, DoaAnnotation, DoaProposal } from './types'

export const maxDoaProposalPublishingLagHours = 24
export const expectedDoaProposalExecutionWindowHours = 72
export const staleDoaProposalThresholdDays = 30

function timestampSeconds(record: DoaOptimizationRecord): number | null {
  const value = record.freshness.optimizationTimestampUtc
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function annotation(record: DoaOptimizationRecord, proposalTimestamp: number, matchReason: string): DoaAnnotation {
  return {
    sourceKey: record.source.key,
    proposalTimestamp,
    optimizerCurrentApr: finite(record.currentApr),
    optimizerProposedApr: finite(record.proposedApr),
    explain: record.explain || null,
    strategyTargets: record.strategyDebtRatios.map((strategy) => ({
      strategyAddress: strategy.strategy.toLowerCase() as Address,
      currentRatioBps: finite(strategy.currentRatio),
      targetRatioBps: finite(strategy.targetRatio),
      ...(strategy.currentApr === undefined ? {} : { currentApr: finite(strategy.currentApr) }),
      ...(strategy.targetApr === undefined ? {} : { targetApr: finite(strategy.targetApr) })
    })),
    matchReason
  }
}

function decimal(value: unknown): bigint | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null
}

function transitionEvents(
  transition: AllocationTransition,
  eventsById: ReadonlyMap<string, AllocationSourceEvent>
): AllocationSourceEvent[] {
  return transition.effects
    .flatMap((effect) => effect.sourceEventIds.map((id) => eventsById.get(id)))
    .filter(Boolean) as AllocationSourceEvent[]
}

function proposalTargets(record: DoaOptimizationRecord): Map<string, { current: number; target: number }> {
  return new Map(
    record.strategyDebtRatios.map((strategy) => [
      strategy.strategy.toLowerCase(),
      { current: strategy.currentRatio, target: strategy.targetRatio }
    ])
  )
}

function candidateScore(
  record: DoaOptimizationRecord,
  proposalTimestamp: number,
  transition: AllocationTransition,
  events: readonly AllocationSourceEvent[]
): { score: number; reason: string } | null {
  const debtEvents = events.filter((event) => event.eventName === 'DebtUpdated')
  if (debtEvents.length === 0) return null
  const earliest = proposalTimestamp - maxDoaProposalPublishingLagHours * 3600
  const latest = proposalTimestamp + expectedDoaProposalExecutionWindowHours * 3600
  if (transition.blockTimestamp < earliest || transition.blockTimestamp > latest) return null

  const targets = proposalTargets(record)
  const ratioEvents = events.filter((event) => event.eventName === 'UpdateStrategyDebtRatios')
  const exactRatioMatch =
    ratioEvents.length > 0 &&
    ratioEvents.every((event) => {
      const strategy = event.strategyAddress ? targets.get(event.strategyAddress.toLowerCase()) : undefined
      const onchainTarget = Number(event.args.newTargetRatio)
      return strategy !== undefined && Number.isSafeInteger(onchainTarget) && strategy.target === onchainTarget
    })

  let matchingDirections = 0
  let conflictingDirections = 0
  for (const event of debtEvents) {
    if (!event.strategyAddress) continue
    const target = targets.get(event.strategyAddress.toLowerCase())
    const currentDebt = decimal(event.args.currentDebt)
    const newDebt = decimal(event.args.newDebt)
    if (!target || currentDebt === null || newDebt === null) continue
    const debtDirection = newDebt === currentDebt ? 0 : newDebt > currentDebt ? 1 : -1
    const targetDirection = target.target === target.current ? 0 : target.target > target.current ? 1 : -1
    if (debtDirection === 0 || targetDirection === 0) continue
    if (debtDirection === targetDirection) matchingDirections += 1
    else conflictingDirections += 1
  }
  const hasKnownDoaKeeper = debtEvents.some(
    (event) => knownDoaKeeper(record.source.chainId, event.transactionFrom) !== null
  )
  const keeperDirectionMatch = hasKnownDoaKeeper && matchingDirections > 0 && conflictingDirections === 0
  // Direction and timing are too weak on their own in a busy vault. Exact
  // allocator ratios remain the strongest signal; the documented TKS keeper
  // path is also sufficient when the affected strategy direction agrees.
  if (!exactRatioMatch && !keeperDirectionMatch) return null

  const distanceHours = Math.abs(transition.blockTimestamp - proposalTimestamp) / 3600
  const score = (exactRatioMatch ? 1000 : 0) + (hasKnownDoaKeeper ? 500 : 0) + matchingDirections * 10 - distanceHours
  const signals = [
    exactRatioMatch ? 'allocator target ratios matched' : null,
    hasKnownDoaKeeper ? 'known DOA keeper path matched' : null,
    matchingDirections > 0
      ? `${matchingDirections} debt direction${matchingDirections === 1 ? '' : 's'} matched`
      : null,
    `${distanceHours.toFixed(1)}h from proposal`
  ].filter(Boolean)
  return { score, reason: signals.join('; ') }
}

function strategySet(record: DoaOptimizationRecord): string {
  return [...new Set(record.strategyDebtRatios.map((strategy) => strategy.strategy.toLowerCase()))].sort().join(',')
}

function pendingStatus(
  record: DoaOptimizationRecord,
  proposalTimestamp: number,
  records: readonly DoaOptimizationRecord[],
  now: number
): DoaProposal['status'] {
  const superseded = records.some((candidate) => {
    const candidateTimestamp = timestampSeconds(candidate)
    return (
      candidateTimestamp !== null &&
      candidateTimestamp > proposalTimestamp &&
      strategySet(candidate) === strategySet(record)
    )
  })
  if (superseded) return 'stale'
  const age = Math.max(0, now - proposalTimestamp)
  if (age <= expectedDoaProposalExecutionWindowHours * 3600) return 'pending'
  if (age <= staleDoaProposalThresholdDays * 24 * 3600) return 'unmatched'
  return 'stale'
}

export function processDoa(
  records: readonly DoaOptimizationRecord[],
  transitions: readonly AllocationTransition[],
  events: readonly AllocationSourceEvent[],
  now: number
): { transitions: AllocationTransition[]; pendingDoaProposals: DoaProposal[] } {
  const updated = transitions.map((transition) => ({
    ...transition,
    effects: transition.effects.map((effect) => ({ ...effect }))
  }))
  const eventsById = new Map(events.map((event) => [event.id, event]))
  const matchedRecords = new Set<DoaOptimizationRecord>()
  const chronological = [...records].sort(
    (left, right) => (timestampSeconds(left) ?? 0) - (timestampSeconds(right) ?? 0)
  )

  for (const transition of updated) {
    if (transition.kind === 'current_live_tail') continue
    let best: { record: DoaOptimizationRecord; proposalTimestamp: number; score: number; reason: string } | null = null
    for (const record of chronological) {
      const proposalTimestamp = timestampSeconds(record)
      if (proposalTimestamp === null) continue
      const score = candidateScore(record, proposalTimestamp, transition, transitionEvents(transition, eventsById))
      if (
        score &&
        (!best ||
          score.score > best.score ||
          (score.score === best.score && proposalTimestamp > best.proposalTimestamp))
      ) {
        best = { record, proposalTimestamp, ...score }
      }
    }
    if (!best) continue

    transition.kind = 'doa_execution'
    transition.doa = annotation(best.record, best.proposalTimestamp, best.reason)
    transition.effects = transition.effects.map((effect) => {
      const hasDebtUpdate = effect.sourceEventIds.some((id) => eventsById.get(id)?.eventName === 'DebtUpdated')
      return hasDebtUpdate ? { ...effect, kind: 'doa_execution' as const } : effect
    })
    matchedRecords.add(best.record)
  }

  const pendingDoaProposals = chronological.flatMap((record) => {
    if (matchedRecords.has(record)) return []
    const proposalTimestamp = timestampSeconds(record)
    if (proposalTimestamp === null) return []
    return [
      {
        ...annotation(record, proposalTimestamp, 'No qualifying on-chain debt transition matched this proposal'),
        status: pendingStatus(record, proposalTimestamp, chronological, now)
      }
    ]
  })
  return { transitions: updated, pendingDoaProposals }
}
