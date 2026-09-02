const endpoints = [
  {
    method: 'GET',
    path: '/api/allocations?vault=0x…&chainId=1',
    description: 'DOA optimizer intent overlaid with certified Envio executed allocation states.'
  },
  {
    method: 'GET',
    path: '/api/health',
    description: 'Serving readiness, database reachability, certification, and refresh status.'
  },
  {
    method: 'GET',
    path: '/api/rest/views/allocation-history/1/0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204?projection=chart',
    description: 'Compact chart entries with a separate current snapshot and run-pinned full-detail links.'
  }
]

export default function Home() {
  return (
    <main>
      <header>
        <p className="eyebrow">YEARn DATA INFRASTRUCTURE</p>
        <h1>Allocation history, with its evidence attached.</h1>
        <p className="lede">
          A small Next.js service that keeps optimizer intent and executed vault state distinct, materializes
          chart-ready allocation entries, then serves them to consumers such as Kong and Powerglove.
        </p>
      </header>

      <section className="status" aria-label="Contract summary">
        <div>
          <span>EXECUTION EVIDENCE</span>
          <strong>Envio + RPC</strong>
        </div>
        <div>
          <span>REST READ MODEL</span>
          <strong>Postgres</strong>
        </div>
        <div>
          <span>OPTIONAL POLICY</span>
          <strong>DOA</strong>
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
