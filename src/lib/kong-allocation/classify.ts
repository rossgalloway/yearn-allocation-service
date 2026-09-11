import { allocatorAssignmentEvents, resolveAllocatorAssignment } from './allocators'
import { knownDoaKeeper } from './known-actors'
import type {
  ActorClassification,
  Address,
  AllocationExecutionContext,
  AllocationSourceEvent,
  AllocationTransition,
  AllocationTransitionEffect,
  AllocationTransitionKind,
  AllocatorTriggerReplay,
  Hash,
  RpcTransactionContext,
  VaultActivity
} from './types'

export interface TransitionPoint {
  blockNumber: number
  blockTimestamp: number
  fromStateId: string | null
  toStateId: string
  currentLiveTail?: boolean
}

interface ActorState {
  allocatorKeepers: Map<Address, Set<Address>>
  governance: Map<Address, Address>
  roleManager: Address | null
  vaultRoles: Map<Address, bigint>
}

interface TransactionActorContext {
  actor: ActorClassification
  executionContext: AllocationExecutionContext
}

const DEBT_MANAGER_ROLE = 64n

const CONFIG_EVENTS = new Set([
  'UpdatedMaxDebtForStrategy',
  'UpdateDefaultQueue',
  'UpdateUseDefaultQueue',
  'RoleSet',
  'RoleStatusChanged',
  'UpdateRoleManager',
  'UpdateAccountant',
  'AddedNewVault',
  'UpdateDebtAllocator',
  'RemovedVault',
  'NewDebtAllocator',
  'UpdateKeeper',
  'GovernanceTransferred'
])

const RATIO_EVENTS = new Set(['UpdateStrategyDebtRatio', 'UpdateStrategyDebtRatios'])

function address(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value.toLowerCase() as Address) : null
}

function eventOrder(left: AllocationSourceEvent, right: AllocationSourceEvent): number {
  return (
    left.blockNumber - right.blockNumber ||
    left.transactionIndex - right.transactionIndex ||
    left.logIndex - right.logIndex ||
    left.id.localeCompare(right.id)
  )
}

function classifyActor(
  actorAddress: Address | null,
  state: ActorState,
  chainId: number,
  allocatorAddress: Address | null
): ActorClassification {
  if (!actorAddress) return { address: null, role: 'unknown', label: null }
  const doaKeeper = knownDoaKeeper(chainId, actorAddress)
  if (doaKeeper) return { address: actorAddress, role: 'doa_keeper', label: doaKeeper.label }
  if (allocatorAddress && state.allocatorKeepers.get(allocatorAddress)?.has(actorAddress))
    return { address: actorAddress, role: 'debt_allocator_keeper', label: null }
  if (allocatorAddress && state.governance.get(allocatorAddress) === actorAddress)
    return { address: actorAddress, role: 'governance', label: null }
  if (state.roleManager === actorAddress) return { address: actorAddress, role: 'role_manager', label: null }
  if ((state.vaultRoles.get(actorAddress) ?? 0n) !== 0n)
    return { address: actorAddress, role: 'vault_role_holder', label: null }
  return { address: actorAddress, role: 'unknown', label: null }
}

function applyActorEvent(event: AllocationSourceEvent, state: ActorState): void {
  if (event.eventName === 'UpdateKeeper') {
    const keeper = address(event.args.keeper)
    if (!keeper) return
    const keepers = state.allocatorKeepers.get(event.sourceAddress) ?? new Set<Address>()
    if (event.args.allowed === true) keepers.add(keeper)
    else keepers.delete(keeper)
    state.allocatorKeepers.set(event.sourceAddress, keepers)
  } else if (event.eventName === 'GovernanceTransferred') {
    const next = address(event.args.newGovernance)
    if (next) state.governance.set(event.sourceAddress, next)
  } else if (event.eventName === 'UpdateRoleManager') {
    state.roleManager = address(event.args.roleManager)
  } else if (event.eventName === 'RoleSet') {
    const account = address(event.args.account)
    if (!account) return
    const role = typeof event.args.role === 'string' && /^\d+$/.test(event.args.role) ? BigInt(event.args.role) : null
    if (role !== null) state.vaultRoles.set(account, role)
  }
}

