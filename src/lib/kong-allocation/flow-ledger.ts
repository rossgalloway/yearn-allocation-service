import { isAllocationChartEntryKind } from './chart'
import type {
  Address,
  AllocationChartInterval,
  AllocationChartState,
  AllocationEntryState,
  AllocationFlowBalanceNode,
  AllocationFlowNode,
  AllocationHistoryEntry,
  AllocationIntervalFlow,
  AllocationSourceEvent
} from './types'

interface MutableFlow extends Omit<AllocationIntervalFlow, 'amount' | 'evidence'> {
  amount: bigint
  eventIds: Set<string>
  transactionHashes: Set<string>
}

interface DebtGroup {
  deltas: Map<Address, bigint>
  eventIds: Set<string>
  transactionHashes: Set<string>
  badDebtPurchase: boolean
}

const IDLE_NODE = { type: 'idle' } as const
const EXTERNAL_NODE = { type: 'external' } as const
const ACCOUNTING_NODE = { type: 'accounting' } as const

function decimal(value: unknown): bigint | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null
}

function address(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value.toLowerCase() as Address) : null
}

function nodeKey(node: AllocationFlowNode): string {
  if (node.type === 'strategy') return `strategy:${node.address}`
  return node.type
}

function balanceNodeKey(node: AllocationFlowNode): string | null {
  return node.type === 'idle' || node.type === 'strategy' ? nodeKey(node) : null
}

function strategyNames(...states: AllocationEntryState[]): Map<Address, string | null> {
  const names = new Map<Address, string | null>()
  for (const state of states) {
    for (const allocation of state.allocations) names.set(allocation.strategyAddress, allocation.strategyName)
  }
  return names
}

function strategyNode(strategyAddress: Address, names: ReadonlyMap<Address, string | null>): AllocationFlowBalanceNode {
  return { type: 'strategy', address: strategyAddress, name: names.get(strategyAddress) ?? null }
}

function idleBps(state: AllocationEntryState): number | null {
  const totalIdle = decimal(state.totalIdle)
  const totalAssets = decimal(state.totalAssets)
  if (totalIdle === null || totalAssets === null || totalAssets === 0n) return null
  return Number((totalIdle * 10_000n) / totalAssets)
}

function intervalState(
  state: AllocationEntryState,
  strategyAddresses: readonly Address[],
  names: ReadonlyMap<Address, string | null>
): AllocationChartState {
  const allocations = new Map(state.allocations.map((allocation) => [allocation.strategyAddress, allocation]))
  return {
    blockNumber: state.blockNumber,
    blockTimestamp: state.blockTimestamp,
    totalAssets: state.totalAssets,
    totalIdle: state.totalIdle,
    idleBps: idleBps(state),
    allocations: strategyAddresses.map((strategyAddress) => {
      const allocation = allocations.get(strategyAddress)
      return {
        strategyAddress,
        strategyName: allocation?.strategyName ?? names.get(strategyAddress) ?? null,
        currentDebt: allocation?.currentDebt ?? '0',
        currentDebtBps: allocation?.currentDebtBps ?? 0
      }
    })
  }
}

function flowKey(flow: Omit<MutableFlow, 'amount' | 'eventIds' | 'transactionHashes'>): string {
  return [nodeKey(flow.source), nodeKey(flow.target), flow.kind, flow.attribution].join('|')
}

function addFlow(
  flows: Map<string, MutableFlow>,
  flow: Omit<MutableFlow, 'amount' | 'eventIds' | 'transactionHashes'> & {
    amount: bigint
    eventIds?: Iterable<string>
    transactionHashes?: Iterable<string>
  }
): void {
  if (flow.amount <= 0n) return
  const key = flowKey(flow)
  const current = flows.get(key)
  if (current) {
    current.amount += flow.amount
    for (const eventId of flow.eventIds ?? []) current.eventIds.add(eventId)
    for (const hash of flow.transactionHashes ?? []) current.transactionHashes.add(hash)
    if (current.accounting && flow.accounting) {
      current.accounting.totalFees = (
        BigInt(current.accounting.totalFees) + BigInt(flow.accounting.totalFees)
      ).toString()
      current.accounting.protocolFees = (
        BigInt(current.accounting.protocolFees) + BigInt(flow.accounting.protocolFees)
      ).toString()
    }
    return
  }
  flows.set(key, {
    source: flow.source,
    target: flow.target,
    kind: flow.kind,
    attribution: flow.attribution,
    amount: flow.amount,
    eventIds: new Set(flow.eventIds ?? []),
    transactionHashes: new Set(flow.transactionHashes ?? []),
    ...(flow.accounting ? { accounting: { ...flow.accounting } } : {})
  })
}

