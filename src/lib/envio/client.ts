const REQUEST_TIMEOUT_MS = 15_000

export class EnvioConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvioConfigurationError'
  }
}

export class EnvioUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EnvioUpstreamError'
  }
}

export class AllocationReplayLimitError extends Error {
  constructor(limit: number) {
    super(`Allocation history exceeds the configured replay limit of ${limit} events`)
    this.name = 'AllocationReplayLimitError'
  }
}

function graphqlUrl(): string {
  const value = process.env.ENVIO_ALLOCATION_GRAPHQL_URL?.trim()
  if (!value) {
    throw new EnvioConfigurationError('ENVIO_ALLOCATION_GRAPHQL_URL is not configured')
  }
  return value
}

export async function envioGraphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const url = graphqlUrl()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  const token = process.env.ENVIO_ALLOCATION_GRAPHQL_TOKEN?.trim()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store'
    })
  } catch (error) {
    throw new EnvioUpstreamError('Unable to reach Envio Allocation History', { cause: error })
  }

  if (!response.ok) {
    throw new EnvioUpstreamError(`Envio Allocation History returned HTTP ${response.status}`)
  }

  const payload = (await response.json()) as {
    data?: T
    errors?: Array<{ message?: string }>
  }
  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message ?? 'Unknown GraphQL error').join('; ')
    throw new EnvioUpstreamError(`Envio GraphQL error: ${message}`)
  }
  if (!payload.data) {
    throw new EnvioUpstreamError('Envio GraphQL response did not contain data')
  }
  return payload.data
}
