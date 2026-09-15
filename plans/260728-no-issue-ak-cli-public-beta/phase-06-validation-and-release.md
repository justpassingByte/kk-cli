# Phase 6 — Validation and release

Status: In progress — blocked on npm publication

## Executable owners

- Hosted release pipeline:
  [`.github/workflows/publish-beta.yml`](../../.github/workflows/publish-beta.yml)
- Candidate and receipt contracts:
  [`scripts/release-artifact-contract.mjs`](../../scripts/release-artifact-contract.mjs),
  [`scripts/create-release-candidate.mjs`](../../scripts/create-release-candidate.mjs),
  [`scripts/publish-release-candidate.mjs`](../../scripts/publish-release-candidate.mjs)

## Completed evidence

- [x] Exact CLI release commit
  [`1297f1c8e17c15d5662db2e90ae1d87a2bccfde7`](https://github.com/bestagentkits/ak-cli/commit/1297f1c8e17c15d5662db2e90ae1d87a2bccfde7)
  is on `origin/main`.
- [x] Previously recorded local full gates passed: 31 test files, 155 pass, 1 skip.
- [x] Exact-head [CI run `30362135182`](https://github.com/bestagentkits/ak-cli/actions/runs/30362135182)
  passed Ubuntu/macOS/Windows × Node 22/24.
- [x] Backend PR, production deployment, and migration completed; see
  [plan release evidence](plan.md#release-evidence).
- [x] [Publish run `30362358096`](https://github.com/bestagentkits/ak-cli/actions/runs/30362358096)
  created the immutable candidate and passed all six installed-tarball canaries.

## Current blocker

- Publish attempt 1 and retry attempt 2 failed fail-closed with npm `EOTP`.
- No npm package and no publisher receipt were published.
- The npm secret must be a granular write token with **Bypass 2FA** before rerun.

## Remaining beta gates

- [ ] Publish the already tested candidate successfully to npm.
- [ ] Compare the publisher receipt, candidate metadata, registry integrity,
  version, and `beta` dist-tag.
- [ ] Install `@bestagentkits/ak@beta` fresh from the public registry and run the
  public canary.
- [ ] Complete the final tester/code-review audit against the public evidence.

## Stable promotion

- [ ] Pending after beta acceptance. Stable promotion is explicitly outside the
  current public-beta completion boundary.
