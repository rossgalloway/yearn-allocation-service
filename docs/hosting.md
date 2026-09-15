# Hosted reference API

The Kong test environment serves a fixed dataset, refreshed on demand.

Public base URL: `https://yearn-allocation-reference.vercel.app`.
Powerglove's `VITE_PUBLIC_ALLOCATION_HISTORY_API_URL` is
`https://yearn-allocation-reference.vercel.app/api/rest/views/allocation-history`.

## Infrastructure

- Vercel project: `rossgalloways-projects/yearn-allocation-reference`.
- GitHub repository: `rossgalloway/yearn-allocation-service`; production branch: `main`.
- Neon resource: `yearn-allocation-reference`, Free plan (`free_v3`), region `iad1`.
- Vercel uses the same region and a pooled TLS connection with the `allocation_api_reader` role.
- The API role has SELECT access to the three prepared-history tables and defaults to read-only transactions.
- Envio, archive RPC credentials, reconstruction jobs, and the historical RPC cache remain on the local worker.

The initial snapshot contains two immutable yvUSDC-1 runs, each with 1,877 entries. Run 2 is active, through block
25,949,082. Coverage is provisional. Both runs were restored with their original IDs, payloads, and sequences.
The standalone local restore occupied 37 MB including database overhead; the compressed migration archive was 3.5 MB.
These figures describe the initial cohort, not a budget for every vault or unlimited retained runs.

## Serving configuration

Production uses:

- `DATABASE_URL`: sensitive, pooled URL for `allocation_api_reader`, with `sslmode=verify-full`.
- `DATABASE_MAX_CONNECTIONS=2`.
- `DATABASE_CONNECTION_TIMEOUT_MS=15000`, allowing time for an idle database to wake.
- `ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION=true`.
- `ALLOCATION_VAULTS_JSON`: chain 1, address `0xbe53a109b494e5c9f97b9cd39fe969be68bf6204`, label `yvUSDC-1`.

The reader's database-level role setting resolves the `allocation_reference` schema without session-level SET commands.
The hosted database contains the serving snapshot only. Do not run the reconstruction CLI or schema migrations against
it using the API credentials. The snapshot's migration tracking includes the source worker's cache migration, but the
cache tables and their data were intentionally excluded from the serving export.

Neon's automatic project connection supplies owner credentials. That connection was removed after migration; production
uses a manually configured read-only URL. The Neon resource remains in the same Vercel team and is managed from Storage.
Do not reconnect it automatically to production without reviewing the resulting environment-variable changes.

`/api/health` should report `serving.ready: true`. Its ingestion configuration is intentionally absent on Vercel.
There is no scheduled refresh. The safe-block timestamp in responses describes the dataset's actual endpoint.

## Updating the dataset

Reconstruct and validate new runs on the worker first. Publication must append complete immutable runs and entries,
preserve existing run IDs, advance identity sequences, and switch the active-run pointer transactionally. Existing
cursor and detail links must remain valid. An append-publication command is not implemented yet; the initial dump/restore
procedure is for an empty target and must not be replayed over the live database.

Keep local copies of published runs. Neon Free has limited restore history and a 0.5 GB storage allowance; retained runs
consume space. Monitor storage, compute, and database outbound transfer before expanding the cohort. Do not silently prune
runs that have been shared with consumers.

## Deployment checks

After deploying, verify the public health endpoint, both chart pages through a returned cursor, a returned run-pinned
detail URL, and browser CORS. Validate the resulting chart with Powerglove's parser and interval reconciliation. Keep
provisional quality and original safe-block timestamps intact.

Initial hosted validation on 2026-09-15 passed health, two chart pages (25 entries each), a run-2 detail request, and
cross-origin response headers. Powerglove's existing parser accepted both pages and built 51 panels with no reconciliation
issues. The production build and TypeScript checks passed on Vercel. The deployment upload contained no environment files.

Vercel's native GitHub integration deploys pushes to `main`. Other branches do not automatically deploy because database
credentials are configured only for production. GitHub Actions runs the verification workflow; the former Yearn-specific
deployment workflow is removed. No database work occurs during a build or public API request. Refreshing the hosted dataset
remains a separate manual operation from deploying API code.

`.vercelignore` explicitly excludes local environment files, dependencies, and build output. Vercel CLI uploads must not
rely on `.gitignore` for credential exclusion. Check the deployment file listing before sharing a new deployment.
