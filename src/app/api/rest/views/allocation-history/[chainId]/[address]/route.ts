import { DoaConfigurationError, DoaUpstreamError } from '@/lib/doa/client'
import { EnvioConfigurationError, EnvioUpstreamError } from '@/lib/envio/client'
import { json, options } from '@/lib/http'
import { ArchiveRpcConfigurationError, ArchiveRpcUpstreamError } from '@/lib/kong-allocation/rpc'
import { getKongAllocationHistory } from '@/lib/kong-allocation/service'
import type { TimelineDirection } from '@/lib/kong-allocation/types'
import { findTestVault } from '@/lib/kong-allocation/vaults'

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const DEFAULT_STATE_LIMIT = 25
const MAX_STATE_LIMIT = 100

export const dynamic = 'force-dynamic'

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function direction(value: string | null): TimelineDirection | null {
  if (value === null) return 'desc'
  return value === 'asc' || value === 'desc' ? value : null
}

function upstreamFailure(error: unknown): { status: number; message: string } {
  if (
    error instanceof EnvioConfigurationError ||
    error instanceof ArchiveRpcConfigurationError ||
    error instanceof DoaConfigurationError
  ) {
    return { status: 503, message: error.message }
  }
  if (
    error instanceof EnvioUpstreamError ||
    error instanceof ArchiveRpcUpstreamError ||
    error instanceof DoaUpstreamError
  ) {
    return { status: 502, message: error.message }
  }
  return { status: 500, message: error instanceof Error ? error.message : 'Allocation history generation failed' }
}

export async function GET(request: Request, context: { params: Promise<{ chainId: string; address: string }> }) {
  const params = await context.params
  const chainId = parsePositiveInteger(params.chainId)
  if (chainId === null) return json({ error: 'Invalid chainId parameter' }, { status: 400 })
  if (!ADDRESS_PATTERN.test(params.address)) return json({ error: 'Invalid vault address parameter' }, { status: 400 })

  const vault = findTestVault(chainId, params.address)
  if (!vault) return json({ error: 'Allocation history is not enabled for this test vault' }, { status: 404 })

  const url = new URL(request.url)
  const rawLimit = url.searchParams.get('limit')
  const parsedLimit = rawLimit === null ? DEFAULT_STATE_LIMIT : parsePositiveInteger(rawLimit)
  if (parsedLimit === null || parsedLimit > MAX_STATE_LIMIT) {
    return json({ error: `limit must be an integer from 1 to ${MAX_STATE_LIMIT}` }, { status: 400 })
  }
  const selectedDirection = direction(url.searchParams.get('direction'))
  if (selectedDirection === null) return json({ error: 'direction must be asc or desc' }, { status: 400 })

  try {
    const history = await getKongAllocationHistory({
      vault,
      limit: parsedLimit,
      direction: selectedDirection
    })
    return json(history, {
      cacheControl: 'public, max-age=900, s-maxage=900, stale-while-revalidate=600'
    })
  } catch (error) {
    const failure = upstreamFailure(error)
    return json({ error: failure.message }, { status: failure.status })
  }
}

export function OPTIONS() {
  return options()
}
