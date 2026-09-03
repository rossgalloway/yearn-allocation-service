import type {
  Address,
  AllocationChartCurrentSnapshot,
  AllocationChartEntry,
  AllocationChartEntryKind,
  AllocationChartExpectedAprImpact,
  AllocationChartFlowNode,
  AllocationChartInterval,
  AllocationChartState,
  AllocationEntryState,
  AllocationFlowInterval,
  AllocationFlowNode,
  AllocationHistoryEntry,
  MaterializedAllocationChartPayload,
  VaultAllocationVault
} from './types'

const CHART_ENTRY_KINDS = new Set<AllocationChartEntryKind>(['strategy_reallocation'])

export function isAllocationChartEntryKind(kind: string): kind is AllocationChartEntryKind {
  return CHART_ENTRY_KINDS.has(kind as AllocationChartEntryKind)
}

function nonzero(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) !== 0n
}

function relevantStrategyAddresses(entry: AllocationHistoryEntry): Address[] {
  const relevant = new Set<Address>()
  for (const state of [entry.before, entry.after]) {
    for (const allocation of state?.allocations ?? []) {
      if (nonzero(allocation.currentDebt)) relevant.add(allocation.strategyAddress)
    }
  }
  for (const change of entry.changes.strategies) {
    if (
      change.currentDebtBefore !== change.currentDebtAfter &&
      (nonzero(change.currentDebtBefore) || nonzero(change.currentDebtAfter))
    ) {
      relevant.add(change.strategyAddress)
    }
  }
  for (const operation of entry.operations) {
    if (operation.subject.type === 'strategy' && operation.subject.address) relevant.add(operation.subject.address)
  }
  for (const target of entry.policy?.targets ?? []) relevant.add(target.strategyAddress)
  return [...relevant].sort()
}

function strategyNames(
  entry: AllocationHistoryEntry,
  interval: AllocationFlowInterval | null
): Map<Address, string | null> {
  const names = new Map<Address, string | null>()
  for (const state of [entry.before, entry.after]) {
    for (const allocation of state?.allocations ?? []) names.set(allocation.strategyAddress, allocation.strategyName)
  }
  for (const target of entry.policy?.targets ?? []) names.set(target.strategyAddress, target.strategyName)
  for (const operation of entry.operations) {
    if (operation.subject.type === 'strategy' && operation.subject.address) {
      names.set(operation.subject.address, operation.subject.name)
    }
  }
  for (const state of interval ? [interval.startState, interval.endState] : []) {
    for (const allocation of state.allocations) names.set(allocation.strategyAddress, allocation.strategyName)
  }
  for (const flow of interval?.flows ?? []) {
    for (const node of [flow.source, flow.target]) {
      if (node.type === 'strategy') names.set(node.address, node.name)
    }
  }
  return names
}

function chartState(state: AllocationEntryState, addresses: readonly Address[]): AllocationChartState {
  const allocations = new Map(state.allocations.map((allocation) => [allocation.strategyAddress, allocation]))
  return {
    blockNumber: state.blockNumber,
    blockTimestamp: state.blockTimestamp,
    totalAssets: state.totalAssets,
    totalIdle: state.totalIdle,
    allocations: addresses.map((strategyAddress) => ({
      strategyAddress,
      currentDebt: allocations.get(strategyAddress)?.currentDebt ?? '0'
    }))
  }
}

function expectedAprImpact(entry: AllocationHistoryEntry): AllocationChartExpectedAprImpact {
  if (!entry.policy) return { status: 'unavailable', reason: 'no_matched_doa_policy' }
  const baselineAprBps = entry.policy.proposal.optimizerCurrentApr
  const proposedAprBps = entry.policy.proposal.optimizerProposedApr
  if (baselineAprBps === null || proposedAprBps === null) {
    return { status: 'unavailable', reason: 'policy_apr_unavailable' }
  }
  const application = entry.policy.application
  const appliedInEntry =
    application.status === 'confirmed' &&
    application.blockNumber >= entry.startBlock &&
    application.blockNumber <= entry.endBlock
  return {
    status: 'available',
    source: 'doa',
    scope: 'proposal',
    baselineAprBps,
    proposedAprBps,
    deltaAprBps: proposedAprBps - baselineAprBps,
    policyId: entry.policy.id,
    publishedAt: entry.policy.proposal.publishedAt,
    relationship: appliedInEntry ? 'applied_in_entry' : 'governing_policy',
    applicationStatus: application.status
  }
}

