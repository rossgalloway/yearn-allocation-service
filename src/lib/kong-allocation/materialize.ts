import {
  ArchiveRpcUpstreamError,
  type ContractCall,
  contractSelectors,
  decodeUint,
  encodeAddressCall,
  encodeAddressPairCall,
  readContractCalls,
  readVaultDebtAllocators
} from './rpc'
import type { Address, AllocationSourceEvent, AllocationState, AllocationStateStrategy } from './types'

export interface StateBlock {
  blockNumber: number
  blockTimestamp: number
  stateGranularity: AllocationState['stateGranularity']
}

interface StrategyReference {
  address: Address
  firstSeenBlock: number
}

interface AllocatorReference {
  address: Address
  assignedBlock: number
}

function address(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value.toLowerCase() as Address) : null
}

function strategyReferences(events: readonly AllocationSourceEvent[]): StrategyReference[] {
  const firstSeen = new Map<Address, number>()
  const add = (strategyAddress: Address, blockNumber: number) => {
    const current = firstSeen.get(strategyAddress)
    if (current === undefined || blockNumber < current) firstSeen.set(strategyAddress, blockNumber)
  }
  for (const event of events) {
    if (event.strategyAddress) add(event.strategyAddress, event.blockNumber)
    const queue = event.args.newDefaultQueue
    if (Array.isArray(queue)) {
      for (const item of queue) {
        const strategyAddress = address(item)
        if (strategyAddress) add(strategyAddress, event.blockNumber)
      }
    }
  }
  return [...firstSeen].map(([strategyAddress, firstSeenBlock]) => ({ address: strategyAddress, firstSeenBlock }))
}

function allocatorReferences(events: readonly AllocationSourceEvent[]): AllocatorReference[] {
  return events
    .filter((event) => event.eventName === 'NewDebtAllocator' || event.eventName === 'UpdateDebtAllocator')
    .map((event) => ({
      address: address(event.eventName === 'UpdateDebtAllocator' ? event.args.debtAllocator : event.args.allocator),
      assignedBlock: event.blockNumber
    }))
    .filter((item): item is AllocatorReference => item.address !== null)
    .sort((left, right) => left.assignedBlock - right.assignedBlock)
}

function allocatorAtBlock(allocators: readonly AllocatorReference[], blockNumber: number): Address | null {
  let selected: Address | null = null
  for (const allocator of allocators) {
    if (allocator.assignedBlock > blockNumber) break
    selected = allocator.address
  }
  return selected
}

function key(blockNumber: number, field: string, address?: Address): string {
  return `${blockNumber}:${field}${address ? `:${address}` : ''}`
}

function bps(value: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0
  return Number((value * 10_000n + denominator / 2n) / denominator)
}

function safeNumber(value: bigint | null): number | null {
  return value !== null && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
}

function uniqueTransactionHash(events: readonly AllocationSourceEvent[]): AllocationState['transactionHash'] {
  const hashes = [...new Set(events.map((event) => event.transactionHash))]
  return hashes.length === 1 ? hashes[0] : null
}

export interface MaterializedStates {
  states: AllocationState[]
  strategyAddresses: Address[]
}

