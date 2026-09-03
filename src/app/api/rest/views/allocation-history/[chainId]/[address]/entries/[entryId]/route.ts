import { DatabaseConfigurationError, DatabaseUpstreamError } from '@/lib/database/client'
import { json, options } from '@/lib/http'
import {
  AllocationHistoryEntryNotFoundError,
  AllocationHistoryNotMaterializedError
} from '@/lib/kong-allocation/repository'
import { getKongAllocationHistoryEntry } from '@/lib/kong-allocation/service'
import { findTestVault } from '@/lib/kong-allocation/vaults'

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n

export const dynamic = 'force-dynamic'

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function runId(value: string | null): string | null | undefined {
  if (value === null) return null
  if (!/^\d+$/.test(value)) return undefined
  try {
    const parsed = BigInt(value)
    return parsed > 0n && parsed <= POSTGRES_BIGINT_MAX ? value : undefined
  } catch {
    return undefined
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ chainId: string; address: string; entryId: string }> }
) {
  const params = await context.params
  const chainId = parsePositiveInteger(params.chainId)
  if (chainId === null) return json({ error: 'Invalid chainId parameter' }, { status: 400 })
  if (!ADDRESS_PATTERN.test(params.address)) return json({ error: 'Invalid vault address parameter' }, { status: 400 })
  if (params.entryId.length === 0 || params.entryId.length > 512) {
    return json({ error: 'Invalid allocation history entry ID' }, { status: 400 })
  }

  const vault = findTestVault(chainId, params.address)
  if (!vault) return json({ error: 'Allocation history is not enabled for this test vault' }, { status: 404 })
  const selectedRunId = runId(new URL(request.url).searchParams.get('runId'))
  if (selectedRunId === undefined) return json({ error: 'runId is invalid' }, { status: 400 })

  try {
    const detail = await getKongAllocationHistoryEntry({
      vault,
      entryId: params.entryId,
      runId: selectedRunId
    })
    return json(detail, {
      request,
      cacheControl:
        detail.dataQuality.certification === 'provisional'
          ? 'no-store'
          : 'public, max-age=900, s-maxage=900, stale-while-revalidate=600'
    })
  } catch (error) {
    if (error instanceof AllocationHistoryEntryNotFoundError) {
      return json({ error: error.message }, { status: 404 })
    }
    if (
      error instanceof DatabaseConfigurationError ||
      error instanceof DatabaseUpstreamError ||
      error instanceof AllocationHistoryNotMaterializedError
    ) {
      return json({ error: error.message }, { status: 503 })
    }
    return json(
      { error: error instanceof Error ? error.message : 'Allocation history detail lookup failed' },
      { status: 500 }
    )
  }
}

export function OPTIONS() {
  return options()
}
