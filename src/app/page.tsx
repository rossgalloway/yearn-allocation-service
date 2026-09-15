import { listTestVaults } from '@/lib/kong-allocation/vaults'

export const dynamic = 'force-dynamic'

export default function Home() {
  const vaults = listTestVaults()
  return (
    <main>
      <header>
        <p className="eyebrow">YEARN · ALLOCATION HISTORY REFERENCE</p>
        <h1>Explore the data behind allocation history.</h1>
        <p className="lede">
          A working reference for Kong’s chart and action-detail API. Open a vault’s chart response, then follow an
          entry’s detailsHref to inspect its transactions, balances and execution evidence in the same published run.
        </p>
      </header>
      <section className="status" aria-label="Processing responsibilities">
        <div>
          <span>EVENT ACQUISITION</span>
          <strong>Envio reader</strong>
        </div>
        <div>
          <span>RECONSTRUCTION</span>
          <strong>Historical RPC</strong>
        </div>
        <div>
          <span>PREPARED RESPONSES</span>
          <strong>Postgres runs</strong>
        </div>
      </section>
      <section>
        <div className="section-heading">
          <h2>EXPLORE A VAULT</h2>
          <p className="section-copy">
            Chart responses contain raw amounts, asset decimals, coverage, a current snapshot, and run-pinned detail
            links. Provisional coverage remains explicit even when balances reconcile.
          </p>
        </div>
        <div className="endpoint-list">
          {vaults.map((vault) => {
            const path = `/api/rest/views/allocation-history/${vault.chainId}/${vault.address.toLowerCase()}`
            return (
              <article key={`${vault.chainId}:${vault.address}`}>
                <div className="route">
                  <span>GET</span>
                  <code>
                    {vault.label} · chain {vault.chainId}
                    <br />
                    {vault.address}
                  </code>
                </div>
                <p className="endpoint-copy">
                  <a href={`${path}?projection=chart`}>Compact chart JSON</a>
                  <br />
                  <a href={`${path}?projection=full`}>All prepared actions JSON</a>
                </p>
              </article>
            )
          })}
        </div>
      </section>
      <footer>
        <p className="footer-copy">
          Historical states are block-end balances. Interval flows include activity between chart points; optimizer APR
          changes are proposal estimates. Follow pagination.nextCursor to explore older entries without changing runs.
        </p>
        <p className="footer-copy">
          <a href="/api/health">Serving readiness and refresh status</a>
        </p>
      </footer>
    </main>
  )
}
