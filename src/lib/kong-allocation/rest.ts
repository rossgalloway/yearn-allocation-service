import type { DoaOptimizationRecord } from '@/lib/doa/types'
import { doaTimestampSeconds } from './doa'
import type {
  Address,
  AllocationEntryPolicy,
  AllocationEntryState,
  AllocationEntryStrategyChange,
  AllocationHistoryEntry,
  AllocationHistoryEntryKind,
  AllocationHistoryStrategy,
  AllocationState,
  AllocationStateStrategy,
  AllocationTransition,
  AllocationTransitionEffect,
  NormalizedAllocationTimeline,
  TimelineDirection,
  VaultAllocationHistoryResponse
} from './types'

const EXECUTION_GROUP_MAX_SECONDS = 60 * 60

interface EntryCandidate {
  transition: AllocationTransition
  kind: AllocationHistoryEntryKind
}

function active(strategy: AllocationStateStrategy | undefined): boolean | null {
  if (!strategy || strategy.activation === null) return null
  return strategy.activation > 0
}

function signedDelta(before: string | null, after: string | null): string | null {
  if (before === null || after === null || !/^\d+$/.test(before) || !/^\d+$/.test(after)) return null
  return (BigInt(after) - BigInt(before)).toString()
}

function accountingChecks(state: AllocationState): AllocationEntryState['accountingChecks'] {
  const strategyDebt = state.strategies.reduce((sum, strategy) => sum + BigInt(strategy.currentDebt), 0n)
  const identity =
    state.totalIdle === null ? null : BigInt(state.totalDebt) + BigInt(state.totalIdle) === BigInt(state.totalAssets)
  return {
    totalAssetsEqualsDebtPlusIdle: identity,
    strategyDebtSumEqualsTotalDebt: strategyDebt === BigInt(state.totalDebt)
  }
}

function entryState(state: AllocationState, names: ReadonlyMap<Address, string | null>): AllocationEntryState {
  return {
    blockNumber: state.blockNumber,
    blockTimestamp: state.blockTimestamp,
    source: 'archive_rpc',
    totalAssets: state.totalAssets,
    totalDebt: state.totalDebt,
    totalIdle: state.totalIdle,
    unallocatedBps: state.unallocatedBps,
    allocatorAddress: state.allocatorAddress,
    allocations: state.strategies.map((strategy) => ({
      strategyAddress: strategy.strategyAddress,
      strategyName: names.get(strategy.strategyAddress) ?? null,
      active: active(strategy),
      currentDebt: strategy.currentDebt,
      currentDebtBps: strategy.currentDebtBps,
      maxDebt: strategy.maxDebt,
      maxDebtBps: strategy.maxDebtBps,
      targetDebtRatioBps: strategy.targetDebtRatioBps,
      maxDebtRatioBps: strategy.maxDebtRatioBps,
      allocatorAdded: strategy.allocatorAdded
    })),
    accountingChecks: accountingChecks(state)
  }
}

function stateStrategyMap(state: AllocationState | null): Map<Address, AllocationStateStrategy> {
  return new Map(state?.strategies.map((strategy) => [strategy.strategyAddress, strategy]) ?? [])
}

function strategyChanges(
  before: AllocationState | null,
  after: AllocationState,
  names: ReadonlyMap<Address, string | null>
): AllocationEntryStrategyChange[] {
  const beforeStrategies = stateStrategyMap(before)
  const afterStrategies = stateStrategyMap(after)
  const addresses = [...new Set([...beforeStrategies.keys(), ...afterStrategies.keys()])].sort()
  return addresses.flatMap((strategyAddress): AllocationEntryStrategyChange[] => {
    const previous = beforeStrategies.get(strategyAddress)
    const next = afterStrategies.get(strategyAddress)
    const changed =
      previous?.currentDebt !== next?.currentDebt ||
      previous?.currentDebtBps !== next?.currentDebtBps ||
      previous?.targetDebtRatioBps !== next?.targetDebtRatioBps ||
      previous?.maxDebtRatioBps !== next?.maxDebtRatioBps ||
      active(previous) !== active(next)
    if (!changed) return []
    return [
      {
        strategyAddress,
        strategyName: names.get(strategyAddress) ?? null,
        currentDebtBefore: previous?.currentDebt ?? null,
        currentDebtAfter: next?.currentDebt ?? null,
        currentDebtDelta: signedDelta(previous?.currentDebt ?? null, next?.currentDebt ?? null),
        currentDebtBpsBefore: previous?.currentDebtBps ?? null,
        currentDebtBpsAfter: next?.currentDebtBps ?? null,
        currentDebtBpsDelta: previous && next ? next.currentDebtBps - previous.currentDebtBps : null,
        targetDebtRatioBpsBefore: previous?.targetDebtRatioBps ?? null,
        targetDebtRatioBpsAfter: next?.targetDebtRatioBps ?? null,
        maxDebtRatioBpsBefore: previous?.maxDebtRatioBps ?? null,
        maxDebtRatioBpsAfter: next?.maxDebtRatioBps ?? null,
        activeBefore: active(previous),
        activeAfter: active(next)
      }
    ]
  })
}

