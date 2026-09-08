import type { DoaOptimizationRecord } from '@/lib/doa/types'
import { doaTimestampSeconds } from './doa'
import type {
  Address,
  AllocationEntryOperation,
  AllocationEntryOperationValue,
  AllocationEntryPolicy,
  AllocationEntryState,
  AllocationEntryStrategyChange,
  AllocationHistoryEntry,
  AllocationHistoryEntryKind,
  AllocationHistoryStrategy,
  AllocationSourceEvent,
  AllocationState,
  AllocationStateStrategy,
  AllocationTransition,
  AllocationTransitionEffect,
  NormalizedAllocationTimeline,
  TimelineDirection,
  VaultAllocationHistoryResponse
} from './types'

const EXECUTION_GROUP_MAX_SECONDS = 60 * 60
const SAFE_EXEC_TRANSACTION_SELECTOR = '0x6a761202'
const ALLOCATOR_CONFIGURATION_EVENTS = new Set(['UpdateStrategyDebtRatio', 'UpdateStrategyDebtRatios'])
const VAULT_CONFIGURATION_EVENTS = new Set([
  'UpdateDefaultQueue',
  'UpdateUseDefaultQueue',
  'RoleSet',
  'RoleStatusChanged',
  'UpdateRoleManager',
  'UpdateAccountant',
  'UpdateDebtAllocator',
  'NewDebtAllocator',
  'UpdateKeeper',
  'GovernanceTransferred'
])

interface EntryCandidate {
  transition: AllocationTransition
  kind: CandidateKind
}

type CandidateKind =
  | 'current_snapshot'
  | 'policy_application'
  | 'allocator_target_execution'
  | 'allocator_override'
  | 'manual_role_execution'
  | 'unattributed_debt_update'
  | 'configuration_change'
  | 'strategy_lifecycle_change'
  | 'bad_debt_purchase'
  | 'unknown'

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
    unallocatedSource: state.unallocatedSource,
    unallocatedCheckpointId: state.unallocatedCheckpointId,
    allocatorAddress: state.allocatorAddress,
    allocatorResolution: state.allocatorResolution,
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
      previous?.maxDebt !== next?.maxDebt ||
      previous?.currentDebtBps !== next?.currentDebtBps ||
      previous?.maxDebtBps !== next?.maxDebtBps ||
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
        maxDebtBefore: previous?.maxDebt ?? null,
        maxDebtAfter: next?.maxDebt ?? null,
        maxDebtDelta: signedDelta(previous?.maxDebt ?? null, next?.maxDebt ?? null),
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

