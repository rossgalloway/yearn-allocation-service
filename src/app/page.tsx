const endpoints = [
  {
    method: 'GET',
    path: '/api/allocations?vault=0x…&chainId=1',
    description: 'DOA optimizer intent overlaid with certified Envio executed allocation states.'
  },
  {
    method: 'GET',
    path: '/api/health',
    description: 'Liveness and non-secret upstream configuration status.'
  }
]

export default function Home() {
  return (
    <main>
      <header>
        <p className="eyebrow">YEARn DATA INFRASTRUCTURE</p>
        <h1>Allocation history, with its evidence attached.</h1>
        <p className="lede">
          A small Next.js service that keeps optimizer intent and executed vault state distinct, then serves both to
          consumers such as Kong and Powerglove.
        </p>
      </header>

      <section className="status" aria-label="Contract summary">
        <div>
          <span>EXECUTED STATE</span>
          <strong>Envio</strong>
        </div>
        <div>
          <span>OPTIMIZER INTENT</span>
          <strong>DOA</strong>
        </div>
        <div>
          <span>ENRICHMENT</span>
          <strong>Timestamp-aligned</strong>
        </div>
      </section>

      <section>
        <div className="section-heading">
          <h2>API</h2>
          <p className="section-copy">
            Responses are CORS-enabled and CDN-cacheable only after a successful upstream read.
          </p>
        </div>
        <div className="endpoint-list">
          {endpoints.map((endpoint) => (
            <article key={endpoint.path}>
              <div className="route">
                <span>{endpoint.method}</span>
                <code>{endpoint.path}</code>
              </div>
              <p className="endpoint-copy">{endpoint.description}</p>
            </article>
          ))}
        </div>
      </section>

      <footer>
        <p className="footer-copy">
          DOA residuals describe optimizer scope, not idle capital. Unallocated allocation is exposed only when a
          certified Envio checkpoint proves it at the optimizer timestamp.
        </p>
      </footer>
    </main>
  )
}