function hasAllocationChange(before: AllocationState | null, after: AllocationState): boolean {
  if (!before) return true
  if (before.totalDebt !== after.totalDebt || before.totalIdle !== after.totalIdle) return true
  return strategyChanges(before, after, new Map()).length > 0
}

function debtEffects(transition: AllocationTransition): AllocationTransitionEffect[] {
  const debtKinds = new Set([
    'doa_execution',
    'allocator_execution',
    'deposit_driven_debt_update',
    'withdrawal_driven_debt_update',
    'manual_debt_update',
    'bad_debt_purchase'
  ])
  return transition.effects.filter((effect) => debtKinds.has(effect.kind))
}

function allocatorAddresses(
  transition: AllocationTransition,
  before: AllocationState | null,
  after: AllocationState
): Set<Address> {
  return new Set(
    [
      before?.allocatorAddress,
      after.allocatorAddress,
      ...transition.effects.flatMap((effect) => effect.triggerReplays?.map((replay) => replay.allocatorAddress) ?? [])
    ].filter((value): value is Address => value !== null && value !== undefined)
  )
}

function usesAllocator(effect: AllocationTransitionEffect, knownAllocators: ReadonlySet<Address>): boolean {
  return (
    (effect.triggerReplays?.length ?? 0) > 0 ||
    effect.executionContext.callPath.some((item) => knownAllocators.has(item))
  )
}

function hasPrivilegedOriginator(effect: AllocationTransitionEffect): boolean {
  return ['doa_keeper', 'debt_allocator_keeper', 'governance', 'role_manager', 'vault_role_holder'].includes(
    effect.actor.role
  )
}

function hasWithdrawalContext(effect: AllocationTransitionEffect): boolean {
  return effect.vaultActivities?.some((activity) => activity.kind === 'withdrawal') === true
}

function isPureWithdrawalServicing(
  transition: AllocationTransition,
  effects: readonly AllocationTransitionEffect[]
): boolean {
  if (effects.length === 0 || !effects.every(hasWithdrawalContext)) return false
  if (effects.some(hasPrivilegedOriginator)) return false
  return !transition.effects.some((effect) =>
    [
      'allocator_execution',
      'doa_execution',
      'manual_config_change',
      'strategy_lifecycle_change',
      'bad_debt_purchase'
    ].includes(effect.kind)
  )
}

function entryKind(
  transition: AllocationTransition,
  before: AllocationState | null,
  after: AllocationState
): AllocationHistoryEntryKind | null {
  if (transition.kind === 'current_live_tail') return 'current_snapshot'
  if (!hasAllocationChange(before, after) && !transition.doa) return null
  if (transition.doa?.application.blockNumber === transition.blockNumber) return 'proposal_application'

  const effectKinds = new Set(transition.effects.map((effect) => effect.kind))
  if (effectKinds.has('bad_debt_purchase')) return 'bad_debt_purchase'
  if (effectKinds.has('manual_config_change')) return 'configuration_change'
  if (effectKinds.has('strategy_lifecycle_change')) return 'strategy_lifecycle_change'

  const effects = debtEffects(transition)
  if (effects.length > 0) {
    const allocators = allocatorAddresses(transition, before, after)
    const allocatorPath = effects.some((effect) => usesAllocator(effect, allocators))
    const replayResults = effects.flatMap((effect) => effect.triggerReplays ?? [])
    if (allocatorPath || transition.kind === 'allocator_execution' || transition.kind === 'doa_execution') {
      return replayResults.some((replay) => replay.status === 'not_matched')
        ? 'allocator_override'
        : 'target_maintenance'
    }
    const directDebtManager = effects.some(
      (effect) => effect.executionContext.immediateVaultCallerHasDebtManagerRole === true
    )
    if (directDebtManager) return 'manual_role_reallocation'
    if (isPureWithdrawalServicing(transition, effects)) return null
    if (effects.every((effect) => effect.kind === 'deposit_driven_debt_update')) {
      return 'deposit_driven_debt_update'
    }
    return 'unattributed_debt_update'
  }
  if (
    transition.kind === 'report_only_state_change' ||
    transition.kind === 'vault_deposit' ||
    transition.kind === 'vault_withdrawal'
  ) {
    return null
  }
  return 'unknown'
}