function candidateKind(
  transition: AllocationTransition,
  before: AllocationState | null,
  after: AllocationState
): CandidateKind | null {
  if (transition.kind === 'current_live_tail') return 'current_snapshot'
  const effectKinds = new Set(transition.effects.map((effect) => effect.kind))
  if (
    !hasAllocationChange(before, after) &&
    !transition.doa &&
    !effectKinds.has('manual_config_change') &&
    !effectKinds.has('strategy_lifecycle_change')
  ) {
    return null
  }
  if (transition.doa?.application.blockNumber === transition.blockNumber) return 'policy_application'

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
        : 'allocator_target_execution'
    }
    const directDebtManager = effects.some(
      (effect) => effect.executionContext.immediateVaultCallerHasDebtManagerRole === true
    )
    if (directDebtManager) return 'manual_role_execution'
    if (isPureWithdrawalServicing(transition, effects)) return null
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
  return (
    `${state.allocatorResolution?.assignmentId ?? state.allocatorAddress ?? ''}|` +
    state.strategies
      .map((strategy) =>
        [strategy.strategyAddress, strategy.targetDebtRatioBps ?? '', strategy.maxDebtRatioBps ?? ''].join(':')
      )
      .sort()
      .join('|')
  )
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
  if (!['allocator_target_execution', 'manual_role_execution', 'allocator_override'].includes(next.kind)) return false
  if (next.transition.blockTimestamp - last.transition.blockTimestamp > EXECUTION_GROUP_MAX_SECONDS) return false
  if (executionFingerprint(last.transition) !== executionFingerprint(next.transition)) return false
  const lastBefore = last.transition.fromStateId ? (states.get(last.transition.fromStateId) ?? null) : null
  const nextBefore = next.transition.fromStateId ? (states.get(next.transition.fromStateId) ?? null) : null
  if (policyFingerprint(lastBefore) !== policyFingerprint(nextBefore)) return false
  if (next.kind === 'allocator_target_execution') {
    return allTriggersMatched(last.transition) && allTriggersMatched(next.transition)
  }
  if (next.kind === 'manual_role_execution') {
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
    const kind = candidateKind(transition, before, after)
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

  if (!group.every((candidate) => candidate.kind === 'allocator_target_execution')) return null
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
  kind: AllocationHistoryEntryKind,
  execution: Omit<AllocationHistoryEntry['execution'], 'transactions'>,
  entryPolicy: AllocationEntryPolicy | null,
  doaRecordsAvailable: boolean,
  materializationLimitations: readonly string[]
): AllocationHistoryEntry['classification'] {
  const candidateKind = group[0].kind
  const effects = group.flatMap((candidate) => candidate.transition.effects)
  const replays = effects.flatMap((effect) => effect.triggerReplays ?? [])
  const evidence = ['archive RPC before/after accounting snapshots']
  const limitations: string[] = []
  limitations.push(...materializationLimitations)
  if (!doaRecordsAvailable) limitations.push('DOA proposal enrichment was unavailable during materialization')
  if (group.length > 1) evidence.push(`${group.length} state-continuous execution steps grouped`)
  if (effects.length > 0 && effects.every((effect) => effect.executionContext.traceStatus === 'available')) {
    evidence.push('archive RPC transaction call paths resolved')
  } else if (effects.length > 0) {
    limitations.push('one or more transaction call traces were unavailable')
  }
  if (replays.length > 0 && replays.every((replay) => replay.status === 'matched')) {
    evidence.push('historical allocator trigger replay matched every executed target within the disclosed tolerance')
  } else if (
    candidateKind === 'allocator_target_execution' &&
    execution.mechanism === 'allocator_keeper' &&
    execution.targetStatus === 'unavailable'
  ) {
    limitations.push('allocator trigger replay was incomplete')
  }
  if (candidateKind === 'manual_role_execution') {
    evidence.push('immediate vault caller held DEBT_MANAGER at the execution block')
  }
  if (entryPolicy?.application.status === 'confirmed') {
    evidence.push('Envio indexed the exact allocator policy application')
  } else if (entryPolicy?.application.status === 'inferred_from_historical_config') {
    evidence.push('historical allocator targets exactly match the DOA proposal')
    limitations.push('Envio did not provide the exact shared-allocator application event')
  }
  if (kind === 'idle_deployment') {
    evidence.push('whole-entry strategy debt increased without a strategy debt decrease')
  } else if (kind === 'idle_deallocation') {
    evidence.push('whole-entry strategy debt decreased without a strategy debt increase')
  } else if (kind === 'strategy_reallocation') {
    evidence.push('whole-entry strategy debt includes both decreases and increases')
  }
  if (execution.automation === 'automatic') {
    evidence.push('allocator keeper followed the historical allocator recommendation')
  } else if (execution.automation === 'manual') {
    evidence.push(`execution amount was selected manually through ${execution.mechanism ?? 'an unknown mechanism'}`)
  } else if (execution.automation === 'unknown' && effects.length > 0) {
    limitations.push('execution automation could not be determined')
  }

  const confidence =
    kind === 'unattributed_debt_update' || kind === 'unknown'
      ? 'low'
      : execution.targetStatus === 'overridden' || limitations.some((item) => item.includes('trigger replay'))
        ? 'medium'
        : 'high'
  return { confidence, evidence, limitations }
}

function economicFlowKind(before: AllocationState | null, after: AllocationState): AllocationHistoryEntryKind | null {
  if (!before) return null
  const beforeStrategies = stateStrategyMap(before)
  const afterStrategies = stateStrategyMap(after)
  const addresses = new Set([...beforeStrategies.keys(), ...afterStrategies.keys()])
  let hasIncrease = false
  let hasDecrease = false
  for (const address of addresses) {
    const previous = BigInt(beforeStrategies.get(address)?.currentDebt ?? '0')
    const next = BigInt(afterStrategies.get(address)?.currentDebt ?? '0')
    if (next > previous) hasIncrease = true
    if (next < previous) hasDecrease = true
  }
  if (hasIncrease && hasDecrease) return 'strategy_reallocation'
  if (hasIncrease) return 'idle_deployment'
  if (hasDecrease) return 'idle_deallocation'
  return null
}

function publicEntryKind(
  group: readonly EntryCandidate[],
  before: AllocationState | null,
  after: AllocationState
): AllocationHistoryEntryKind {
  const candidate = group[0].kind
  if (candidate === 'current_snapshot' || candidate === 'bad_debt_purchase') return candidate
  const flow = economicFlowKind(before, after)
  if (flow) return flow
  if (
    candidate === 'allocator_target_execution' ||
    candidate === 'allocator_override' ||
    candidate === 'manual_role_execution'
  ) {
    return 'unattributed_debt_update'
  }
  return candidate
}

