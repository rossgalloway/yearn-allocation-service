import type { DoaOptimizationRecord } from './types'

function timestampSeconds(timestampUtc: string | null): number | null {
  if (!timestampUtc) return null
  const milliseconds = Date.parse(timestampUtc.replace(' UTC', 'Z').replace(' ', 'T'))
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null
}

function sortTimestamp(record: DoaOptimizationRecord): number {
  const parsed = timestampSeconds(record.freshness.optimizationTimestampUtc)
  if (parsed !== null) return parsed
  return record.source.isLatestAlias ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER
}

function recordIdentity(record: DoaOptimizationRecord): string {
  return JSON.stringify({
    timestampUtc: record.freshness.optimizationTimestampUtc,
    vault: record.vault,
    strategyDebtRatios: record.strategyDebtRatios,
    currentApr: record.currentApr,
    proposedApr: record.proposedApr,
    explain: record.explain
  })
}

export function selectVaultDoaOptimizations(
  records: readonly DoaOptimizationRecord[],
  vaultAddress: string,
  limit: number
): DoaOptimizationRecord[] {
  const vault = vaultAddress.toLowerCase()
  const sorted = records
    .filter((record) => record.vault.toLowerCase() === vault)
    .sort(
      (left, right) =>
        sortTimestamp(right) - sortTimestamp(left) ||
        Number(left.source.isLatestAlias) - Number(right.source.isLatestAlias) ||
        left.source.key.localeCompare(right.source.key)
    )
  const identities = new Set<string>()
  const selected: DoaOptimizationRecord[] = []
  for (const record of sorted) {
    const identity = recordIdentity(record)
    if (identities.has(identity)) continue
    identities.add(identity)
    selected.push(record)
    if (selected.length === limit) break
  }
  return selected
}