function executionFingerprint(transition: AllocationTransition): string {
  return transition.effects
    .map((effect) => {
      const allocator = effect.triggerReplays?.[0]?.allocatorAddress ?? ''
      return [
        effect.actor.address ?? '',
        effect.executionContext.immediateVaultCaller ?? '',
        allocator,
        effect.transactionTo ?? ''
      ].join(':')
    })
    .sort()
    .join('|')
}

function policyFingerprint(state: AllocationState | null): string {
  if (!state) return ''
  return state.strategies
    .map((strategy) =>
      [strategy.strategyAddress, strategy.targetDebtRatioBps ?? '', strategy.maxDebtRatioBps ?? ''].join(':')
    )
    .sort()
    .join('|')
}

function allTriggersMatched(transition: AllocationTransition): boolean {
  const replays = transition.effects.flatMap((effect) => effect.triggerReplays ?? [])
  return replays.length > 0 && replays.every((replay) => replay.status === 'matched')
}

function canGroup(
  current: readonly EntryCandidate[],
  next: EntryCandidate,
  states: ReadonlyMap<string, AllocationState>
): boolean {
  const last = current.at(-1)
  if (!last || last.kind !== next.kind) return false
  if (!['target_maintenance', 'manual_role_reallocation', 'allocator_override'].includes(next.kind)) return false
  if (next.transition.blockTimestamp - last.transition.blockTimestamp > EXECUTION_GROUP_MAX_SECONDS) return false
  if (executionFingerprint(last.transition) !== executionFingerprint(next.transition)) return false
  const lastBefore = last.transition.fromStateId ? (states.get(last.transition.fromStateId) ?? null) : null
  const nextBefore = next.transition.fromStateId ? (states.get(next.transition.fromStateId) ?? null) : null
  if (policyFingerprint(lastBefore) !== policyFingerprint(nextBefore)) return false
  if (next.kind === 'target_maintenance') {
    return allTriggersMatched(last.transition) && allTriggersMatched(next.transition)
  }
  if (next.kind === 'manual_role_reallocation') {
    return debtEffects(last.transition).every(
      (effect) => effect.executionContext.immediateVaultCallerHasDebtManagerRole === true
    )
  }
  return false
}

function groupCandidates(
  transitions: readonly AllocationTransition[],
  states: ReadonlyMap<string, AllocationState>
): EntryCandidate[][] {
  const groups: EntryCandidate[][] = []
  let current: EntryCandidate[] = []
  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
  }

  for (const transition of [...transitions].sort((left, right) => left.blockNumber - right.blockNumber)) {
    const before = transition.fromStateId ? (states.get(transition.fromStateId) ?? null) : null
    const after = states.get(transition.toStateId)
    if (!after) continue
    const kind = entryKind(transition, before, after)
    if (!kind) {
      flush()
      continue
    }
    const candidate = { transition, kind }
    if (!canGroup(current, candidate, states)) flush()
    current.push(candidate)
  }
  flush()
  return groups
}

function strategyNameMap(strategies: readonly AllocationHistoryStrategy[]): Map<Address, string | null> {
  return new Map(strategies.map((strategy) => [strategy.address, strategy.name]))
}

function inferredPolicyRecord(
  records: readonly DoaOptimizationRecord[],
  state: AllocationState | null,
  entryTimestamp: number
): DoaOptimizationRecord | null {
  if (!state) return null
  const strategies = new Map(state.strategies.map((strategy) => [strategy.strategyAddress, strategy]))
  const candidates = records.filter((record) => {
    const publishedAt = doaTimestampSeconds(record)
    if (publishedAt === null || publishedAt > entryTimestamp || record.strategyDebtRatios.length === 0) return false
    return record.strategyDebtRatios.every((target) => {
      const strategy = strategies.get(target.strategy.toLowerCase() as Address)
      return strategy?.targetDebtRatioBps === target.targetRatio
    })
  })
  return (
    candidates.sort((left, right) => (doaTimestampSeconds(right) ?? 0) - (doaTimestampSeconds(left) ?? 0))[0] ?? null
  )
}

