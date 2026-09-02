import { describe, expect, it } from 'vitest'
import { buildAllocationChartCurrentSnapshot, buildAllocationChartEntry } from './chart'
import type { Address, AllocationEntryState, AllocationHistoryEntry, Hash, VaultAllocationVault } from './types'

const vaultAddress = '0x00000000000000000000000000000000000000aa' as Address
const first = '0x00000000000000000000000000000000000000b1' as Address
const configured = '0x00000000000000000000000000000000000000b2' as Address
const policyOnly = '0x00000000000000000000000000000000000000b3' as Address
const irrelevant = '0x00000000000000000000000000000000000000b4' as Address
const transactionHash = `0x${'1'.repeat(64)}` as Hash
const vault: VaultAllocationVault = {
  chainId: 1,
  address: vaultAddress,
  name: 'Test vault',
  symbol: 'yvTEST',
  assetAddress: null,
  assetSymbol: 'TEST',
  assetDecimals: 6
}

function state(blockNumber: number, firstDebt: string, totalIdle: string): AllocationEntryState {
  return {
    blockNumber,
    blockTimestamp: blockNumber * 10,
    source: 'archive_rpc',
    totalAssets: '1000',
    totalDebt: (1000n - BigInt(totalIdle)).toString(),
    totalIdle,
    unallocatedBps: null,
    unallocatedSource: null,
    unallocatedCheckpointId: null,
    allocatorAddress: null,
    allocations: [
      {
        strategyAddress: first,
        strategyName: 'First',
        currentDebt: firstDebt,
        currentDebtBps: Number(firstDebt) * 10,
        active: true,
        maxDebt: '1000',
        maxDebtBps: 10_000,
        targetDebtRatioBps: null,
        maxDebtRatioBps: null,
        allocatorAdded: null
      },
      {
        strategyAddress: configured,
        strategyName: 'Configured',
        currentDebt: '0',
        currentDebtBps: 0,
        active: true,
        maxDebt: '0',
        maxDebtBps: 0,
        targetDebtRatioBps: null,
        maxDebtRatioBps: null,
        allocatorAdded: null
      },
      {
        strategyAddress: policyOnly,
        strategyName: 'Policy only',
        currentDebt: '0',
        currentDebtBps: 0,
        active: true,
        maxDebt: '0',
        maxDebtBps: 0,
        targetDebtRatioBps: null,
        maxDebtRatioBps: null,
        allocatorAdded: null
      },
      {
        strategyAddress: irrelevant,
        strategyName: 'Irrelevant',
        currentDebt: '0',
        currentDebtBps: 0,
        active: false,
        maxDebt: '0',
        maxDebtBps: 0,
        targetDebtRatioBps: null,
        maxDebtRatioBps: null,
        allocatorAdded: null
      }
    ],
    accountingChecks: { totalAssetsEqualsDebtPlusIdle: true, strategyDebtSumEqualsTotalDebt: true }
  }
}

function entry(kind: AllocationHistoryEntry['kind'] = 'idle_deallocation'): AllocationHistoryEntry {
  return {
    id: 'allocation-entry:1:vault:100-100',
    kind,
    startBlock: 100,
    endBlock: 100,
    startTimestamp: 1000,
    endTimestamp: 1000,
    before: state(99, '900', '100'),
    after: state(100, '800', '200'),
    changes: {
      totalDebtDelta: '-100',
      totalIdleDelta: '100',
      strategies: [
        {
          strategyAddress: first,
          strategyName: 'First',
          currentDebtBefore: '900',
          currentDebtAfter: '800',
          currentDebtDelta: '-100',
          maxDebtBefore: '1000',
          maxDebtAfter: '1000',
          maxDebtDelta: '0',
          currentDebtBpsBefore: 9000,
          currentDebtBpsAfter: 8000,
          currentDebtBpsDelta: -1000,
          targetDebtRatioBpsBefore: null,
          targetDebtRatioBpsAfter: null,
          maxDebtRatioBpsBefore: null,
          maxDebtRatioBpsAfter: null,
          activeBefore: true,
          activeAfter: true
        }
      ]
    },
    policy: {
      id: 'allocation-policy:test',
      source: 'doa',
      proposal: {
        sourceKey: 'doa:test',
        publishedAt: 900,
        optimizerCurrentApr: 287,
        optimizerProposedApr: 291,
        explain: null
      },
      application: {
        status: 'inferred_from_historical_config',
        blockNumber: null,
        transactionHash: null,
        sourceEventIds: []
      },
      targets: [
        {
          strategyAddress: policyOnly,
          strategyName: 'Policy only',
          currentRatioBps: 0,
          targetRatioBps: 1000,
          maxRatioBps: 1200
        }
      ]
    },
    operations: [
      {
        kind: 'max_debt_updated',
        source: 'envio_event',
        sourceEventIds: ['event:1'],
        eventName: 'UpdatedMaxDebtForStrategy',
        subject: { type: 'strategy', address: configured, name: 'Configured' },
        changes: [{ field: 'maxDebt', before: '0', after: '1000' }]
      }
    ],
    execution: {
      automation: 'automatic',
      mechanism: 'allocator_keeper',
      targetStatus: 'matched',
      transactions: [
        {
          transactionHash,
          blockNumber: 100,
          blockTimestamp: 1000,
          kind: 'allocator_execution',
          originator: { address: null, role: 'unknown', label: null },
          transactionTarget: null,
          inputSelector: null,
          callPath: [],
          traceStatus: 'available',
          immediateVaultCaller: null,
          authorization: { role: 'DEBT_MANAGER', roleMask: null, confirmedAtBlock: null },
          sourceEventIds: ['event:1'],
          triggerReplays: []
        },
        {
          transactionHash,
          blockNumber: 100,
          blockTimestamp: 1000,
          kind: 'strategy_lifecycle_change',
          originator: { address: null, role: 'unknown', label: null },
          transactionTarget: null,
          inputSelector: null,
          callPath: [],
          traceStatus: 'available',
          immediateVaultCaller: null,
          authorization: { role: 'DEBT_MANAGER', roleMask: null, confirmedAtBlock: null },
          sourceEventIds: ['event:2'],
          triggerReplays: []
        }
      ]
    },
    classification: { confidence: 'high', evidence: ['details'], limitations: [] },
    detailsAvailable: false
  }
}

