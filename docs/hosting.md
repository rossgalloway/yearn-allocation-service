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

The current cohort contains 21 active vaults: 13 Ethereum, 2 Base, and 6 Katana, matching
`docs/coverage-review/proposed-vaults.json`. Runs 3–23 contain 25,814 prepared entries and were rebuilt on September 15,
2026. Each response carries its own safe-block timestamp; coverage remains provisional. yvFlexUSDC remains deferred.

The original yvUSDC-1 runs 1 and 2 are retained with their original IDs and entries, so their cursors and detail links
remain valid. Including those retained runs, the serving database has 23 runs and 29,568 entries. The complete local
publication rehearsal occupied 234,568,727 bytes (234.6 MB), about 47% of the conservative 500 MB Free allowance.
After publication, Neon measured 230,359,040 bytes (230.4 MB), about 46% of the 500 MB allowance.
This is room for the current cohort, not unlimited retained refreshes. The historical RPC cache remains on the worker.

## Serving configuration

Production uses:

- `DATABASE_URL`: sensitive, pooled URL for `allocation_api_reader`, with `sslmode=verify-full`.
- `DATABASE_MAX_CONNECTIONS=2`.
- `DATABASE_CONNECTION_TIMEOUT_MS=15000`, allowing time for an idle database to wake.
- `ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION=true`.
- `ALLOCATION_VAULTS_JSON`: the 21-vault cohort in `docs/coverage-review/proposed-vaults.json`.

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

Reconstruct and validate new runs on the worker first. `scripts/allocation-publish.ts` copies the selected vaults' active
runs into the existing `allocation_reference` schema. It retains previously published runs, rejects conflicting IDs or
changed immutable data, verifies copied metadata and entry fingerprints, advances identity sequences, and activates the
entire selected cohort in one transaction. API readers continue seeing the previous committed data until that transaction
commits. A failed publication rolls back without changing the active references.

Put `ALLOCATION_SOURCE_DATABASE_URL`, `ALLOCATION_PUBLISH_DATABASE_URL`, and
`ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION=true` in an ignored local `.env.publish` file. The target URL must be a direct
writer connection, not the API's reader credential. Never upload this file or configure the writer on Vercel.

```bash
# Plan only; no target writes.
bun --env-file=.env.publish run allocation:publish --vaults-file=docs/coverage-review/proposed-vaults.json

# Apply only after rehearsing and measuring an isolated copy of the hosted database.
bun --env-file=.env.publish run allocation:publish --vaults-file=docs/coverage-review/proposed-vaults.json --apply
```

The default target database ceiling is 400,000,000 bytes, leaving room below Neon Free's 0.5 GB allowance. The publisher
checks database size before and during copying and before commit. A dry run checks compatibility and fingerprints but does
not estimate installed size: measure a local rehearsal first. `--max-target-bytes=<bytes>` changes the ceiling explicitly.
Only prepared projections, runs, and entries are copied; the RPC cache stays on the worker. The initial dump/restore
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

The expanded cohort rehearsal validated all 245 chart pages (5,896 visible entries), full-history access, and pinned details
for all 21 vaults with Powerglove's actual parser and panel reconciliation. yvvbUSDS has no chart-visible reallocations;
its current snapshot and seven full-history entries remain available. Publication checks covered dry-run behavior,
immutable-data collision rejection, transaction rollback, idempotent re-publication, retained old runs, and the size ceiling.
The source manifest, installed size, copy fingerprints, and rehearsal results are recorded in
[`hosted-dataset-validation.json`](hosted-dataset-validation.json).

Vercel's native GitHub integration deploys pushes to `main`. Other branches do not automatically deploy because database
credentials are configured only for production. GitHub Actions runs the verification workflow; the former Yearn-specific
deployment workflow is removed. No database work occurs during a build or public API request. Refreshing the hosted dataset
remains a separate manual operation from deploying API code.

`.vercelignore` explicitly excludes local environment files, dependencies, and build output. Vercel CLI uploads must not
rely on `.gitignore` for credential exclusion. Check the deployment file listing before sharing a new deployment.