function policy(
  group: readonly EntryCandidate[],
  before: AllocationState | null,
  after: AllocationState,
  records: readonly DoaOptimizationRecord[],
  names: ReadonlyMap<Address, string | null>
): AllocationEntryPolicy | null {
  const confirmed = group.map((candidate) => candidate.transition.doa).find((value) => value !== undefined)
  const strategyState = stateStrategyMap(before ?? after)
  if (confirmed) {
    return {
      id: `allocation-policy:${confirmed.sourceKey}`,
      source: 'doa',
      proposal: {
        sourceKey: confirmed.sourceKey,
        publishedAt: confirmed.proposalTimestamp,
        optimizerCurrentApr: confirmed.optimizerCurrentApr,
        optimizerProposedApr: confirmed.optimizerProposedApr,
        explain: confirmed.explain
      },
      application: confirmed.application,
      targets: confirmed.strategyTargets.map((target) => ({
        ...target,
        strategyName: names.get(target.strategyAddress) ?? null,
        maxRatioBps: strategyState.get(target.strategyAddress)?.maxDebtRatioBps ?? null
      }))
    }
  }

  if (!group.every((candidate) => candidate.kind === 'target_maintenance')) return null
  const inferred = inferredPolicyRecord(records, before, group[0].transition.blockTimestamp)
  const publishedAt = inferred ? doaTimestampSeconds(inferred) : null
  if (!inferred || publishedAt === null) return null
  return {
    id: `allocation-policy:${inferred.source.key}`,
    source: 'doa',
    proposal: {
      sourceKey: inferred.source.key,
      publishedAt,
      optimizerCurrentApr: Number.isFinite(inferred.currentApr) ? inferred.currentApr : null,
      optimizerProposedApr: Number.isFinite(inferred.proposedApr) ? inferred.proposedApr : null,
      explain: inferred.explain || null
    },
    application: {
      status: 'inferred_from_historical_config',
      blockNumber: null,
      transactionHash: null,
      sourceEventIds: []
    },
    targets: inferred.strategyDebtRatios.map((target) => {
      const strategyAddress = target.strategy.toLowerCase() as Address
      return {
        strategyAddress,
        strategyName: names.get(strategyAddress) ?? null,
        currentRatioBps: Number.isFinite(target.currentRatio) ? target.currentRatio : null,
        targetRatioBps: Number.isFinite(target.targetRatio) ? target.targetRatio : null,
        maxRatioBps: strategyState.get(strategyAddress)?.maxDebtRatioBps ?? null,
        ...(target.currentApr === undefined
          ? {}
          : { currentApr: Number.isFinite(target.currentApr) ? target.currentApr : null }),
        ...(target.targetApr === undefined
          ? {}
          : { targetApr: Number.isFinite(target.targetApr) ? target.targetApr : null })
      }
    })
  }
}

function classification(
  group: readonly EntryCandidate[],
  entryPolicy: AllocationEntryPolicy | null
): AllocationHistoryEntry['classification'] {
  const kind = group[0].kind
  const effects = group.flatMap((candidate) => candidate.transition.effects)
  const replays = effects.flatMap((effect) => effect.triggerReplays ?? [])
  const evidence = ['archive RPC before/after accounting snapshots']
  const limitations: string[] = []
  if (group.length > 1) evidence.push(`${group.length} state-continuous execution steps grouped`)
  if (effects.length > 0 && effects.every((effect) => effect.executionContext.traceStatus === 'available')) {
    evidence.push('archive RPC transaction call paths resolved')
  } else if (effects.length > 0) {
    limitations.push('one or more transaction call traces were unavailable')
  }
  if (replays.length > 0 && replays.every((replay) => replay.status === 'matched')) {
    evidence.push('historical allocator trigger replay matched every executed target within the disclosed tolerance')
  } else if (kind === 'target_maintenance') {
    limitations.push('allocator trigger replay was incomplete')
  }
  if (kind === 'manual_role_reallocation') {
    evidence.push('immediate vault caller held DEBT_MANAGER at the execution block')
  }
  if (entryPolicy?.application.status === 'confirmed') {
    evidence.push('Envio indexed the exact allocator policy application')
  } else if (entryPolicy?.application.status === 'inferred_from_historical_config') {
    evidence.push('historical allocator targets exactly match the DOA proposal')
    limitations.push('Envio did not provide the exact shared-allocator application event')
  }

  const confidence =
    kind === 'unattributed_debt_update' || kind === 'unknown'
      ? 'low'
      : kind === 'allocator_override' || limitations.some((item) => item.includes('trigger replay'))
        ? 'medium'
        : 'high'
  return { confidence, evidence, limitations }
}

