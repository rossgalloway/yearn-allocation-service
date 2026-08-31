# Repository Guidelines

## Scope

This service exposes Yearn vault allocation history. Keep the authority boundaries explicit:

- Envio Allocation History owns executed on-chain events and indexed accounting checkpoints.
- Optimizer proposal feeds are outside this service's contract.
- Only a same-block indexed checkpoint may populate `unallocatedBps`.
- Envio timeline responses must fail closed unless their immutable coverage row has `safeForTimeline: true`.

## Commands

Use `bun install`, `bun run test`, `bun run lint`, and `bun run build`. API route handlers live under `src/app/api`; upstream clients and pure processing logic live under `src/lib`.

## Delivery

Do not push, deploy, or create a pull request without explicit authorization. Never expose Envio or Tailscale credentials in logs, fixtures, documentation, or pull request text.
