import { json } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function GET() {
  const upstreams = {
    envioAllocationHistory: Boolean(process.env.ENVIO_ALLOCATION_GRAPHQL_URL),
    immutableCoverageRevision: Boolean(process.env.ENVIO_ALLOCATION_COVERAGE_REVISION),
    doaOptimizationRedis: Boolean(
      process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
    )
  }
  return json({
    status: Object.values(upstreams).every(Boolean) ? 'ok' : 'degraded',
    service: 'yearn-allocation-service',
    timestamp: new Date().toISOString(),
    upstreams
  })
}
