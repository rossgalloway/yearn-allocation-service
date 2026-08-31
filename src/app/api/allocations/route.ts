import { AllocationCoverageError, getAllocationTimeline } from '@/lib/allocation/service'
import { DoaConfigurationError, DoaUpstreamError, readDoaOptimizations } from '@/lib/doa/client'
import { enrichDoaOptimizations, selectVaultDoaOptimizations } from '@/lib/doa/overlay'
import { AllocationReplayLimitError, EnvioConfigurationError, EnvioUpstreamError } from '@/lib/envio/client'
import { json, options } from '@/lib/http'

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

export const dynamic = 'force-dynamic'

function enabled(value: string | null): boolean {
  return value === '1' || value === 'true'
}

function positiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

interface ApiFailure {
  code: string
  message: string
  httpStatus: number
}

function allocationFailure(error: unknown): ApiFailure {
  if (error instanceof AllocationCoverageError) {
    return { code: 'coverage-unavailable', message: error.message, httpStatus: 409 }
  }
  if (error instanceof EnvioConfigurationError) {
    return { code: 'envio-not-configured', message: error.message, httpStatus: 503 }
  }
  if (error instanceof AllocationReplayLimitError) {
    return { code: 'replay-limit-exceeded', message: error.message, httpStatus: 422 }
  }
  if (error instanceof EnvioUpstreamError) {
    return { code: 'envio-unavailable', message: error.message, httpStatus: 502 }
  }
  return {
    code: 'allocation-processing-failed',
    message: error instanceof Error ? error.message : 'Unknown allocation service error',
    httpStatus: 500
  }
}

function optimizerFailure(error: unknown): { status: 'not-configured' | 'unavailable'; error: ApiFailure } {
  if (error instanceof DoaConfigurationError) {
    return {
      status: 'not-configured',
      error: { code: 'doa-not-configured', message: error.message, httpStatus: 503 }
    }
  }
  if (error instanceof DoaUpstreamError) {
    return {
      status: 'unavailable',
      error: { code: 'doa-unavailable', message: error.message, httpStatus: 502 }
    }
  }
  return {
    status: 'unavailable',
    error: {
      code: 'doa-processing-failed',
      message: error instanceof Error ? error.message : 'Unknown DOA optimization error',
      httpStatus: 500
    }
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const vaultAddress = url.searchParams.get('vault')?.toLowerCase() ?? ''
  const chainId = positiveInteger(url.searchParams.get('chainId'))
  if (!ADDRESS_PATTERN.test(vaultAddress)) return json({ error: 'Invalid or missing vault parameter' }, { status: 400 })
  if (chainId === null) return json({ error: 'Invalid or missing chainId parameter' }, { status: 400 })

  const unsafeRequested = enabled(url.searchParams.get('includeUnsafe'))
  const unsafeEnabled = process.env.ALLOW_UNSAFE_ALLOCATION_DATA === 'true'
  if (unsafeRequested && !unsafeEnabled) {
    return json({ error: 'Unsafe allocation reads are disabled by service configuration' }, { status: 403 })
  }
  const limit = Math.min(500, positiveInteger(url.searchParams.get('limit')) ?? 100)
  const optimizationLimit = Math.min(500, positiveInteger(url.searchParams.get('optimizationLimit')) ?? 100)
  const beforeBlock = positiveInteger(url.searchParams.get('beforeBlock'))
  const fromBlock = positiveInteger(url.searchParams.get('fromBlock'))

  const [timelineResult, doaResult] = await Promise.allSettled([
    getAllocationTimeline({
      chainId,
      vaultAddress,
      coverageRevision: url.searchParams.get('coverageRevision') ?? undefined,
      allowUnsafe: unsafeRequested && unsafeEnabled
    }),
    readDoaOptimizations(chainId)
  ])

  const timeline = timelineResult.status === 'fulfilled' ? timelineResult.value : null
  const timelineError = timelineResult.status === 'rejected' ? allocationFailure(timelineResult.reason) : null
  const eligibleStates =
    timeline?.states.filter(
      (state) =>
        (beforeBlock === null || state.blockNumber < beforeBlock) &&
        (fromBlock === null || state.blockNumber >= fromBlock)
    ) ?? []
  const page = eligibleStates.slice(-limit)
  const hasMore = eligibleStates.length > page.length
  const executed = timeline
    ? {
        status: timeline.provisional ? ('provisional' as const) : ('certified' as const),
        coverage: timeline.coverage,
        complete: timeline.complete,
        provisional: timeline.provisional,
        sourceEventCount: timeline.sourceEventCount,
        checkpointCount: timeline.checkpointCount,
        unresolvedCheckpointFailures: timeline.unresolvedCheckpointFailures,
        states: page,
        pagination: {
          order: 'ascending' as const,
          hasMore,
          nextBeforeBlock: hasMore ? (page[0]?.blockNumber ?? null) : null
        },
        error: null
      }
    : {
        status: 'unavailable' as const,
        coverage: null,
        complete: false,
        provisional: false,
        sourceEventCount: 0,
        checkpointCount: 0,
        unresolvedCheckpointFailures: [],
        states: [],
        pagination: { order: 'ascending' as const, hasMore: false, nextBeforeBlock: null },
        error: timelineError
          ? { code: timelineError.code, message: timelineError.message }
          : { code: 'allocation-unavailable', message: 'Executed allocation state is unavailable' }
      }

  let optimizer:
    | {
        status: 'available' | 'empty'
        records: ReturnType<typeof enrichDoaOptimizations>
        error: null
      }
    | {
        status: 'not-configured' | 'unavailable'
        records: []
        error: { code: string; message: string }
      }

  if (doaResult.status === 'fulfilled') {
    const selected = selectVaultDoaOptimizations(doaResult.value, vaultAddress, optimizationLimit)
    const records = enrichDoaOptimizations(selected, timeline)
    optimizer = {
      status: records.length > 0 ? 'available' : 'empty',
      records,
      error: null
    }
  } else {
    const failure = optimizerFailure(doaResult.reason)
    optimizer = {
      status: failure.status,
      records: [],
      error: { code: failure.error.code, message: failure.error.message }
    }
  }

  const hasUsefulData = timeline !== null || optimizer.records.length > 0
  return json(
    {
      chainId,
      vaultAddress,
      executed,
      optimizer
    },
    {
      status: hasUsefulData ? 200 : (timelineError?.httpStatus ?? 500),
      cacheControl: timeline?.complete ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=60' : 'no-store'
    }
  )
}

export function OPTIONS() {
  return options()
}
