# Phase 1 — Contracts and package

Status: Completed

## Executable owners

- Package and runtime contract: [`package.json`](../../package.json),
  [`src/index.ts`](../../src/index.ts)
- Registry and lifecycle contracts:
  [`src/domain/registry/remote-registry-manifest.ts`](../../src/domain/registry/remote-registry-manifest.ts),
  [`src/infrastructure/registry/verified-artifact-pipeline.ts`](../../src/infrastructure/registry/verified-artifact-pipeline.ts),
  [`src/infrastructure/filesystem/local-filesystem-transaction.ts`](../../src/infrastructure/filesystem/local-filesystem-transaction.ts)
- Hosted verification: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml),
  [`scripts/verify-packed-package.mjs`](../../scripts/verify-packed-package.mjs)

## Completion evidence

- [x] Package, registry, transaction, and packed-package owners are present at
  release commit
  [`1297f1c8e17c15d5662db2e90ae1d87a2bccfde7`](https://github.com/bestagentkits/ak-cli/commit/1297f1c8e17c15d5662db2e90ae1d87a2bccfde7).
- [x] The release commit is on `origin/main`.
- [x] Exact-head [CI run `30362135182`](https://github.com/bestagentkits/ak-cli/actions/runs/30362135182)
  passed Ubuntu/macOS/Windows × Node 22/24, including packed-package verification.

See [plan release evidence](plan.md#release-evidence) for the shared local and
hosted gate record.
