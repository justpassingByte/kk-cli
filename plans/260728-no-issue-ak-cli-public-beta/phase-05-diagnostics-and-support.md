# Phase 5 — Diagnostics and support

Status: Completed

## Executable owners

- Command and use cases:
  [`src/cli/register-maintenance-commands.ts`](../../src/cli/register-maintenance-commands.ts),
  [`src/application/doctor-use-case.ts`](../../src/application/doctor-use-case.ts),
  [`src/application/diagnostic-report-use-case.ts`](../../src/application/diagnostic-report-use-case.ts)
- Support infrastructure:
  [`src/infrastructure/support`](../../src/infrastructure/support),
  [`src/domain/diagnostics/redact-report.ts`](../../src/domain/diagnostics/redact-report.ts)
- Coverage:
  [`tests/unit/doctor-use-case.test.ts`](../../tests/unit/doctor-use-case.test.ts),
  [`tests/unit/diagnostic-report-store.test.ts`](../../tests/unit/diagnostic-report-store.test.ts),
  [`tests/unit/github-issue-reporter.test.ts`](../../tests/unit/github-issue-reporter.test.ts),
  [`tests/unit/redact-report.test.ts`](../../tests/unit/redact-report.test.ts)

## Completion evidence

- [x] Doctor and support routes are composed in the release commit.
- [x] The linked diagnostics and support coverage passed under the recorded local
  and hosted gates.

See [plan release evidence](plan.md#release-evidence).
