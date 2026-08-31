import { NextResponse } from 'next/server'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

export function json(data: unknown, init?: { status?: number; cacheControl?: string }): NextResponse {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': init?.cacheControl ?? 'no-store'
    }
  })
}

export function options(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=0' }
  })
}