describe('allocation chart projection', () => {
  it('builds a compact flow entry with proposal APR semantics and a stable detail link', () => {
    const result = buildAllocationChartEntry(entry(), vault, '24')

    expect(result).toMatchObject({
      kind: 'idle_deallocation',
      before: { blockNumber: 99, idleBps: 1000 },
      after: { blockNumber: 100, idleBps: 2000 },
      execution: {
        automation: 'automatic',
        mechanism: 'allocator_keeper',
        targetStatus: 'matched',
        transactions: [{ transactionHash, blockNumber: 100 }]
      },
      expectedAprImpact: {
        status: 'available',
        baselineAprBps: 287,
        proposedAprBps: 291,
        deltaAprBps: 4,
        relationship: 'governing_policy',
        applicationStatus: 'inferred_from_historical_config'
      },
      operations: [{ kind: 'max_debt_updated' }],
      classification: { confidence: 'high' },
      detailsAvailable: true
    })
    expect(result?.before.allocations.map((allocation) => allocation.strategyAddress)).toEqual([
      first,
      configured,
      policyOnly
    ])
    expect(result?.after.allocations.map((allocation) => allocation.strategyAddress)).toEqual([
      first,
      configured,
      policyOnly
    ])
    expect(result?.detailsHref).toContain('runId=24')
  })

  it('excludes pure configuration entries from chart entries', () => {
    expect(buildAllocationChartEntry(entry('configuration_change'), vault, '24')).toBeNull()
  })

  it('distinguishes missing policies from policies without APR estimates', () => {
    const withoutPolicy = entry()
    withoutPolicy.policy = null
    expect(buildAllocationChartEntry(withoutPolicy, vault, '24')?.expectedAprImpact).toEqual({
      status: 'unavailable',
      reason: 'no_matched_doa_policy'
    })

    const withoutApr = entry()
    if (!withoutApr.policy) throw new Error('test fixture is missing its policy')
    withoutApr.policy.proposal.optimizerProposedApr = null
    expect(buildAllocationChartEntry(withoutApr, vault, '24')?.expectedAprImpact).toEqual({
      status: 'unavailable',
      reason: 'policy_apr_unavailable'
    })
  })

  it('marks a confirmed policy application inside the flow entry', () => {
    const applied = entry()
    if (!applied.policy) throw new Error('test fixture is missing its policy')
    applied.policy.application = {
      status: 'confirmed',
      blockNumber: 100,
      transactionHash,
      sourceEventIds: ['event:application']
    }

    expect(buildAllocationChartEntry(applied, vault, '24')?.expectedAprImpact).toMatchObject({
      status: 'available',
      relationship: 'applied_in_entry',
      applicationStatus: 'confirmed'
    })
  })

  it('returns a separate current snapshot containing only nonzero strategies', () => {
    const current = entry('current_snapshot')
    current.before = null
    current.after = state(101, '800', '200')

    expect(buildAllocationChartCurrentSnapshot(current)).toMatchObject({
      kind: 'current_snapshot',
      blockNumber: 101,
      blockTimestamp: 1010,
      idleBps: 2000,
      allocations: [{ strategyAddress: first }]
    })
  })
})