export async function materializeStates(input: {
  chainId: number
  vaultAddress: Address
  blocks: readonly StateBlock[]
  events: readonly AllocationSourceEvent[]
}): Promise<MaterializedStates> {
  const strategies = strategyReferences(input.events)
  const allocators = allocatorReferences(input.events)
  const rpcAllocators = await readVaultDebtAllocators(
    input.chainId,
    input.vaultAddress,
    input.blocks.map((block) => block.blockNumber)
  )
  const calls = input.blocks.flatMap((block) => {
    const blockCalls: ContractCall[] = [
      {
        key: key(block.blockNumber, 'totalAssets'),
        address: input.vaultAddress,
        data: contractSelectors.totalAssets,
        blockNumber: block.blockNumber
      },
      {
        key: key(block.blockNumber, 'totalDebt'),
        address: input.vaultAddress,
        data: contractSelectors.totalDebt,
        blockNumber: block.blockNumber
      },
      {
        key: key(block.blockNumber, 'totalIdle'),
        address: input.vaultAddress,
        data: contractSelectors.totalIdle,
        blockNumber: block.blockNumber
      }
    ]
    const candidates = strategies.filter((strategy) => strategy.firstSeenBlock <= block.blockNumber)
    const allocator = rpcAllocators.get(block.blockNumber) ?? allocatorAtBlock(allocators, block.blockNumber)
    for (const strategy of candidates) {
      blockCalls.push({
        key: key(block.blockNumber, 'strategy', strategy.address),
        address: input.vaultAddress,
        data: encodeAddressCall(contractSelectors.strategies, strategy.address),
        blockNumber: block.blockNumber
      })
      if (allocator) {
        blockCalls.push({
          key: key(block.blockNumber, 'strategyConfig', strategy.address),
          address: allocator,
          data: encodeAddressPairCall(contractSelectors.strategyConfig, input.vaultAddress, strategy.address),
          blockNumber: block.blockNumber
        })
      }
    }
    return blockCalls
  })
  const results = await readContractCalls(input.chainId, calls)
  const states = input.blocks.map((block): AllocationState => {
    const totalAssets = decodeUint(results.get(key(block.blockNumber, 'totalAssets')) ?? null)
    const indexedTotalDebt = decodeUint(results.get(key(block.blockNumber, 'totalDebt')) ?? null)
    const totalIdle = decodeUint(results.get(key(block.blockNumber, 'totalIdle')) ?? null)
    if (totalAssets === null || totalIdle === null) {
      throw new ArchiveRpcUpstreamError(`Vault accounting calls failed at block ${block.blockNumber}`)
    }

    const allocator = rpcAllocators.get(block.blockNumber) ?? allocatorAtBlock(allocators, block.blockNumber)
    const strategyRows = strategies
      .filter((strategy) => strategy.firstSeenBlock <= block.blockNumber)
      .map((strategy): AllocationStateStrategy => {
        const result = results.get(key(block.blockNumber, 'strategy', strategy.address)) ?? null
        const activation = decodeUint(result, 0)
        const lastReport = decodeUint(result, 1)
        const currentDebt = decodeUint(result, 2) ?? 0n
        const maxDebt = decodeUint(result, 3)
        const strategyConfig = allocator
          ? (results.get(key(block.blockNumber, 'strategyConfig', strategy.address)) ?? null)
          : null
        const allocatorAdded = decodeUint(strategyConfig, 0)
        const targetRatio = decodeUint(strategyConfig, 1)
        const maxRatio = decodeUint(strategyConfig, 2)
        return {
          strategyAddress: strategy.address,
          currentDebt: currentDebt.toString(),
          currentDebtBps: bps(currentDebt, totalAssets),
          maxDebt: maxDebt?.toString() ?? null,
          maxDebtBps: maxDebt === null ? null : bps(maxDebt, totalAssets),
          targetDebtRatioBps: targetRatio !== null && targetRatio <= 10_000n ? Number(targetRatio) : null,
          maxDebtRatioBps: maxRatio !== null && maxRatio <= 10_000n ? Number(maxRatio) : null,
          allocatorAdded: allocatorAdded === null ? null : allocatorAdded !== 0n,
          activation: safeNumber(activation),
          lastReport: safeNumber(lastReport)
        }
      })
      .sort((left, right) => left.strategyAddress.localeCompare(right.strategyAddress))

    const summedDebt = strategyRows.reduce((sum, strategy) => sum + BigInt(strategy.currentDebt), 0n)
    const totalDebt = indexedTotalDebt ?? summedDebt
    const blockEvents = input.events.filter((event) => event.blockNumber === block.blockNumber)
    return {
      id: `allocation-state:${input.chainId}:${input.vaultAddress.toLowerCase()}:${block.blockNumber}`,
      stateGranularity: block.stateGranularity,
      blockNumber: block.blockNumber,
      blockTimestamp: block.blockTimestamp,
      transactionHash: block.stateGranularity === 'latest' ? null : uniqueTransactionHash(blockEvents),
      totalAssets: totalAssets.toString(),
      totalDebt: totalDebt.toString(),
      totalIdle: totalIdle.toString(),
      unallocatedBps: bps(totalIdle, totalAssets),
      allocatorAddress: allocator,
      sourceEventIds: blockEvents.map((event) => event.id),
      strategies: strategyRows
    }
  })
  return {
    states,
    strategyAddresses: strategies.map((strategy) => strategy.address).sort()
  }
}
