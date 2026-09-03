import { gzipSync } from 'node:zlib'
import { NextResponse } from 'next/server'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

export function json(
  data: unknown,
  init?: { status?: number; cacheControl?: string; request?: Request }
): NextResponse {
  const headers = {
    ...CORS_HEADERS,
    'Cache-Control': init?.cacheControl ?? 'no-store',
    'Content-Type': 'application/json',
    Vary: 'Accept-Encoding'
  }
  const serialized = JSON.stringify(data)
  if (/\bgzip\b/i.test(init?.request?.headers.get('accept-encoding') ?? '')) {
    return new NextResponse(gzipSync(serialized), {
      status: init?.status ?? 200,
      headers: { ...headers, 'Content-Encoding': 'gzip' }
    })
  }
  return new NextResponse(serialized, {
    status: init?.status ?? 200,
    headers
  })
}

export function options(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=0' }
  })
}