function debtGroupKey(event: AllocationSourceEvent, toEntry: AllocationHistoryEntry | null): string {
  if (toEntry && event.blockNumber >= toEntry.startBlock && event.blockNumber <= toEntry.endBlock) {
    return `entry:${toEntry.id}`
  }
  return `transaction:${event.transactionHash}`
}

function debtGroups(
  events: readonly AllocationSourceEvent[],
  toEntry: AllocationHistoryEntry | null
): Map<string, DebtGroup> {
  const purchasedTransactions = new Set(
    events.filter((event) => event.eventName === 'DebtPurchased').map((event) => event.transactionHash)
  )
  const groups = new Map<string, DebtGroup>()
  for (const event of events) {
    if (event.eventName !== 'DebtUpdated') continue
    const strategyAddress = event.strategyAddress ?? address(event.args.strategy)
    const currentDebt = decimal(event.args.currentDebt)
    const newDebt = decimal(event.args.newDebt)
    if (!strategyAddress || currentDebt === null || newDebt === null || currentDebt === newDebt) continue
    const key = debtGroupKey(event, toEntry)
    const group = groups.get(key) ?? {
      deltas: new Map<Address, bigint>(),
      eventIds: new Set<string>(),
      transactionHashes: new Set<string>(),
      badDebtPurchase: false
    }
    group.deltas.set(strategyAddress, (group.deltas.get(strategyAddress) ?? 0n) + newDebt - currentDebt)
    group.eventIds.add(event.id)
    group.transactionHashes.add(event.transactionHash)
    if (purchasedTransactions.has(event.transactionHash)) group.badDebtPurchase = true
    groups.set(key, group)
  }
  return groups
}

function addDebtFlows(
  flows: Map<string, MutableFlow>,
  events: readonly AllocationSourceEvent[],
  toEntry: AllocationHistoryEntry | null,
  names: ReadonlyMap<Address, string | null>
): void {
  for (const group of debtGroups(events, toEntry).values()) {
    const decreases = [...group.deltas]
      .filter(([, delta]) => delta < 0n)
      .map(([strategyAddress, delta]) => ({ strategyAddress, amount: -delta }))
      .sort((left, right) => left.strategyAddress.localeCompare(right.strategyAddress))
    const increases = [...group.deltas]
      .filter(([, delta]) => delta > 0n)
      .map(([strategyAddress, amount]) => ({ strategyAddress, amount }))
      .sort((left, right) => left.strategyAddress.localeCompare(right.strategyAddress))

    let decreaseIndex = 0
    let increaseIndex = 0
    while (decreaseIndex < decreases.length && increaseIndex < increases.length) {
      const decrease = decreases[decreaseIndex]
      const increase = increases[increaseIndex]
      const amount = decrease.amount < increase.amount ? decrease.amount : increase.amount
      addFlow(flows, {
        source: strategyNode(decrease.strategyAddress, names),
        target: strategyNode(increase.strategyAddress, names),
        amount,
        kind: 'strategy_reallocation',
        attribution: 'derived_from_debt_updates',
        eventIds: group.eventIds,
        transactionHashes: group.transactionHashes
      })
      decrease.amount -= amount
      increase.amount -= amount
      if (decrease.amount === 0n) decreaseIndex += 1
      if (increase.amount === 0n) increaseIndex += 1
    }

    for (const decrease of decreases) {
      addFlow(flows, {
        source: strategyNode(decrease.strategyAddress, names),
        target: IDLE_NODE,
        amount: decrease.amount,
        kind: group.badDebtPurchase ? 'bad_debt_purchase' : 'idle_deallocation',
        attribution: 'derived_from_debt_updates',
        eventIds: group.eventIds,
        transactionHashes: group.transactionHashes
      })
    }
    for (const increase of increases) {
      addFlow(flows, {
        source: IDLE_NODE,
        target: strategyNode(increase.strategyAddress, names),
        amount: increase.amount,
        kind: 'idle_deployment',
        attribution: 'derived_from_debt_updates',
        eventIds: group.eventIds,
        transactionHashes: group.transactionHashes
      })
    }
  }
}