function actorByTransaction(
  events: readonly AllocationSourceEvent[],
  chainId: number,
  vaultAddress: Address,
  transactionContexts: ReadonlyMap<Hash, RpcTransactionContext>
): Map<Hash, TransactionActorContext> {
  const state: ActorState = {
    allocatorKeepers: new Map(),
    governance: new Map(),
    roleManager: null,
    vaultRoles: new Map()
  }
  const actors = new Map<Hash, TransactionActorContext>()
  const assignments = allocatorAssignmentEvents(events)
  const sorted = [...events].sort(eventOrder)
  let index = 0
  while (index < sorted.length) {
    const transactionHash = sorted[index].transactionHash
    const transactionEvents: AllocationSourceEvent[] = []
    while (sorted[index]?.transactionHash === transactionHash) {
      transactionEvents.push(sorted[index])
      index += 1
    }
    for (const event of transactionEvents) {
      if (event.eventName === 'GovernanceTransferred' && !state.governance.has(event.sourceAddress)) {
        const previous = address(event.args.previousGovernance)
        if (previous) state.governance.set(event.sourceAddress, previous)
      }
    }
    const actorAddress = transactionEvents.find((event) => event.transactionFrom)?.transactionFrom ?? null
    const context = transactionContexts.get(transactionHash)
    const immediateVaultCaller = context?.immediateVaultCaller ?? null
    const assignment = resolveAllocatorAssignment({
      vaultAddress,
      events: assignments,
      at: transactionEvents[0],
      roleManagerAddress: state.roleManager
    })
    const activeAllocator = immediateVaultCaller ?? assignment.address
    const roleMask = immediateVaultCaller ? state.vaultRoles.get(immediateVaultCaller) : undefined
    actors.set(transactionHash, {
      actor: classifyActor(actorAddress, state, chainId, activeAllocator),
      executionContext: {
        traceStatus: context?.traceStatus ?? 'unavailable',
        callPath: context?.callPath ?? [],
        immediateVaultCaller,
        immediateVaultCallerRoleMask: roleMask?.toString() ?? null,
        immediateVaultCallerHasDebtManagerRole:
          roleMask === undefined ? null : (roleMask & DEBT_MANAGER_ROLE) === DEBT_MANAGER_ROLE
      }
    })
    for (const event of transactionEvents) applyActorEvent(event, state)
  }
  return actors
}

function effectKind(events: readonly AllocationSourceEvent[], actor: ActorClassification): AllocationTransitionKind {
  const names = new Set(events.map((event) => event.eventName))
  const hasRatioEvent = [...names].some((name) => RATIO_EVENTS.has(name))
  if (names.has('DebtPurchased')) return 'bad_debt_purchase'
  if (names.has('DebtUpdated') && hasRatioEvent) return 'allocator_execution'
  if (names.has('DebtUpdated') && (actor.role === 'doa_keeper' || actor.role === 'debt_allocator_keeper'))
    return 'allocator_execution'
  if (hasRatioEvent) return 'allocator_execution'
  if ([...names].some((name) => CONFIG_EVENTS.has(name))) return 'manual_config_change'
  if (names.has('StrategyChanged')) return 'strategy_lifecycle_change'
  if (names.has('DebtUpdated') && names.has('Withdraw')) return 'withdrawal_driven_debt_update'
  if (names.has('DebtUpdated') && names.has('Deposit')) return 'deposit_driven_debt_update'
  if (names.has('DebtUpdated')) return 'manual_debt_update'
  if (names.has('StrategyReported')) return 'report_only_state_change'
  if (names.has('Withdraw')) return 'vault_withdrawal'
  if (names.has('Deposit')) return 'vault_deposit'
  return 'unknown'
}

const KIND_PRIORITY: AllocationTransitionKind[] = [
  'doa_execution',
  'bad_debt_purchase',
  'allocator_execution',
  'deposit_driven_debt_update',
  'withdrawal_driven_debt_update',
  'manual_debt_update',
  'manual_config_change',
  'strategy_lifecycle_change',
  'report_only_state_change',
  'vault_withdrawal',
  'vault_deposit',
  'unknown'
]

