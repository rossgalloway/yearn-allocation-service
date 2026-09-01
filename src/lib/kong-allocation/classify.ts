import { knownDoaKeeper } from './known-actors'
import type {
  ActorClassification,
  Address,
  AllocationSourceEvent,
  AllocationTransition,
  AllocationTransitionEffect,
  AllocationTransitionKind,
  Hash,
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
  allocatorKeepers: Set<Address>
  governance: Set<Address>
  roleManager: Address | null
  vaultRoleHolders: Set<Address>
}

const CONFIG_EVENTS = new Set([
  'UpdatedMaxDebtForStrategy',
  'UpdateDefaultQueue',
  'UpdateUseDefaultQueue',
  'RoleSet',
  'RoleStatusChanged',
  'UpdateRoleManager',
  'UpdateAccountant',
  'NewDebtAllocator',
  'UpdateKeeper',
  'GovernanceTransferred'
])

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

function classifyActor(actorAddress: Address | null, state: ActorState, chainId: number): ActorClassification {
  if (!actorAddress) return { address: null, role: 'unknown', label: null }
  const doaKeeper = knownDoaKeeper(chainId, actorAddress)
  if (doaKeeper) return { address: actorAddress, role: 'doa_keeper', label: doaKeeper.label }
  if (state.allocatorKeepers.has(actorAddress))
    return { address: actorAddress, role: 'debt_allocator_keeper', label: null }
  if (state.governance.has(actorAddress)) return { address: actorAddress, role: 'governance', label: null }
  if (state.roleManager === actorAddress) return { address: actorAddress, role: 'role_manager', label: null }
  if (state.vaultRoleHolders.has(actorAddress)) return { address: actorAddress, role: 'vault_role_holder', label: null }
  return { address: actorAddress, role: 'unknown', label: null }
}

function applyActorEvent(event: AllocationSourceEvent, state: ActorState): void {
  if (event.eventName === 'UpdateKeeper') {
    const keeper = address(event.args.keeper)
    if (!keeper) return
    if (event.args.allowed === true) state.allocatorKeepers.add(keeper)
    else state.allocatorKeepers.delete(keeper)
  } else if (event.eventName === 'GovernanceTransferred') {
    const previous = address(event.args.previousGovernance)
    const next = address(event.args.newGovernance)
    if (previous) state.governance.delete(previous)
    if (next) state.governance.add(next)
  } else if (event.eventName === 'UpdateRoleManager') {
    state.roleManager = address(event.args.roleManager)
  } else if (event.eventName === 'RoleSet') {
    const account = address(event.args.account)
    if (!account) return
    if (event.args.role === '0') state.vaultRoleHolders.delete(account)
    else state.vaultRoleHolders.add(account)
  }
}

function actorByTransaction(events: readonly AllocationSourceEvent[], chainId: number): Map<Hash, ActorClassification> {
  const state: ActorState = {
    allocatorKeepers: new Set(),
    governance: new Set(),
    roleManager: null,
    vaultRoleHolders: new Set()
  }
  const actors = new Map<Hash, ActorClassification>()
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
      if (event.eventName === 'GovernanceTransferred' && state.governance.size === 0) {
        const previous = address(event.args.previousGovernance)
        if (previous) state.governance.add(previous)
      }
    }
    const actorAddress = transactionEvents.find((event) => event.transactionFrom)?.transactionFrom ?? null
    actors.set(transactionHash, classifyActor(actorAddress, state, chainId))
    for (const event of transactionEvents) applyActorEvent(event, state)
  }
  return actors
}

function effectKind(events: readonly AllocationSourceEvent[], actor: ActorClassification): AllocationTransitionKind {
  const names = new Set(events.map((event) => event.eventName))
  if (names.has('DebtPurchased')) return 'bad_debt_purchase'
  if (names.has('DebtUpdated') && names.has('Withdraw')) return 'withdrawal_driven_debt_update'
  if (names.has('DebtUpdated') && names.has('Deposit')) return 'deposit_driven_debt_update'
  if (names.has('DebtUpdated') && names.has('UpdateStrategyDebtRatios')) return 'allocator_execution'
  if (names.has('DebtUpdated') && (actor.role === 'doa_keeper' || actor.role === 'debt_allocator_keeper'))
    return 'allocator_execution'
  if (names.has('DebtUpdated')) return 'manual_debt_update'
  if (names.has('UpdateStrategyDebtRatios')) return 'allocator_execution'
  if ([...names].some((name) => CONFIG_EVENTS.has(name))) return 'manual_config_change'
  if (names.has('StrategyChanged')) return 'strategy_lifecycle_change'
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
  actors: ReadonlyMap<Hash, ActorClassification>
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
      const actor = actors.get(transactionHash) ?? {
        address: first.transactionFrom,
        role: 'unknown' as const,
        label: null
      }
      const activities = vaultActivities(transactionEvents, first.transactionTo)
      return {
        kind: effectKind(transactionEvents, actor),
        sourceEventIds: transactionEvents.map((event) => event.id),
        transactionHash,
        transactionFrom: first.transactionFrom,
        transactionTo: first.transactionTo,
        inputSelector: first.inputSelector,
        actor,
        ...(activities.length > 0 ? { vaultActivities: activities } : {})
      }
    })
}

export function buildTransitions(input: {
  chainId: number
  vaultAddress: Address
  points: readonly TransitionPoint[]
  events: readonly AllocationSourceEvent[]
}): AllocationTransition[] {
  const actors = actorByTransaction(input.events, input.chainId)
  return input.points.map((point) => {
    const isLiveTail = point.currentLiveTail === true
    const blockEvents = input.events.filter((event) => event.blockNumber === point.blockNumber)
    const effects = isLiveTail ? [] : transactionEffects(blockEvents, actors)
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