function detailsHref(vault: VaultAllocationVault, entryId: string, runId: string): string {
  return `/api/rest/views/allocation-history/${vault.chainId}/${vault.address.toLowerCase()}/entries/${encodeURIComponent(entryId)}?runId=${encodeURIComponent(runId)}`
}

function chartFlowNode(node: AllocationFlowNode): AllocationChartFlowNode {
  return node.type === 'strategy' ? { type: 'strategy', address: node.address } : node
}

function compactInterval(interval: AllocationFlowInterval | null): AllocationChartInterval | null {
  if (!interval) return null
  return {
    fromEntryId: interval.fromEntryId,
    toEntryId: interval.toEntryId,
    endKind: interval.endKind,
    flows: interval.flows.map((flow) => ({
      source: chartFlowNode(flow.source),
      target: chartFlowNode(flow.target),
      amount: flow.amount,
      kind: flow.kind,
      attribution: flow.attribution
    })),
    reconciliation: {
      balanceStatus: interval.reconciliation.balanceStatus,
      attributionStatus: interval.reconciliation.attributionStatus,
      unattributedAmount: interval.reconciliation.unattributedAmount
    }
  }
}

function strategyDictionary(
  names: ReadonlyMap<Address, string | null>,
  data: AllocationChartEntry | AllocationChartCurrentSnapshot,
  interval: AllocationFlowInterval | null
): Record<string, string | null> {
  const addresses = new Set(
    (data.kind === 'current_snapshot' ? data.allocations : data.after.allocations).map(
      (allocation) => allocation.strategyAddress
    )
  )
  for (const flow of interval?.flows ?? []) {
    for (const node of [flow.source, flow.target]) {
      if (node.type === 'strategy') addresses.add(node.address)
    }
  }
  return Object.fromEntries(
    [...addresses].sort().map((strategyAddress) => [strategyAddress, names.get(strategyAddress) ?? null])
  )
}

export function buildAllocationChartEntry(
  entry: AllocationHistoryEntry,
  vault: VaultAllocationVault,
  runId: string,
  interval: AllocationFlowInterval | null = null
): AllocationChartEntry | null {
  if (!isAllocationChartEntryKind(entry.kind)) return null
  if (!entry.before) throw new Error(`Chart entry ${entry.id} is missing its before state`)
  return {
    id: entry.id,
    kind: entry.kind,
    endBlock: entry.endBlock,
    endTimestamp: entry.endTimestamp,
    after: chartState(entry.after, relevantStrategyAddresses(entry)),
    interval: compactInterval(interval),
    execution: {
      automation: entry.execution.automation,
      mechanism: entry.execution.mechanism,
      targetStatus: entry.execution.targetStatus
    },
    expectedAprImpact: expectedAprImpact(entry),
    detailsHref: detailsHref(vault, entry.id, runId)
  }
}

export function buildAllocationChartCurrentSnapshot(
  entry: AllocationHistoryEntry,
  interval: AllocationFlowInterval | null = null
): AllocationChartCurrentSnapshot | null {
  if (entry.kind !== 'current_snapshot') return null
  const addresses = entry.after.allocations
    .filter((allocation) => nonzero(allocation.currentDebt))
    .map((allocation) => allocation.strategyAddress)
    .sort()
  return {
    id: entry.id,
    kind: 'current_snapshot',
    interval: compactInterval(interval),
    ...chartState(entry.after, addresses)
  }
}

export function buildAllocationChartPayload(
  entry: AllocationHistoryEntry,
  vault: VaultAllocationVault,
  runId: string,
  interval: AllocationFlowInterval | null = null
): MaterializedAllocationChartPayload | null {
  const data =
    buildAllocationChartCurrentSnapshot(entry, interval) ?? buildAllocationChartEntry(entry, vault, runId, interval)
  if (!data) return null
  return {
    data,
    strategies: strategyDictionary(strategyNames(entry, interval), data, interval),
    detailInterval: interval
  }
}