function transitionKind(effects: readonly AllocationTransitionEffect[]): AllocationTransitionKind {
  return KIND_PRIORITY.find((kind) => effects.some((effect) => effect.kind === kind)) ?? 'unknown'
}

function vaultActivities(events: readonly AllocationSourceEvent[], transactionTo: Address | null): VaultActivity[] {
  return events.flatMap((event): VaultActivity[] => {
    if (event.eventName !== 'Deposit' && event.eventName !== 'Withdraw') return []
    return [
      {
        kind: event.eventName === 'Deposit' ? 'deposit' : 'withdrawal',
        path: transactionTo === event.sourceAddress ? 'direct' : 'routed',
        sourceEventId: event.id,
        sender: address(event.args.sender),
        receiver: address(event.args.receiver),
        owner: address(event.args.owner),
        assets: typeof event.args.assets === 'string' ? event.args.assets : null,
        shares: typeof event.args.shares === 'string' ? event.args.shares : null
      }
    ]
  })
}

function transactionEffects(
  events: readonly AllocationSourceEvent[],
  actors: ReadonlyMap<Hash, TransactionActorContext>,
  triggerReplays: ReadonlyMap<Hash, AllocatorTriggerReplay[]>
): AllocationTransitionEffect[] {
  const byTransaction = new Map<Hash, AllocationSourceEvent[]>()
  for (const event of events) {
    const current = byTransaction.get(event.transactionHash) ?? []
    current.push(event)
    byTransaction.set(event.transactionHash, current)
  }
  return [...byTransaction.entries()]
    .sort(([, left], [, right]) => eventOrder(left[0], right[0]))
    .map(([transactionHash, transactionEvents]) => {
      transactionEvents.sort(eventOrder)
      const first = transactionEvents[0]
      const actorContext = actors.get(transactionHash) ?? {
        actor: {
          address: first.transactionFrom,
          role: 'unknown' as const,
          label: null
        },
        executionContext: {
          traceStatus: 'unavailable' as const,
          callPath: [],
          immediateVaultCaller: null,
          immediateVaultCallerRoleMask: null,
          immediateVaultCallerHasDebtManagerRole: null
        }
      }
      const activities = vaultActivities(transactionEvents, first.transactionTo)
      return {
        kind: effectKind(transactionEvents, actorContext.actor),
        sourceEventIds: transactionEvents.map((event) => event.id),
        transactionHash,
        transactionFrom: first.transactionFrom,
        transactionTo: first.transactionTo,
        inputSelector: first.inputSelector,
        actor: actorContext.actor,
        executionContext: actorContext.executionContext,
        ...(triggerReplays.has(transactionHash) ? { triggerReplays: triggerReplays.get(transactionHash) } : {}),
        ...(activities.length > 0 ? { vaultActivities: activities } : {})
      }
    })
}

export function buildTransitions(input: {
  chainId: number
  vaultAddress: Address
  points: readonly TransitionPoint[]
  events: readonly AllocationSourceEvent[]
  transactionContexts?: ReadonlyMap<Hash, RpcTransactionContext>
  triggerReplays?: ReadonlyMap<Hash, AllocatorTriggerReplay[]>
}): AllocationTransition[] {
  const actors = actorByTransaction(
    input.events,
    input.chainId,
    input.vaultAddress,
    input.transactionContexts ?? new Map()
  )
  const eventsByBlock = Map.groupBy(input.events, (event) => event.blockNumber)
  return input.points.map((point) => {
    const isLiveTail = point.currentLiveTail === true
    const blockEvents = eventsByBlock.get(point.blockNumber) ?? []
    const effects = isLiveTail ? [] : transactionEffects(blockEvents, actors, input.triggerReplays ?? new Map())
    const transactionHashes = [...new Set(effects.map((effect) => effect.transactionHash))]
    return {
      id: `allocation-transition:${input.chainId}:${input.vaultAddress.toLowerCase()}:${point.blockNumber}`,
      kind: isLiveTail ? 'current_live_tail' : transitionKind(effects),
      fromStateId: point.fromStateId,
      toStateId: point.toStateId,
      blockNumber: point.blockNumber,
      blockTimestamp: point.blockTimestamp,
      transactionHashes,
      effects
    }
  })
}
