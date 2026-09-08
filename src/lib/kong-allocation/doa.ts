import type { DoaOptimizationRecord } from '@/lib/doa/types'
import type { Address, AllocationSourceEvent, AllocationTransition, DoaAnnotation, DoaProposal, Hash } from './types'

export const maxDoaProposalPublishingLagHours = 24

export function doaTimestampSeconds(record: DoaOptimizationRecord): number | null {
  const value = record.freshness.optimizationTimestampUtc
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function annotation(
  record: DoaOptimizationRecord,
  proposalTimestamp: number,
  matchReason: string,
  application: DoaAnnotation['application']
): DoaAnnotation {
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
    matchReason,
    application
  }
}

function proposalAnnotation(
  record: DoaOptimizationRecord,
  proposalTimestamp: number,
  matchReason: string,
  status: DoaProposal['status']
): DoaProposal {
  const strategyTargets = record.strategyDebtRatios.map((strategy) => ({
    strategyAddress: strategy.strategy.toLowerCase() as Address,
    currentRatioBps: finite(strategy.currentRatio),
    targetRatioBps: finite(strategy.targetRatio),
    ...(strategy.currentApr === undefined ? {} : { currentApr: finite(strategy.currentApr) }),
    ...(strategy.targetApr === undefined ? {} : { targetApr: finite(strategy.targetApr) })
  }))
  return {
    sourceKey: record.source.key,
    proposalTimestamp,
    optimizerCurrentApr: finite(record.currentApr),
    optimizerProposedApr: finite(record.proposedApr),
    explain: record.explain || null,
    strategyTargets,
    matchReason,
    status
  }
}

function transitionEvents(
  transition: AllocationTransition,
  eventsById: ReadonlyMap<string, AllocationSourceEvent>
): AllocationSourceEvent[] {
  return transition.effects
    .flatMap((effect) => effect.sourceEventIds.map((id) => eventsById.get(id)))
    .filter(Boolean) as AllocationSourceEvent[]
}

function isRatioEvent(event: AllocationSourceEvent): boolean {
  return event.eventName === 'UpdateStrategyDebtRatio' || event.eventName === 'UpdateStrategyDebtRatios'
}

function proposalTargets(record: DoaOptimizationRecord): Map<string, number> {
  return new Map(record.strategyDebtRatios.map((strategy) => [strategy.strategy.toLowerCase(), strategy.targetRatio]))
}

interface ApplicationCandidate {
  score: number
  reason: string
  sourceEventIds: string[]
  transactionHash: Hash
}

function applicationCandidate(
  record: DoaOptimizationRecord,
  proposalTimestamp: number,
  transition: AllocationTransition,
  events: readonly AllocationSourceEvent[]
): ApplicationCandidate | null {
  const ratioEvents = events.filter(isRatioEvent)
  if (ratioEvents.length === 0) return null
  const distanceSeconds = Math.abs(transition.blockTimestamp - proposalTimestamp)
  if (distanceSeconds > maxDoaProposalPublishingLagHours * 3600) return null

  const targets = proposalTargets(record)
  const allMatch = ratioEvents.every((event) => {
    const target = event.strategyAddress ? targets.get(event.strategyAddress.toLowerCase()) : undefined
    const onchainTarget = Number(event.args.newTargetRatio)
    return target !== undefined && Number.isSafeInteger(onchainTarget) && target === onchainTarget
  })
  if (!allMatch) return null

  const transactionHashes = [...new Set(ratioEvents.map((event) => event.transactionHash))]
  if (transactionHashes.length !== 1) return null
  return {
    score: ratioEvents.length * 1000 - distanceSeconds / 3600,
    reason: `${ratioEvents.length} exact allocator target ratio${ratioEvents.length === 1 ? '' : 's'} matched`,
    sourceEventIds: ratioEvents.map((event) => event.id),
    transactionHash: transactionHashes[0]
  }
}

function strategySet(record: DoaOptimizationRecord): string {
  return [...new Set(record.strategyDebtRatios.map((strategy) => strategy.strategy.toLowerCase()))].sort().join(',')
}