type ExecutionAttributes = Omit<AllocationHistoryEntry['execution'], 'transactions'>

function hasNonzeroRole(roleMask: string | null): boolean {
  if (!roleMask || !/^\d+$/.test(roleMask)) return false
  return BigInt(roleMask) !== 0n
}

function effectExecutionAttributes(
  effect: AllocationTransitionEffect,
  allocators: ReadonlySet<Address>
): ExecutionAttributes {
  const replays = effect.triggerReplays ?? []
  if (replays.some((replay) => replay.status === 'not_matched')) {
    return { automation: 'manual', mechanism: 'allocator_keeper', targetStatus: 'overridden' }
  }
  if (replays.length > 0 && replays.every((replay) => replay.status === 'matched')) {
    return { automation: 'automatic', mechanism: 'allocator_keeper', targetStatus: 'matched' }
  }
  if (usesAllocator(effect, allocators) || effect.kind === 'allocator_execution' || effect.kind === 'doa_execution') {
    return { automation: 'unknown', mechanism: 'allocator_keeper', targetStatus: 'unavailable' }
  }
  if (effect.inputSelector === SAFE_EXEC_TRANSACTION_SELECTOR) {
    return { automation: 'manual', mechanism: 'governance_safe', targetStatus: 'not_applicable' }
  }
  if (effect.actor.role === 'role_manager') {
    return { automation: 'manual', mechanism: 'role_manager', targetStatus: 'not_applicable' }
  }
  if (effect.actor.role === 'governance') {
    return { automation: 'manual', mechanism: 'governance', targetStatus: 'not_applicable' }
  }
  if (
    effect.executionContext.immediateVaultCallerHasDebtManagerRole === true ||
    hasNonzeroRole(effect.executionContext.immediateVaultCallerRoleMask) ||
    effect.actor.role === 'vault_role_holder' ||
    effect.actor.role === 'management'
  ) {
    return { automation: 'manual', mechanism: 'direct_vault_role', targetStatus: 'not_applicable' }
  }
  return { automation: 'unknown', mechanism: 'unknown', targetStatus: 'not_applicable' }
}

function executionAttributes(
  group: readonly EntryCandidate[],
  before: AllocationState | null,
  after: AllocationState
): ExecutionAttributes {
  const allocators = new Set<Address>(
    [
      before?.allocatorAddress,
      after.allocatorAddress,
      ...group.flatMap((candidate) =>
        candidate.transition.effects.flatMap(
          (effect) => effect.triggerReplays?.map((replay) => replay.allocatorAddress) ?? []
        )
      )
    ].filter((value): value is Address => value !== null && value !== undefined)
  )
  const values = group
    .flatMap((candidate) => candidate.transition.effects)
    .map((effect) => effectExecutionAttributes(effect, allocators))
  if (values.length === 0) return { automation: null, mechanism: null, targetStatus: null }

  const automations = new Set(values.map((value) => value.automation))
  const mechanisms = new Set(values.map((value) => value.mechanism))
  const targetStatuses = new Set(values.map((value) => value.targetStatus))
  return {
    automation: automations.size === 1 ? (values[0].automation ?? null) : 'mixed',
    mechanism: mechanisms.size === 1 ? (values[0].mechanism ?? null) : 'mixed',
    targetStatus: targetStatuses.size === 1 ? (values[0].targetStatus ?? null) : 'mixed'
  }
}

function operationAddress(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value.toLowerCase() as Address) : null
}

function operationValue(value: unknown): AllocationEntryOperationValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return null
}

function eventStrategyAddress(event: AllocationSourceEvent): Address | null {
  return event.strategyAddress ?? operationAddress(event.args.strategy)
}

function sourceEvents(
  group: readonly EntryCandidate[],
  eventsById: ReadonlyMap<string, AllocationSourceEvent>
): AllocationSourceEvent[] {
  const ids = new Set(
    group.flatMap((candidate) => candidate.transition.effects.flatMap((effect) => effect.sourceEventIds))
  )
  return [...ids]
    .map((id) => eventsById.get(id))
    .filter((event): event is AllocationSourceEvent => event !== undefined)
    .sort(
      (left, right) =>
        left.blockNumber - right.blockNumber ||
        left.transactionIndex - right.transactionIndex ||
        left.logIndex - right.logIndex ||
        left.id.localeCompare(right.id)
    )
}

