import type { AllocationSourceEvent, VaultAccountingCheckpoint } from '@/lib/envio/types'

export interface AllocationStateStrategy {
  strategyAddress: string
  name: null
  currentDebt: string
  currentDebtBps: number
  maxDebt: string | null
  maxDebtBps: number | null
  targetDebtRatioBps: number | null
  isActive: boolean
}

export interface AllocationState {
  id: string
  chainId: number
  vaultAddress: string
  blockNumber: number
  blockTimestamp: number
  timestampUtc: string
  blockHash: string
  totalAssets: string
  totalDebt: string
  totalIdle: string
  unallocatedBps: number | null
  strategies: AllocationStateStrategy[]
  sourceEventIds: string[]
  accountingIdentityHolds: boolean
  canonicalBlockVerified: boolean
  complete: boolean
  issues: string[]
}

interface MutableStrategyState {
  address: string
  currentDebt: bigint
  maxDebt: bigint | null
  targetDebtRatioBps: number | null
  active: boolean
}

function parseArgs(event: AllocationSourceEvent): Record<string, unknown> | null {
  try {
    const value = JSON.parse(event.argsJson)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function parseUint(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  return BigInt(value)
}

function parseBps(value: unknown): number | null {
  const parsed = parseUint(value)
  return parsed !== null && parsed <= 10_000n ? Number(parsed) : null
}

function bps(value: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0
  return Number((value * 10_000n + denominator / 2n) / denominator)
}

function timestampUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

function parseUnixTimestamp(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function eventAddress(event: AllocationSourceEvent, args: Record<string, unknown>): string | null {
  const candidate = event.strategyAddress ?? args.strategy
  return typeof candidate === 'string' && /^0x[a-fA-F0-9]{40}$/.test(candidate) ? candidate.toLowerCase() : null
}

function mutableStrategy(states: Map<string, MutableStrategyState>, address: string): MutableStrategyState {
  const existing = states.get(address)
  if (existing) return existing
  const created: MutableStrategyState = {
    address,
    currentDebt: 0n,
    maxDebt: null,
    targetDebtRatioBps: null,
    active: false
  }
  states.set(address, created)
  return created
}

function applyEvent(
  states: Map<string, MutableStrategyState>,
  event: AllocationSourceEvent,
  issues: Set<string>
): void {
  const args = parseArgs(event)
  if (!args) {
    issues.add(`invalid-args-json:${event.id}`)
    return
  }
  const address = eventAddress(event, args)

  if (event.eventName === 'DebtUpdated' || event.eventName === 'StrategyReported') {
    const debt = parseUint(event.eventName === 'DebtUpdated' ? args.newDebt : args.currentDebt)
    if (!address || debt === null) {
      issues.add(`invalid-${event.eventName}-payload:${event.id}`)
      return
    }
    const strategy = mutableStrategy(states, address)
    strategy.currentDebt = debt
    strategy.active = true
    return
  }

  if (event.eventName === 'StrategyChanged') {
    const changeType = parseUint(args.changeType)
    if (!address || changeType === null) {
      issues.add(`invalid-StrategyChanged-payload:${event.id}`)
      return
    }
    const strategy = mutableStrategy(states, address)
    if (changeType === 0n) {
      strategy.active = true
    } else if (changeType === 1n) {
      strategy.active = false
      strategy.currentDebt = 0n
      strategy.maxDebt = 0n
      strategy.targetDebtRatioBps = null
    } else {
      issues.add(`unknown-StrategyChanged-change-type:${event.id}`)
    }
    return
  }

  if (event.eventName === 'UpdatedMaxDebtForStrategy') {
    const maxDebt = parseUint(args.newDebt)
    if (!address || maxDebt === null) {
      issues.add(`invalid-UpdatedMaxDebtForStrategy-payload:${event.id}`)
      return
    }
    mutableStrategy(states, address).maxDebt = maxDebt
    return
  }

  if (event.eventName === 'UpdateStrategyDebtRatio' || event.eventName === 'UpdateStrategyDebtRatios') {
    const targetBps = parseBps(args.newTargetRatio)
    const maxBps = parseBps(args.newMaxRatio)
    if (!address || targetBps === null || maxBps === null) {
      issues.add(`invalid-${event.eventName}-payload:${event.id}`)
      return
    }
    const strategy = mutableStrategy(states, address)
    strategy.targetDebtRatioBps = targetBps
    return
  }

  // DebtPurchased is contextual only. VaultV3 emits DebtUpdated with the exact
  // post-purchase debt immediately before it, so applying the amount again
  // would double-subtract the same state transition.
}

function checkpointState(
  checkpoint: VaultAccountingCheckpoint,
  strategies: Map<string, MutableStrategyState>,
  accumulatedIssues: Set<string>
): AllocationState {
  const totalAssets = parseUint(checkpoint.totalAssets)
  const totalDebt = parseUint(checkpoint.totalDebt)
  const totalIdle = parseUint(checkpoint.totalIdle)
  const parsedBlockTimestamp = parseUnixTimestamp(checkpoint.blockTimestamp)
  const issues = new Set(accumulatedIssues)
  if (totalAssets === null || totalDebt === null || totalIdle === null) {
    issues.add(`invalid-checkpoint-totals:${checkpoint.id}`)
  }
  if (totalAssets !== null && totalDebt !== null && totalIdle !== null && totalAssets !== totalDebt + totalIdle) {
    issues.add(`checkpoint-accounting-values-mismatch:${checkpoint.id}`)
  }
  if (!checkpoint.accountingIdentityHolds) issues.add(`accounting-identity-failed:${checkpoint.id}`)
  if (!checkpoint.canonicalBlockVerified) issues.add(`canonical-block-unverified:${checkpoint.id}`)
  if (parsedBlockTimestamp === null) issues.add(`invalid-block-timestamp:${checkpoint.id}`)

  const assets = totalAssets ?? 0n
  const strategyValues = Array.from(strategies.values())
  const replayedTotalDebt = strategyValues.reduce((sum, strategy) => sum + strategy.currentDebt, 0n)
  if (totalDebt !== null && replayedTotalDebt !== totalDebt) {
    issues.add(`strategy-debt-sum-mismatch:${checkpoint.id}`)
  }
  const rows = strategyValues
    .filter((strategy) => strategy.active || strategy.currentDebt > 0n || strategy.targetDebtRatioBps !== null)
    .sort((left, right) => left.address.localeCompare(right.address))
    .map(
      (strategy): AllocationStateStrategy => ({
        strategyAddress: strategy.address,
        name: null,
        currentDebt: strategy.currentDebt.toString(),
        currentDebtBps: bps(strategy.currentDebt, assets),
        maxDebt: strategy.maxDebt?.toString() ?? null,
        maxDebtBps: strategy.maxDebt === null ? null : bps(strategy.maxDebt, assets),
        targetDebtRatioBps: strategy.targetDebtRatioBps,
        isActive: strategy.active
      })
    )

  return {
    id: checkpoint.id,
    chainId: checkpoint.chainId,
    vaultAddress: checkpoint.vaultAddress,
    blockNumber: checkpoint.blockNumber,
    blockTimestamp: parsedBlockTimestamp ?? 0,
    timestampUtc: timestampUtc(parsedBlockTimestamp ?? 0),
    blockHash: checkpoint.blockHash,
    totalAssets: checkpoint.totalAssets,
    totalDebt: checkpoint.totalDebt,
    totalIdle: checkpoint.totalIdle,
    unallocatedBps: totalAssets !== null && totalAssets > 0n && totalIdle !== null ? bps(totalIdle, totalAssets) : null,
    strategies: rows,
    sourceEventIds: checkpoint.sourceEventIds,
    accountingIdentityHolds: checkpoint.accountingIdentityHolds,
    canonicalBlockVerified: checkpoint.canonicalBlockVerified,
    complete: issues.size === 0,
    issues: Array.from(issues)
  }
}

function compareEvents(left: AllocationSourceEvent, right: AllocationSourceEvent): number {
  return (
    left.blockNumber - right.blockNumber ||
    left.transactionIndex - right.transactionIndex ||
    left.logIndex - right.logIndex ||
    left.id.localeCompare(right.id)
  )
}

export function buildAllocationStates(
  sourceEvents: readonly AllocationSourceEvent[],
  accountingCheckpoints: readonly VaultAccountingCheckpoint[]
): AllocationState[] {
  const events = [...sourceEvents].sort(compareEvents)
  const checkpoints = [...accountingCheckpoints].sort((left, right) => left.blockNumber - right.blockNumber)
  const strategies = new Map<string, MutableStrategyState>()
  const issues = new Set<string>()
  const states: AllocationState[] = []
  let eventIndex = 0

  for (const checkpoint of checkpoints) {
    while (events[eventIndex] && events[eventIndex].blockNumber <= checkpoint.blockNumber) {
      applyEvent(strategies, events[eventIndex], issues)
      eventIndex += 1
    }
    states.push(checkpointState(checkpoint, strategies, issues))
  }
  return states
}
