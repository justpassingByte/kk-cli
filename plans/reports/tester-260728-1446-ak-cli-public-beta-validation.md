---
title: ak-cli public beta candidate validation
date: 2026-07-28
role: tester
status: blocked
runtime: Node.js 22.20.0
---

# Test Report — 2026-07-28 — ak-cli Public Beta

## Summary

- Release status: **BLOCKED**
- Source edits: none
- Clean-install gate fails before CI or publish tests can run.
- Existing-install code, package, CLI, and projected lifecycle checks pass.

## Runtime

Official `node-v22.20.0-darwin-arm64` distribution downloaded from
`https://nodejs.org/dist/v22.20.0/` into `/tmp`; its `bin` directory prepended
to `PATH`. Verified `node v22.20.0`, bundled `npm 10.9.3`.

## Results

| Gate | Result | Evidence |
|---|---|---|
| `npm ci` | FAIL | Exit 1, lockfile/package manifest out of sync |
| `npm run check` | PASS | Typecheck, lint, 27 files/104 tests, build |
| `npm run package:verify` | PASS | Packed install canary, version, help, inventory |
| CLI contract tests | PASS | 2 files, 6 tests |
| Projected lifecycle tests | PASS | 2 files, 8 tests |
| Direct CLI version/help | PASS | Version and both help routes exit 0 |

## Exact Commands and Results

### Clean install

```bash
PATH=/tmp/ak-node-22.20.0.dKcPKU/node-v22.20.0-darwin-arm64/bin:$PATH
node --version
npm --version
npm ci
```

Result: exit 1.

```text
npm error `npm ci` can only install packages when your package.json and
package-lock.json or npm-shrinkwrap.json are in sync.
npm error Missing: @emnapi/core@1.11.3 from lock file
npm error Missing: @emnapi/runtime@1.11.3 from lock file
npm error Invalid: lock file's @emnapi/wasi-threads@1.2.2 does not satisfy
@emnapi/wasi-threads@1.2.3
npm error Missing: @emnapi/core@1.11.1 from lock file
npm error Missing: @emnapi/runtime@1.11.1 from lock file
npm error Missing: @emnapi/wasi-threads@1.2.2 from lock file
```

Lock evidence: `package-lock.json:68-77` records `@emnapi/wasi-threads` 1.2.2;
`package-lock.json:987-1001` references missing `@emnapi/core` and
`@emnapi/runtime` 1.11.1. Clean checkout cannot reach later workflow steps.

### Full check

```bash
PATH=/tmp/ak-node-22.20.0.dKcPKU/node-v22.20.0-darwin-arm64/bin:$PATH
node --version
npm --version
npm run check
```

Result: exit 0.

```text
typecheck: pass
lint: pass
Test Files  27 passed (27)
Tests       104 passed (104)
build: tsup success, target node22
```

This used the pre-existing dependency install because clean install failed.

### Packed-package verification

```bash
PATH=/tmp/ak-node-22.20.0.dKcPKU/node-v22.20.0-darwin-arm64/bin:$PATH
npm run package:verify
```

Result: exit 0.

```text
Verified @bestagentkits/ak@0.1.0-beta.0
(sha512-xfXMGqVcxasJk3laN4ahn0drS8bonJ7RYDbKViTFMM1WzP7uLL4PlF5r8esIi1D8qvDp6omMpkaaJzM4RnLIVQ==).
```

The verifier allowlists package files, installs the exact tarball to a temporary
global prefix, runs installed `ak --version`, and runs installed `ak --help`.

### CLI contracts

```bash
npx vitest run \
  tests/contracts/argv-contract.test.ts \
  tests/cli/register-kit-lifecycle-commands.test.ts
```

Result: exit 0; 2 files passed, 6 tests passed.

Evidence includes `ak kit init` normalization to `ak init` with flags preserved,
global-option normalization, init routing, uninstall routing, and invalid-input
rendering.

Direct canaries:

```bash
node bin/ak.js --version
node bin/ak.js --help
node bin/ak.js kit init --help
```

Result: all exit 0. Version output:
`ak/0.1.0-beta.0 darwin-arm64 node-v22.20.0`; help routes identify
`$ ak <command> [options]` and `$ ak init [kit]`.

### Projected lifecycle

```bash
npx vitest run \
  tests/application/init-projected-lifecycle.test.ts \
  tests/application/uninstall-projected-lifecycle.test.ts
```

Result: exit 0; 2 files passed, 8 tests passed.

Covered unsupported-target rejection, verified activation commit, full rollback,
foreign-file refusal, registry-failure restoration, shared-marketplace
preservation, provider-first deactivation, and modified-config residue.

## CI and Release Workflow Inspection

### CI matrix

`.github/workflows/ci.yml:18-34` correctly defines six combinations:

- `ubuntu-latest`, `macos-latest`, `windows-latest`
- Node 22 and Node 24

Steps are cross-platform command forms: checkout, setup-node with npm cache,
`npm ci`, `npm run check`, `npm run package:verify`. `fail-fast: false` preserves
all matrix results. Package verification handles `npm.cmd` and `ak.cmd` on
Windows (`scripts/verify-packed-package.mjs:44-58`).

### Publish beta

`.github/workflows/publish-beta.yml:15-45` uses Ubuntu/Node 22, serialized
concurrency, npm environment, OIDC permission, exact generated tarball publish,
provenance, and publisher receipt upload.

Blocking path: `npm ci` at line 25 fails before check, pack, publish, or receipt.

### Promote stable

`.github/workflows/promote-stable.yml:18-39` is promotion-only on Ubuntu/Node
22. It reads the already-published version/integrity, moves `latest`, then checks
version and unchanged integrity. No rebuild occurs.

### Non-blocking observation

Workflow `node-version` values are floating majors (`22`, `24`), not exact
patches. This is suitable for active-LTS compatibility coverage but means
publisher runtime patch is not reproducible as exactly Node 22.20.0.

## Release Blockers

1. **Regenerate and commit a synchronized `package-lock.json`, then prove
   `npm ci` from a clean checkout.** Current failure blocks every OS/Node CI job
   and the beta publisher before validation or publication.

## Recommended Retest

1. Run clean `npm ci` under official Node 22.20.0/npm 10.9.3.
2. Run full six-job GitHub Actions matrix.
3. Run `npm run check` and `npm run package:verify` after the clean install.
4. Dispatch beta publish only after those gates are green.

## Unresolved Questions

- Should the beta publisher pin Node `22.20.0` for exact runtime provenance, or
  intentionally track the latest Node 22 patch?