function configurationSubject(
  event: AllocationSourceEvent,
  vaultAddress: Address
): AllocationEntryOperation['subject'] {
  const strategyAddress = eventStrategyAddress(event)
  if (strategyAddress) return { type: 'strategy', address: strategyAddress, name: null }
  const accountAddress = operationAddress(event.args.account) ?? operationAddress(event.args.keeper)
  if (accountAddress) return { type: 'account', address: accountAddress, name: null }
  if (event.sourceLabel === 'debtAllocator') {
    return { type: 'allocator', address: event.sourceAddress, name: null }
  }
  return { type: 'vault', address: vaultAddress, name: null }
}

function entryOperations(
  group: readonly EntryCandidate[],
  vaultAddress: Address,
  before: AllocationState | null,
  after: AllocationState,
  names: ReadonlyMap<Address, string | null>,
  eventsById: ReadonlyMap<string, AllocationSourceEvent>
): AllocationEntryOperation[] {
  const beforeStrategies = stateStrategyMap(before)
  const afterStrategies = stateStrategyMap(after)
  const events = sourceEvents(group, eventsById)
  const operations: AllocationEntryOperation[] = []

  for (const event of events) {
    const strategyAddress = eventStrategyAddress(event)
    if (event.eventName === 'StrategyChanged' && strategyAddress) {
      const changeType = operationValue(event.args.changeType)
      const kind = changeType === '1' ? 'strategy_added' : changeType === '2' ? 'strategy_retired' : null
      if (kind) {
        operations.push({
          kind,
          source: 'envio_event',
          sourceEventIds: [event.id],
          eventName: event.eventName,
          subject: { type: 'strategy', address: strategyAddress, name: names.get(strategyAddress) ?? null },
          changes: [
            {
              field: 'active',
              before: active(beforeStrategies.get(strategyAddress)),
              after: active(afterStrategies.get(strategyAddress))
            }
          ]
        })
      }
      continue
    }

    if (event.eventName === 'UpdatedMaxDebtForStrategy' && strategyAddress) {
      const previous = beforeStrategies.get(strategyAddress)
      const next = afterStrategies.get(strategyAddress)
      operations.push({
        kind: 'max_debt_updated',
        source: 'envio_event',
        sourceEventIds: [event.id],
        eventName: event.eventName,
        subject: { type: 'strategy', address: strategyAddress, name: names.get(strategyAddress) ?? null },
        changes: [{ field: 'maxDebt', before: previous?.maxDebt ?? null, after: next?.maxDebt ?? null }]
      })
      continue
    }

    if (ALLOCATOR_CONFIGURATION_EVENTS.has(event.eventName)) continue
    if (VAULT_CONFIGURATION_EVENTS.has(event.eventName)) {
      const subject = configurationSubject(event, vaultAddress)
      if (subject.type === 'strategy' && subject.address) subject.name = names.get(subject.address) ?? null
      operations.push({
        kind: 'vault_configuration_updated',
        source: 'envio_event',
        sourceEventIds: [event.id],
        eventName: event.eventName,
        subject,
        changes: Object.entries(event.args)
          .filter(([field]) => !['sender', 'strategy', 'account'].includes(field))
          .map(([field, value]) => ({ field, before: null, after: operationValue(value) }))
      })
    }
  }

  const ratioEvents = events.filter((event) => ALLOCATOR_CONFIGURATION_EVENTS.has(event.eventName))
  const strategyAddresses = new Set([...beforeStrategies.keys(), ...afterStrategies.keys()])
  for (const strategyAddress of strategyAddresses) {
    const previous = beforeStrategies.get(strategyAddress)
    const next = afterStrategies.get(strategyAddress)
    const allocatorMembershipChanged =
      previous?.allocatorAdded !== next?.allocatorAdded &&
      (previous?.allocatorAdded === true || next?.allocatorAdded === true)
    const targetChanged = previous?.targetDebtRatioBps !== next?.targetDebtRatioBps
    const maxChanged = previous?.maxDebtRatioBps !== next?.maxDebtRatioBps
    if (!allocatorMembershipChanged && !targetChanged && !maxChanged) continue
    if (
      previous === undefined &&
      next?.allocatorAdded !== true &&
      (next?.targetDebtRatioBps ?? 0) === 0 &&
      (next?.maxDebtRatioBps ?? 0) === 0
    ) {
      continue
    }
    const matchingEvents = ratioEvents.filter((event) => eventStrategyAddress(event) === strategyAddress)
    operations.push({
      kind: 'allocator_strategy_configured',
      source: matchingEvents.length > 0 ? 'envio_event' : 'archive_rpc_diff',
      sourceEventIds: matchingEvents.map((event) => event.id),
      eventName: matchingEvents[0]?.eventName ?? null,
      subject: { type: 'strategy', address: strategyAddress, name: names.get(strategyAddress) ?? null },
      changes: [
        { field: 'allocatorAdded', before: previous?.allocatorAdded ?? null, after: next?.allocatorAdded ?? null },
        {
          field: 'targetDebtRatioBps',
          before: previous?.targetDebtRatioBps ?? null,
          after: next?.targetDebtRatioBps ?? null
        },
        {
          field: 'maxDebtRatioBps',
          before: previous?.maxDebtRatioBps ?? null,
          after: next?.maxDebtRatioBps ?? null
        }
      ]
    })
  }

  return operations
}

