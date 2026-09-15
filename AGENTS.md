# Repository Guidelines

## Scope

This service exposes Yearn vault allocation history. Keep the authority boundaries explicit:

- Envio supplies ordered on-chain event evidence through the event-reader adapter.
- This service owns historical RPC accounting, action processing, interval validation, and prepared REST responses.
- Optimizer policies are optional enrichment; a proposal never proves execution or realized return.
- Keep event coverage separate from accounting validity. Unverified coverage requires explicit provisional mode.
- Expose raw idle/assets/debt amounts. Do not depend on Envio accounting checkpoints or reintroduce checkpoint-backed ratios.
- Preserve the current grouping behavior: intervening deposits do not automatically split related keeper actions.
- Public routes read immutable Postgres runs without request-time upstream work.

## Commands

Use `bun install`, `bun run test`, `bun run lint`, and `bun run build`. API route handlers live under `src/app/api`; upstream clients and pure processing logic live under `src/lib`.

## Delivery

Do not push, deploy, or create a pull request without explicit authorization. Never expose Envio or Tailscale credentials in logs, fixtures, documentation, or pull request text.
