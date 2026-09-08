import { databaseConfigured } from '@/lib/database/client'
import { json } from '@/lib/http'
import {
  ALLOCATION_MATERIALIZER_VERSION,
  ALLOCATION_SCHEMA_VERSION,
  probeDatabase,
  readAllocationMaterializationStatuses
} from '@/lib/kong-allocation/repository'
import { listTestVaults } from '@/lib/kong-allocation/vaults'

export const dynamic = 'force-dynamic'

function staleRunMilliseconds(): number {
  const parsed = Number.parseInt(process.env.ALLOCATION_STALE_RUN_SECONDS ?? '', 10)
  return (Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 6 * 60 * 60) * 1_000
}

export async function GET() {
  const vaults = listTestVaults()
  const ingestion = {
    envioAllocationHistory: Boolean(process.env.ENVIO_ALLOCATION_GRAPHQL_URL),
    archiveRpcs: vaults.every((vault) => Boolean(process.env[`RPC_URL_${vault.chainId}`]?.trim())),
    immutableCoverageRevision: Boolean(process.env.ENVIO_ALLOCATION_COVERAGE_REVISION)
  }
  const doaOptimizationRedis = Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  )
  const configuredSource = process.env.ALLOCATION_HISTORY_SOURCE?.trim().toLowerCase() || 'live'
  const sourceValid = configuredSource === 'database' || configuredSource === 'live'
  const allowUncertifiedMaterializations =
    process.env.ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION?.trim().toLowerCase() === 'true'
  const postgresConfigured = databaseConfigured()
  const useDatabase = configuredSource === 'database'
  const postgresReachable = postgresConfigured ? await probeDatabase() : false
  const materializations = postgresReachable ? await readAllocationMaterializationStatuses().catch(() => []) : []
  const expectedRevision = process.env.ENVIO_ALLOCATION_COVERAGE_REVISION?.trim() || null
  const validMaterializations = materializations.filter(
    (item) =>
      item.runId !== null &&
      (item.coverageSafeForTimeline === true || allowUncertifiedMaterializations) &&
      item.schemaVersion === ALLOCATION_SCHEMA_VERSION &&
      item.materializerVersion === ALLOCATION_MATERIALIZER_VERSION &&
      item.entryCount !== null &&
      item.entryCount > 0 &&
      (allowUncertifiedMaterializations || expectedRevision === null || item.coverageRevision === expectedRevision)
  )
  const activeVaults = new Set(
    validMaterializations.map((item) => `${item.chainId}:${item.vaultAddress.toLowerCase()}`)
  )
  const servingReady =
    sourceValid &&
    (useDatabase
      ? postgresReachable &&
        vaults.every((vault) => activeVaults.has(`${vault.chainId}:${vault.address.toLowerCase()}`))
      : Object.values(ingestion).every(Boolean))
  const staleCutoff = Date.now() - staleRunMilliseconds()
  const refreshHealthy = materializations.every((item) => {
    if (item.latestAttemptStatus === 'failed') return false
    if (item.latestAttemptStatus !== 'running') return true
    const startedAt = item.latestAttemptStartedAt ? Date.parse(item.latestAttemptStartedAt) : Number.NaN
    return Number.isFinite(startedAt) && startedAt > staleCutoff
  })
  return json({
    status: servingReady && refreshHealthy ? 'ok' : 'degraded',
    service: 'yearn-allocation-service',
    timestamp: new Date().toISOString(),
    serving: {
      source: sourceValid ? configuredSource : 'invalid',
      sourceValid,
      ready: servingReady,
      allowUncertifiedMaterializations,
      expectedCoverageRevision: expectedRevision,
      postgres: { configured: postgresConfigured, reachable: postgresReachable }
    },
    ingestion: {
      configured: Object.values(ingestion).every(Boolean),
      refreshHealthy,
      upstreams: ingestion,
      optional: { doaOptimizationRedis }
    },
    materializations
  })
}
