import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { json } from './http'

describe('JSON responses', () => {
  it('gzip-compresses responses when the client accepts gzip', async () => {
    const request = new Request('https://example.test', { headers: { 'Accept-Encoding': 'br, gzip' } })
    const response = json({ status: 'ok' }, { request })

    expect(response.headers.get('Content-Encoding')).toBe('gzip')
    expect(response.headers.get('Vary')).toBe('Accept-Encoding')
    const body = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')
    expect(JSON.parse(body)).toEqual({ status: 'ok' })
  })

  it('keeps JSON uncompressed when gzip is not accepted', async () => {
    const response = json({ status: 'ok' })

    expect(response.headers.get('Content-Encoding')).toBeNull()
    expect(await response.json()).toEqual({ status: 'ok' })
  })
})
