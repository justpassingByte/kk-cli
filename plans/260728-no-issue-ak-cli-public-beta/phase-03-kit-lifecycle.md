# Phase 3 — Kit lifecycle

Status: Completed

## Executable owners

- Command contract:
  [`src/cli/argv-normalization.ts`](../../src/cli/argv-normalization.ts),
  [`src/cli/register-kit-lifecycle-commands.ts`](../../src/cli/register-kit-lifecycle-commands.ts)
- Lifecycle use cases:
  [`src/application/init-use-case.ts`](../../src/application/init-use-case.ts),
  [`src/application/uninstall-use-case.ts`](../../src/application/uninstall-use-case.ts)
- Lifecycle coverage:
  [`tests/application/init-projected-lifecycle.test.ts`](../../tests/application/init-projected-lifecycle.test.ts),
  [`tests/application/uninstall-projected-lifecycle.test.ts`](../../tests/application/uninstall-projected-lifecycle.test.ts),
  [`tests/application/uninstall-use-case.test.ts`](../../tests/application/uninstall-use-case.test.ts)

## Completion evidence

- [x] Init and uninstall are composed and registered in the release commit.
- [x] The linked lifecycle coverage passed under the recorded local and hosted gates.

See [plan release evidence](plan.md#release-evidence).
