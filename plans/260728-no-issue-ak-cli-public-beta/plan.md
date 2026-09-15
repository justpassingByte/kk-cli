# AgentKit CLI public beta

Status: In progress — blocked on npm publication

## Outcome

Ship `@bestagentkits/ak` as a public TypeScript/Node CLI for macOS, Windows,
and Linux, with smooth login and recoverable kit lifecycle operations.

## Constraints

- V1 commands: login, logout, init, update, migrate, uninstall, doctor.
- Hybrid compatibility contracts with the Go runtime and existing registry.
- Public beta first; stable must promote the exact tested npm artifact.
- No automatic PATH edits, legacy Go deletion, GUI, or extra commands.
- Diagnostics require local scrubbing, exact-byte preview, and explicit consent.

## Current acceptance state

- [x] CLI implementation and backend authentication dependency are merged and deployed.
- [x] Previously recorded local full gates passed: 31 test files, 155 pass, 1 skip.
- [x] Exact-head Node 22/24 CI passed on Ubuntu, macOS, and Windows.
- [x] The immutable candidate and all six installed-tarball canaries passed.
- [ ] Publish the candidate successfully to npm under the `beta` dist-tag.
- [ ] Compare the publisher receipt and npm registry integrity with the tested candidate.
- [ ] Run a fresh public install canary from `@bestagentkits/ak@beta`.
- [ ] Complete the final audit after public-registry evidence exists.

Public beta is not complete. Stable promotion is outside this beta completion
boundary and remains pending.

## Release evidence

- CLI release commit:
  [`1297f1c8e17c15d5662db2e90ae1d87a2bccfde7`](https://github.com/bestagentkits/ak-cli/commit/1297f1c8e17c15d5662db2e90ae1d87a2bccfde7)
  on `origin/main`.
- Exact-head CI:
  [run `30362135182`](https://github.com/bestagentkits/ak-cli/actions/runs/30362135182)
  succeeded for Ubuntu/macOS/Windows × Node 22/24.
- Publish workflow:
  [run `30362358096`](https://github.com/bestagentkits/ak-cli/actions/runs/30362358096)
  built the candidate and passed all six installed-tarball canaries. Publish
  attempt 1 and retry attempt 2 both failed fail-closed with npm `EOTP`.
- Registry state: no `@bestagentkits/ak` package and no publisher receipt were
  published. npm requires a granular write token with **Bypass 2FA**.
- Backend authentication:
  [`bestagentkits/ak-web#252`](https://github.com/bestagentkits/ak-web/pull/252)
  merged at
  [`3999f7932de5cc69932bfe954f6d047c87b46489`](https://github.com/bestagentkits/ak-web/commit/3999f7932de5cc69932bfe954f6d047c87b46489);
  production [run `30359581414`](https://github.com/bestagentkits/ak-web/actions/runs/30359581414)
  succeeded and the migration was verified.

## Phases

- [x] [Phase 1 — contracts and package](phase-01-contracts-and-package.md)
- [x] [Phase 2 — authentication](phase-02-authentication.md)
- [x] [Phase 3 — kit lifecycle](phase-03-kit-lifecycle.md)
- [x] [Phase 4 — update and migration](phase-04-update-and-migration.md)
- [x] [Phase 5 — diagnostics and support](phase-05-diagnostics-and-support.md)
- [ ] [Phase 6 — validation and release](phase-06-validation-and-release.md)