function addObservedFlows(
  flows: Map<string, MutableFlow>,
  events: readonly AllocationSourceEvent[],
  vaultAddress: Address,
  names: ReadonlyMap<Address, string | null>
): void {
  for (const event of events) {
    const evidence = { eventIds: [event.id], transactionHashes: [event.transactionHash] }
    if (event.eventName === 'Deposit') {
      const amount = decimal(event.args.assets)
      if (amount !== null) {
        addFlow(flows, {
          source: EXTERNAL_NODE,
          target: IDLE_NODE,
          amount,
          kind: 'deposit',
          attribution: 'observed_event',
          ...evidence
        })
      }
      continue
    }
    if (event.eventName === 'Withdraw') {
      const amount = decimal(event.args.assets)
      if (amount !== null) {
        addFlow(flows, {
          source: IDLE_NODE,
          target: EXTERNAL_NODE,
          amount,
          kind: 'withdrawal',
          attribution: 'observed_event',
          ...evidence
        })
      }
      continue
    }
    if (event.eventName !== 'StrategyReported') continue
    const strategyAddress = event.strategyAddress ?? address(event.args.strategy)
    if (!strategyAddress) continue
    const reportNode = strategyAddress === vaultAddress ? IDLE_NODE : strategyNode(strategyAddress, names)
    const gain = decimal(event.args.gain)
    const loss = decimal(event.args.loss)
    const refund = decimal(event.args.totalRefunds)
    const accounting = {
      totalFees: (decimal(event.args.totalFees) ?? 0n).toString(),
      protocolFees: (decimal(event.args.protocolFees) ?? 0n).toString()
    }
    if (gain !== null) {
      addFlow(flows, {
        source: ACCOUNTING_NODE,
        target: reportNode,
        amount: gain,
        kind: 'reported_gain',
        attribution: 'observed_event',
        accounting,
        ...evidence
      })
    }
    if (loss !== null) {
      addFlow(flows, {
        source: reportNode,
        target: ACCOUNTING_NODE,
        amount: loss,
        kind: 'reported_loss',
        attribution: 'observed_event',
        accounting,
        ...evidence
      })
    }
    if (refund !== null) {
      addFlow(flows, {
        source: EXTERNAL_NODE,
        target: IDLE_NODE,
        amount: refund,
        kind: 'report_refund',
        attribution: 'observed_event',
        accounting,
        ...evidence
      })
    }
  }
}

function serializedFlows(flows: ReadonlyMap<string, MutableFlow>): AllocationIntervalFlow[] {
  return [...flows.values()]
    .filter((flow) => flow.amount > 0n)
    .sort(
      (left, right) =>
        nodeKey(left.source).localeCompare(nodeKey(right.source)) ||
        nodeKey(left.target).localeCompare(nodeKey(right.target)) ||
        left.kind.localeCompare(right.kind)
    )
    .map((flow) => ({
      source: flow.source,
      target: flow.target,
      amount: flow.amount.toString(),
      kind: flow.kind,
      attribution: flow.attribution,
      evidence: {
        eventCount: flow.eventIds.size,
        transactionCount: flow.transactionHashes.size
      },
      ...(flow.accounting ? { accounting: flow.accounting } : {})
    }))
}

function nodeBalances(state: AllocationEntryState): Map<string, bigint> {
  const balances = new Map<string, bigint>([['idle', decimal(state.totalIdle) ?? 0n]])
  for (const allocation of state.allocations) {
    balances.set(`strategy:${allocation.strategyAddress}`, decimal(allocation.currentDebt) ?? 0n)
  }
  return balances
}

