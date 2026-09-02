import type { TimelineDirection } from './types'

interface AllocationHistoryCursorPayload {
  version: 1
  projectionId: string
  runId: string
  direction: TimelineDirection
  endBlock: number
  entryId: string
}

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n

export class AllocationHistoryCursorError extends Error {
  constructor(message = 'Invalid allocation history cursor') {
    super(message)
    this.name = 'AllocationHistoryCursorError'
  }
}

function validIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false
  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX
  } catch {
    return false
  }
}

export function encodeAllocationHistoryCursor(payload: AllocationHistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodeAllocationHistoryCursor(
  value: string,
  expectedDirection: TimelineDirection
): AllocationHistoryCursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new AllocationHistoryCursorError()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AllocationHistoryCursorError()
  const candidate = parsed as Partial<AllocationHistoryCursorPayload>
  if (
    candidate.version !== 1 ||
    !validIdentifier(candidate.projectionId) ||
    !validIdentifier(candidate.runId) ||
    (candidate.direction !== 'asc' && candidate.direction !== 'desc') ||
    candidate.direction !== expectedDirection ||
    !Number.isSafeInteger(candidate.endBlock) ||
    (candidate.endBlock as number) < 0 ||
    typeof candidate.entryId !== 'string' ||
    candidate.entryId.length === 0
  ) {
    throw new AllocationHistoryCursorError()
  }
  return candidate as AllocationHistoryCursorPayload
}
