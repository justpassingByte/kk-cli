# Phase 4 — Update and migration

Status: Completed

## Executable owners

- Command routes:
  [`src/cli/register-update-migrate-commands.ts`](../../src/cli/register-update-migrate-commands.ts)
- Use cases:
  [`src/application/update-use-case.ts`](../../src/application/update-use-case.ts),
  [`src/application/migrate-use-case.ts`](../../src/application/migrate-use-case.ts)
- Runtime and migration infrastructure:
  [`src/infrastructure/packages/fresh-runtime-handoff.ts`](../../src/infrastructure/packages/fresh-runtime-handoff.ts),
  [`src/infrastructure/migration/legacy-ck-discovery.ts`](../../src/infrastructure/migration/legacy-ck-discovery.ts)
- Coverage:
  [`tests/application/update-use-case.test.ts`](../../tests/application/update-use-case.test.ts),
  [`tests/application/migrate-use-case.test.ts`](../../tests/application/migrate-use-case.test.ts),
  [`tests/unit/fresh-runtime-handoff.test.ts`](../../tests/unit/fresh-runtime-handoff.test.ts)

## Completion evidence

- [x] Update and migration routes, use cases, and infrastructure are composed in
  the release commit.
- [x] The linked update and migration coverage passed under the recorded local
  and hosted gates.

See [plan release evidence](plan.md#release-evidence).