function entry(
  chainId: number,
  vaultAddress: Address,
  group: readonly EntryCandidate[],
  states: ReadonlyMap<string, AllocationState>,
  records: readonly DoaOptimizationRecord[],
  names: ReadonlyMap<Address, string | null>,
  eventsById: ReadonlyMap<string, AllocationSourceEvent>,
  doaRecordsAvailable: boolean,
  materializationLimitations: readonly string[]
): AllocationHistoryEntry | null {
  const first = group[0].transition
  const last = group.at(-1)?.transition ?? first
  const isCurrent = group[0].kind === 'current_snapshot'
  const beforeState = isCurrent || !first.fromStateId ? null : (states.get(first.fromStateId) ?? null)
  const afterState = states.get(last.toStateId)
  if (!afterState) return null
  const kind = publicEntryKind(group, beforeState, afterState)
  const entryPolicy = policy(group, beforeState, afterState, records, names)
  const execution = executionAttributes(group, beforeState, afterState)
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
    kind,
    startBlock: first.blockNumber,
    endBlock: last.blockNumber,
    startTimestamp: first.blockTimestamp,
    endTimestamp: last.blockTimestamp,
    before: beforeState ? entryState(beforeState, names) : null,
    after: entryState(afterState, names),
    changes,
    policy: entryPolicy,
    operations: isCurrent ? [] : entryOperations(group, vaultAddress, beforeState, afterState, names, eventsById),
    execution: { ...execution, transactions },
    classification: classification(
      group,
      kind,
      execution,
      entryPolicy,
      doaRecordsAvailable,
      materializationLimitations
    ),
    detailsAvailable: false
  }
}

export function buildRestAllocationEntries(input: {
  timeline: NormalizedAllocationTimeline
  doaRecords: readonly DoaOptimizationRecord[]
  doaRecordsAvailable?: boolean
  materializationLimitations?: readonly string[]
}): AllocationHistoryEntry[] {
  const states = new Map(input.timeline.states.map((state) => [state.id, state]))
  const names = strategyNameMap(input.timeline.strategies)
  const eventsById = new Map((input.timeline.events ?? []).map((event) => [event.id, event]))
  return groupCandidates(input.timeline.transitions, states)
    .map((group) =>
      entry(
        input.timeline.vault.chainId,
        input.timeline.vault.address,
        group,
        states,
        input.doaRecords,
        names,
        eventsById,
        input.doaRecordsAvailable ?? true,
        input.materializationLimitations ?? []
      )
    )
    .filter((value): value is AllocationHistoryEntry => value !== null)
}

export function buildRestAllocationHistory(input: {
  timeline: NormalizedAllocationTimeline
  doaRecords: readonly DoaOptimizationRecord[]
  doaRecordsAvailable?: boolean
  direction: TimelineDirection
  limit: number
  hasMore: boolean
}): VaultAllocationHistoryResponse {
  const matchingEntries = buildRestAllocationEntries(input).sort((left, right) => {
    const multiplier = input.direction === 'asc' ? 1 : -1
    return multiplier * (left.endBlock - right.endBlock) || multiplier * left.id.localeCompare(right.id)
  })
  const entries = matchingEntries.slice(0, input.limit)

  return {
    schemaVersion: 2,
    projection: 'full',
    generatedAt: input.timeline.generatedAt,
    direction: input.direction,
    dataQuality: { certification: 'certified', limitations: [] },
    vault: input.timeline.vault,
    entries,
    pagination: {
      limit: input.limit,
      returned: entries.length,
      hasMore: input.hasMore || matchingEntries.length > entries.length,
      nextCursor: null
    }
  }
}