function entry(
  chainId: number,
  vaultAddress: Address,
  group: readonly EntryCandidate[],
  states: ReadonlyMap<string, AllocationState>,
  records: readonly DoaOptimizationRecord[],
  names: ReadonlyMap<Address, string | null>
): AllocationHistoryEntry | null {
  const first = group[0].transition
  const last = group.at(-1)?.transition ?? first
  const isCurrent = group[0].kind === 'current_snapshot'
  const beforeState = isCurrent || !first.fromStateId ? null : (states.get(first.fromStateId) ?? null)
  const afterState = states.get(last.toStateId)
  if (!afterState) return null
  const entryPolicy = policy(group, beforeState, afterState, records, names)
  const transactions = group.flatMap((candidate) =>
    candidate.transition.effects.map((effect) => ({
      transactionHash: effect.transactionHash,
      blockNumber: candidate.transition.blockNumber,
      blockTimestamp: candidate.transition.blockTimestamp,
      kind: effect.kind,
      originator: effect.actor,
      transactionTarget: effect.transactionTo,
      inputSelector: effect.inputSelector,
      callPath: effect.executionContext.callPath,
      traceStatus: effect.executionContext.traceStatus,
      immediateVaultCaller: effect.executionContext.immediateVaultCaller,
      authorization: {
        role: 'DEBT_MANAGER' as const,
        roleMask: effect.executionContext.immediateVaultCallerRoleMask,
        confirmedAtBlock: effect.executionContext.immediateVaultCallerHasDebtManagerRole
      },
      sourceEventIds: effect.sourceEventIds,
      triggerReplays: effect.triggerReplays ?? [],
      ...(effect.vaultActivities ? { vaultActivities: effect.vaultActivities } : {})
    }))
  )
  const changes = isCurrent
    ? { totalDebtDelta: null, totalIdleDelta: null, strategies: [] }
    : {
        totalDebtDelta: signedDelta(beforeState?.totalDebt ?? null, afterState.totalDebt),
        totalIdleDelta: signedDelta(beforeState?.totalIdle ?? null, afterState.totalIdle),
        strategies: strategyChanges(beforeState, afterState, names)
      }
  return {
    id: `allocation-entry:${chainId}:${vaultAddress.toLowerCase()}:${first.blockNumber}-${last.blockNumber}`,
    kind: group[0].kind,
    startBlock: first.blockNumber,
    endBlock: last.blockNumber,
    startTimestamp: first.blockTimestamp,
    endTimestamp: last.blockTimestamp,
    before: beforeState ? entryState(beforeState, names) : null,
    after: entryState(afterState, names),
    changes,
    policy: entryPolicy,
    execution: { transactions },
    classification: classification(group, entryPolicy),
    detailsAvailable: false
  }
}

export function buildRestAllocationHistory(input: {
  timeline: NormalizedAllocationTimeline
  doaRecords: readonly DoaOptimizationRecord[]
  direction: TimelineDirection
  limit: number
  hasMore: boolean
}): VaultAllocationHistoryResponse {
  const states = new Map(input.timeline.states.map((state) => [state.id, state]))
  const names = strategyNameMap(input.timeline.strategies)
  const matchingEntries = groupCandidates(input.timeline.transitions, states)
    .map((group) =>
      entry(input.timeline.vault.chainId, input.timeline.vault.address, group, states, input.doaRecords, names)
    )
    .filter((value): value is AllocationHistoryEntry => value !== null)
    .sort((left, right) => {
      const multiplier = input.direction === 'asc' ? 1 : -1
      return multiplier * (left.endBlock - right.endBlock) || multiplier * left.id.localeCompare(right.id)
    })
  const entries = matchingEntries.slice(0, input.limit)

  return {
    schemaVersion: 2,
    generatedAt: input.timeline.generatedAt,
    direction: input.direction,
    vault: input.timeline.vault,
    entries,
    pagination: {
      limit: input.limit,
      returned: entries.length,
      hasMore: input.hasMore || matchingEntries.length > entries.length
    }
  }
}