function buildInterval(input: {
  fromEntry: AllocationHistoryEntry
  toEntry: AllocationHistoryEntry | null
  endState: AllocationEntryState
  endKind: AllocationChartInterval['endKind']
  events: readonly AllocationSourceEvent[]
  vaultAddress: Address
}): AllocationChartInterval {
  const startState = input.fromEntry.after
  const names = strategyNames(startState, input.endState)
  const eventSlice = input.events.filter(
    (event) => event.blockNumber > startState.blockNumber && event.blockNumber <= input.endState.blockNumber
  )
  const flows = new Map<string, MutableFlow>()
  addObservedFlows(flows, eventSlice, input.vaultAddress, names)
  addDebtFlows(flows, eventSlice, input.toEntry, names)

  const opening = nodeBalances(startState)
  const closing = nodeBalances(input.endState)
  const attributedNet = new Map<string, bigint>()
  const touchedBalanceNodes = new Set<string>()
  for (const flow of flows.values()) {
    const source = balanceNodeKey(flow.source)
    const target = balanceNodeKey(flow.target)
    if (source) {
      touchedBalanceNodes.add(source)
      attributedNet.set(source, (attributedNet.get(source) ?? 0n) - flow.amount)
    }
    if (target) {
      touchedBalanceNodes.add(target)
      attributedNet.set(target, (attributedNet.get(target) ?? 0n) + flow.amount)
    }
  }
  const balanceKeys = [...new Set([...opening.keys(), ...closing.keys()])]
    .filter((key) => (opening.get(key) ?? 0n) !== 0n || (closing.get(key) ?? 0n) !== 0n || touchedBalanceNodes.has(key))
    .sort()

  let unattributedAmount = 0n
  for (const key of balanceKeys) {
    const needed = (closing.get(key) ?? 0n) - (opening.get(key) ?? 0n) - (attributedNet.get(key) ?? 0n)
    if (needed === 0n) continue
    const node = key === 'idle' ? IDLE_NODE : strategyNode(key.slice('strategy:'.length) as Address, names)
    addFlow(flows, {
      source: needed > 0n ? ACCOUNTING_NODE : node,
      target: needed > 0n ? node : ACCOUNTING_NODE,
      amount: needed < 0n ? -needed : needed,
      kind: 'unattributed_asset_change',
      attribution: 'residual_balance'
    })
    unattributedAmount += needed < 0n ? -needed : needed
  }

  const allFlows = serializedFlows(flows)
  const residuals = balanceKeys.map((key) => {
    const node: AllocationFlowBalanceNode =
      key === 'idle' ? IDLE_NODE : strategyNode(key.slice('strategy:'.length) as Address, names)
    const attributedInflows = allFlows
      .filter((flow) => flow.attribution !== 'residual_balance' && balanceNodeKey(flow.target) === key)
      .reduce((sum, flow) => sum + BigInt(flow.amount), 0n)
    const attributedOutflows = allFlows
      .filter((flow) => flow.attribution !== 'residual_balance' && balanceNodeKey(flow.source) === key)
      .reduce((sum, flow) => sum + BigInt(flow.amount), 0n)
    const unattributedInflows = allFlows
      .filter((flow) => flow.attribution === 'residual_balance' && balanceNodeKey(flow.target) === key)
      .reduce((sum, flow) => sum + BigInt(flow.amount), 0n)
    const unattributedOutflows = allFlows
      .filter((flow) => flow.attribution === 'residual_balance' && balanceNodeKey(flow.source) === key)
      .reduce((sum, flow) => sum + BigInt(flow.amount), 0n)
    const openingBalance = opening.get(key) ?? 0n
    const closingBalance = closing.get(key) ?? 0n
    const finalResidual =
      closingBalance -
      (openingBalance + attributedInflows - attributedOutflows + unattributedInflows - unattributedOutflows)
    return {
      node,
      openingBalance: openingBalance.toString(),
      closingBalance: closingBalance.toString(),
      attributedInflows: attributedInflows.toString(),
      attributedOutflows: attributedOutflows.toString(),
      unattributedInflows: unattributedInflows.toString(),
      unattributedOutflows: unattributedOutflows.toString(),
      residualAmount: finalResidual.toString()
    }
  })
  const strategyAddresses = balanceKeys
    .filter((key) => key.startsWith('strategy:'))
    .map((key) => key.slice('strategy:'.length) as Address)
  const balanceStatus = residuals.every((residual) => residual.residualAmount === '0') ? 'reconciled' : 'unreconciled'

  return {
    fromEntryId: input.fromEntry.id,
    toEntryId: input.toEntry?.id ?? null,
    endKind: input.endKind,
    startState: intervalState(startState, strategyAddresses, names),
    endState: intervalState(input.endState, strategyAddresses, names),
    flows: allFlows,
    reconciliation: {
      openingTotalAssets: startState.totalAssets,
      closingTotalAssets: input.endState.totalAssets,
      totalAssetsDelta: (BigInt(input.endState.totalAssets) - BigInt(startState.totalAssets)).toString(),
      balanceStatus,
      attributionStatus: unattributedAmount === 0n ? 'complete' : 'partial',
      unattributedAmount: unattributedAmount.toString(),
      checkedNodeTypes: ['idle', 'strategy'],
      residuals
    }
  }
}

export function buildAllocationFlowIntervals(input: {
  entries: readonly AllocationHistoryEntry[]
  events: readonly AllocationSourceEvent[]
  vaultAddress: Address
}): Map<string, AllocationChartInterval> {
  const chartEntries = input.entries
    .filter((entry) => isAllocationChartEntryKind(entry.kind))
    .sort((left, right) => left.endBlock - right.endBlock || left.id.localeCompare(right.id))
  const intervals = new Map<string, AllocationChartInterval>()
  for (let index = 1; index < chartEntries.length; index += 1) {
    const fromEntry = chartEntries[index - 1]
    const toEntry = chartEntries[index]
    intervals.set(
      toEntry.id,
      buildInterval({
        fromEntry,
        toEntry,
        endState: toEntry.after,
        endKind: 'allocation_entry',
        events: input.events,
        vaultAddress: input.vaultAddress
      })
    )
  }

  const currentSnapshot = input.entries.find((entry) => entry.kind === 'current_snapshot')
  const latestEntry = chartEntries.at(-1)
  if (currentSnapshot && latestEntry && currentSnapshot.after.blockNumber > latestEntry.after.blockNumber) {
    intervals.set(
      currentSnapshot.id,
      buildInterval({
        fromEntry: latestEntry,
        toEntry: null,
        endState: currentSnapshot.after,
        endKind: 'safe_head',
        events: input.events,
        vaultAddress: input.vaultAddress
      })
    )
  }
  return intervals
}
