import type { VaultAccountingCheckpoint } from '@/lib/envio/types'
import { blockEndPosition, resolveAllocatorAssignment } from './allocators'
import {
  ArchiveRpcUpstreamError,
  allocatorConfigurationCall,
  type ContractCall,
  contractSelectors,
  decodeUint,
  encodeAddressCall,
  readAllocatorCode,
  readContractCalls,
  readVaultRoleManagers
} from './rpc'
import type {
  Address,
  AllocationSourceEvent,
  AllocationState,
  AllocationStateStrategy,
  AllocatorDeploymentEvidence
} from './types'

export interface StateBlock {
  blockNumber: number
  blockTimestamp: number
  stateGranularity: AllocationState['stateGranularity']
}

interface StrategyReference {
  address: Address
  firstSeenBlock: number
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

function indexedUnallocated(
  checkpoint: VaultAccountingCheckpoint | undefined,
  totalAssets: bigint,
  totalDebt: bigint,
  totalIdle: bigint
): Pick<AllocationState, 'unallocatedBps' | 'unallocatedSource' | 'unallocatedCheckpointId'> {
  if (
    checkpoint?.accountingIdentityHolds !== true ||
    checkpoint.canonicalBlockVerified !== true ||
    !/^\d+$/.test(checkpoint.totalAssets) ||
    !/^\d+$/.test(checkpoint.totalDebt) ||
    !/^\d+$/.test(checkpoint.totalIdle) ||
    BigInt(checkpoint.totalAssets) !== totalAssets ||
    BigInt(checkpoint.totalDebt) !== totalDebt ||
    BigInt(checkpoint.totalIdle) !== totalIdle
  ) {
    return { unallocatedBps: null, unallocatedSource: null, unallocatedCheckpointId: null }
  }
  return {
    unallocatedBps: bps(BigInt(checkpoint.totalIdle), BigInt(checkpoint.totalAssets)),
    unallocatedSource: 'envio_same_block_checkpoint',
    unallocatedCheckpointId: checkpoint.id
  }
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
  checkpoints?: readonly VaultAccountingCheckpoint[]
  deployments?: readonly AllocatorDeploymentEvidence[]
}): Promise<MaterializedStates> {
  const strategies = strategyReferences(input.events)
  const managers = await readVaultRoleManagers(
    input.chainId,
    input.vaultAddress,
    input.blocks.map((block) => block.blockNumber)
  )
  const resolutions = new Map(
    input.blocks.map((block) => [
      block.blockNumber,
      resolveAllocatorAssignment({
        vaultAddress: input.vaultAddress,
        events: input.events,
        at: blockEndPosition(block.blockNumber),
        roleManagerAddress: managers.get(block.blockNumber) ?? null,
        deployments: input.deployments
      })
    ])
  )
  const codes = await readAllocatorCode(
    input.chainId,
    [...resolutions.values()].flatMap((resolution) =>
      resolution.address ? [{ address: resolution.address, blockNumber: resolution.asOfBlock }] : []
    )
  )
  for (const resolution of resolutions.values()) {
    if (!resolution.address) continue
    const code = codes.get(`${resolution.asOfBlock}:${resolution.address}`)
    if (code !== 'code') {
      resolution.support = code === 'no_code' ? 'no_code' : 'unavailable'
      resolution.reason = code === 'no_code' ? 'allocator_has_no_code' : 'allocator_code_unavailable'
    }
  }
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
    const resolution = resolutions.get(block.blockNumber)
    if (!resolution) throw new Error('Missing allocator resolution')
    const allocator = resolution.address
    for (const strategy of candidates) {
      blockCalls.push({
        key: key(block.blockNumber, 'strategy', strategy.address),
        address: input.vaultAddress,
        data: encodeAddressCall(contractSelectors.strategies, strategy.address),
        blockNumber: block.blockNumber
      })
      const configCall = allocatorConfigurationCall(resolution.family, input.vaultAddress, strategy.address)
      if (allocator && resolution.support === 'supported' && configCall) {
        blockCalls.push({
          key: key(block.blockNumber, 'strategyConfig', strategy.address),
          address: allocator,
          data: configCall,
          blockNumber: block.blockNumber
        })
      }
    }
    return blockCalls
  })
  const results = await readContractCalls(input.chainId, calls)
  const checkpoints = new Map(input.checkpoints?.map((checkpoint) => [checkpoint.blockNumber, checkpoint]) ?? [])
  const states = input.blocks.map((block): AllocationState => {
    const totalAssets = decodeUint(results.get(key(block.blockNumber, 'totalAssets')) ?? null)
    const indexedTotalDebt = decodeUint(results.get(key(block.blockNumber, 'totalDebt')) ?? null)
    const totalIdle = decodeUint(results.get(key(block.blockNumber, 'totalIdle')) ?? null)
    if (totalAssets === null || totalIdle === null || indexedTotalDebt === null) {
      throw new ArchiveRpcUpstreamError(`Vault accounting calls failed at block ${block.blockNumber}`)
    }

    const resolution = resolutions.get(block.blockNumber)
    if (!resolution) throw new Error('Missing allocator resolution')
    const allocator = resolution.address
    const strategyRows = strategies
      .filter((strategy) => strategy.firstSeenBlock <= block.blockNumber)
      .map((strategy): AllocationStateStrategy => {
        const result = results.get(key(block.blockNumber, 'strategy', strategy.address)) ?? null
        const activation = decodeUint(result, 0)
        const lastReport = decodeUint(result, 1)
        const currentDebt = decodeUint(result, 2)
        if (currentDebt === null)
          throw new ArchiveRpcUpstreamError(`Strategy accounting call failed at block ${block.blockNumber}`)
        const maxDebt = decodeUint(result, 3)
        const strategyConfig = allocator
          ? (results.get(key(block.blockNumber, 'strategyConfig', strategy.address)) ?? null)
          : null
        if (resolution.support === 'supported' && strategyConfig === null) {
          resolution.support = 'unavailable'
          resolution.reason = 'allocator_configuration_unavailable'
        }
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

    const totalDebt = indexedTotalDebt
    const blockEvents = input.events.filter((event) => event.blockNumber === block.blockNumber)
    const unallocated = indexedUnallocated(checkpoints.get(block.blockNumber), totalAssets, totalDebt, totalIdle)
    return {
      id: `allocation-state:${input.chainId}:${input.vaultAddress.toLowerCase()}:${block.blockNumber}`,
      stateGranularity: block.stateGranularity,
      blockNumber: block.blockNumber,
      blockTimestamp: block.blockTimestamp,
      transactionHash: block.stateGranularity === 'latest' ? null : uniqueTransactionHash(blockEvents),
      totalAssets: totalAssets.toString(),
      totalDebt: totalDebt.toString(),
      totalIdle: totalIdle.toString(),
      ...unallocated,
      allocatorAddress: allocator,
      allocatorResolution: resolution,
      sourceEventIds: blockEvents.map((event) => event.id),
      strategies: strategyRows
    }
  })
  return {
    states,
    strategyAddresses: strategies.map((strategy) => strategy.address).sort()
  }
}