interface AppliedPolicy {
  record: DoaOptimizationRecord
  blockNumber: number
  annotation: DoaAnnotation
}

export function processDoa(
  records: readonly DoaOptimizationRecord[],
  transitions: readonly AllocationTransition[],
  events: readonly AllocationSourceEvent[]
): { transitions: AllocationTransition[]; unappliedDoaProposals: DoaProposal[] } {
  const updated = transitions.map((transition) => ({
    ...transition,
    effects: transition.effects.map((effect) => ({ ...effect }))
  }))
  const eventsById = new Map(events.map((event) => [event.id, event]))
  const chronologicalRecords = [...records].sort(
    (left, right) => (doaTimestampSeconds(left) ?? 0) - (doaTimestampSeconds(right) ?? 0)
  )
  const appliedPolicies: AppliedPolicy[] = []

  for (const transition of updated) {
    const sourceEvents = transitionEvents(transition, eventsById)
    let best: (ApplicationCandidate & { record: DoaOptimizationRecord; proposalTimestamp: number }) | null = null
    for (const record of chronologicalRecords) {
      const proposalTimestamp = doaTimestampSeconds(record)
      if (proposalTimestamp === null) continue
      const candidate = applicationCandidate(record, proposalTimestamp, transition, sourceEvents)
      if (candidate && (!best || candidate.score > best.score)) {
        best = { record, proposalTimestamp, ...candidate }
      }
    }
    if (!best) continue
    const application: DoaAnnotation['application'] = {
      status: 'confirmed',
      blockNumber: transition.blockNumber,
      transactionHash: best.transactionHash,
      sourceEventIds: best.sourceEventIds
    }
    const doa = annotation(best.record, best.proposalTimestamp, best.reason, application)
    transition.doa = doa
    appliedPolicies.push({ record: best.record, blockNumber: transition.blockNumber, annotation: doa })
  }

  appliedPolicies.sort((left, right) => left.blockNumber - right.blockNumber)
  for (const transition of updated) {
    const active = [...appliedPolicies].reverse().find((policy) => policy.blockNumber <= transition.blockNumber)
    if (!active || transition.doa) continue
    // An old allocator policy cannot govern executions after reassignment or manager changes.
    const authorityChanged = events.some(
      (event) =>
        ['AddedNewVault', 'UpdateDebtAllocator', 'RemovedVault', 'UpdateRoleManager'].includes(event.eventName) &&
        event.blockNumber >= active.blockNumber &&
        event.blockNumber <= transition.blockNumber
    )
    if (authorityChanged) continue
    const debtEffects = transition.effects.filter((effect) =>
      effect.sourceEventIds.some((id) => eventsById.get(id)?.eventName === 'DebtUpdated')
    )
    if (debtEffects.length === 0 || transition.kind !== 'allocator_execution') continue
    transition.kind = 'doa_execution'
    transition.doa = {
      ...active.annotation,
      matchReason: `Active policy applied at block ${active.blockNumber}; allocator execution path matched`
    }
    transition.effects = transition.effects.map((effect) =>
      debtEffects.includes(effect) ? { ...effect, kind: 'doa_execution' as const } : effect
    )
  }

  const appliedRecords = new Set(appliedPolicies.map((policy) => policy.record))
  const unappliedDoaProposals = chronologicalRecords.flatMap((record) => {
    if (appliedRecords.has(record)) return []
    const proposalTimestamp = doaTimestampSeconds(record)
    if (proposalTimestamp === null) return []
    const superseded = chronologicalRecords.some((candidate) => {
      const candidateTimestamp = doaTimestampSeconds(candidate)
      return (
        candidateTimestamp !== null &&
        candidateTimestamp > proposalTimestamp &&
        strategySet(candidate) === strategySet(record)
      )
    })
    return [
      proposalAnnotation(
        record,
        proposalTimestamp,
        'No exact on-chain allocator configuration application was indexed',
        superseded ? 'superseded' : 'unmatched'
      )
    ]
  })
  return { transitions: updated, unappliedDoaProposals }
}
