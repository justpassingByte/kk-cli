---
title: "ClaudeKit TypeScript/npm lessons for AgentKit CLI V1"
date: 2026-07-28
status: complete
source_repo: /Volumes/GOON/www/claudekit/claudekit-cli
source_sha: 528f5f24f6f4dc4eca153a23b6076a4f147a7d4f
---

# ClaudeKit TypeScript/npm lessons for AgentKit CLI V1

## Executive recommendation

Build `@bestagentkits/ak` as a small Node ESM CLI with one composition root, seven command adapters only (`login`, `logout`, `init`, `update`, `migrate`, `uninstall`, `doctor`), typed results/errors, one output renderer, and transaction-oriented state services. Reuse ClaudeKit's proven package wrapper, package-manager ownership detection, checksum reconciliation, locking, atomic snapshots, and isolated `npm pack` canaries. Do not port its dashboard, broad command registry, Bun build assumptions, native SQLite, GitHub-specific auth, inconsistent direct output, or single-kit update flow.

The release contract should be public beta-first: build and publish one immutable npm version to `beta`, verify exact tarball/integrity across macOS, Ubuntu, and Windows, soak, then move the same version's dist-tag to `latest`. Stable promotion must not rebuild.

## Minimal architecture and dependencies

```text
bin/ak.js                  Node/version guard; dynamic import via pathToFileURL
src/index.ts               signals, composition root, parse, render, exit
src/cli/                   seven command schemas/adapters
src/application/           command use cases; no console/process.exit
src/domain/                state, ownership, reconciliation, migration plans
src/infrastructure/
  auth/                    AuthClient, CredentialStore, SessionManager
  filesystem/              locks, snapshots, atomic writes, safe paths
  packages/                registry client, PM detection, fresh-runtime handoff
  archives/                optional extractor boundary
src/presentation/          prompts, human/JSON output, redaction
```

Runtime dependencies:

- `cac`: lightweight parser; ClaudeKit centralizes global flags in `src/cli/cli-config.ts:7-29`.
- `@clack/prompts`, `picocolors`: interactive UI and color, behind terminal-aware adapters.
- `zod`: validate CLI boundaries and durable state.
- `semver`: channel/version comparisons.
- `proper-lockfile`: cross-process state locks.
- `tar` and/or `extract-zip` only if the final kit artifact format requires them.
- Native Node `fetch`, `AbortController`, `fs`, `path`, `crypto`, `child_process`; no general HTTP dependency.

Avoid native/runtime-heavy dependencies until required: `better-sqlite3`, Bun runtime APIs, dashboard/UI stacks, GitHub SDKs, watchers, websockets, and `keytar`. Credential storage policy is unresolved; do not accidentally define it by copying a Unix `0600` file implementation.

## Command, prompt, JSON, and error contract

- Validate every command/options object before business logic. ClaudeKit examples: `src/types/commands.ts:11-15,66-141`.
- Use one typed `AkError { code, message, remediation, exitCode, details? }`; deep layers return/throw typed errors and never call `process.exit`.
- One root renderer owns stdout/stderr. Human success goes to stdout, diagnostics to stderr; JSON emits one stable envelope with no spinners, ANSI, prompts, or timestamps unless specified.
- `--json` and `--no-interactive` must fail with a specific actionable error when required input is absent. No implicit confirmation.
- Centralize signal handling and cleanup. ClaudeKit distributes lifecycle handlers across `src/index.ts:12-29`, `src/shared/logger.ts`, and `src/shared/temp-cleanup.ts`; avoid this duplication.
- Keep prompt wrappers terminal-aware. Useful evidence: `src/shared/safe-prompts.ts:1-106`, `src/shared/output-manager.ts:20-55,86-171`, `src/shared/terminal-utils.ts:15-63`.
- Redact structured sensitive fields plus URL credentials/query secrets. ClaudeKit registry redaction is useful (`src/commands/update/registry-client.ts:14-26`, `src/domains/github/npm-registry.ts:19-43`), but `src/shared/logger.ts:133-168` is too narrow for generic diagnostics.

## npm packaging, package-manager detection, and self-update

Reuse these patterns:

- A checked-in `#!/usr/bin/env node` wrapper that rejects unsupported Node, imports built ESM with `pathToFileURL`, and gives actionable package-corruption errors: `bin/ck.js:1-56`; tests `tests/wrapper.test.ts:18-199`.
- Detect the owning package manager in this order: active binary/realpath, `npm_config_user_agent` or exec path, validated cache, parallel owner queries. Evidence: `src/domains/installation/package-manager-detector.ts:48-174`, `.../package-managers/detection-core.ts:24-317`.
- Test Windows `.cmd`, path separators, false substring matches, cache expiry, precedence, and injection rejection: `tests/lib/package-manager-detector.test.ts:46-94,127-206,258-378,394-581,709-738`.
- Fetch registry metadata with native `fetch`, timeout, abort, and URL redaction: `src/domains/github/npm-registry.ts:79-149`.
- Run package-manager commands as executable plus argv. Use shell only when Windows `.cmd/.bat` requires it. ClaudeKit's packaging script demonstrates this safely: `scripts/prepublish-check.js:29-66`.

AgentKit-specific hardening:

- Enumerate every `ak` resolved on PATH (`which -a ak` / `where ak`), resolve realpaths, and classify Go versus npm before update or migration.
- Ambiguous ownership must not silently default to npm. ClaudeKit currently does after `detection-core.ts:261-317`; AgentKit should stop with guided remediation.
- Update the CLI first, then hand off stage two to the freshly installed npm runtime. The fresh runtime sequentially updates every registered kit, one isolated transaction at a time.
- Verify runtime identity/path and package provenance after install, not only `ak --version`. ClaudeKit's current version/PATH verification is at `src/commands/update/package-manager-runner.ts:98-151`.
- Use bounded timeouts and actionable permission/native-build remediation (`package-manager-runner.ts:18-96`), but do not elevate automatically.

## State, snapshots, reconciliation, and destructive safety

Recommended kit registry record: schema version, kit identity/version, target/runtime/scope, install source, owned paths/sections, source and target checksums, last successful mutation, and snapshot reference.

Transaction per kit:

1. Acquire a canonical per-root lock.
2. Inspect current filesystem and registry.
3. Produce a pure reconcile/migration plan.
4. Preview and obtain explicit consent when interactive.
5. Snapshot every path that may be overwritten or deleted.
6. Apply writes atomically and validate.
7. Commit registry last.
8. On any failure, restore the complete pre-state before releasing the lock.

Strong reusable evidence:

- SHA-256 ownership classification preserves user-modified files: `src/services/file-operations/ownership-checker.ts:21-110`.
- Versioned, checksummed registry with fail-closed migration, lock, temp+rename: `src/commands/portable/portable-registry.ts:28-75,267-348,351-416,418-579`.
- Pure reconciliation handles source/target changes and conflicts: `src/commands/portable/reconciler.ts:1-25,68-126,223-264`; scenario tests `src/commands/portable/__tests__/reconciler.test.ts:153-443,503-590,635-886`.
- Snapshot/restore rejects path escapes and supports staged atomic rollback: `src/services/file-operations/destructive-operation-backup.ts:150-203,244-404`; tests `.../destructive-operation-backup.test.ts:27-280` and `.../destructive-operation-backup-atomicity.test.ts:42-69`.
- Per-root locking: `src/services/file-operations/installation-state-lock.ts:8-40`.

Do not copy ClaudeKit migration rollback as sufficient: `src/commands/migrate/migrate-command.ts:1540-1614` only reverses newly created writes, not every overwritten pre-state. AgentKit's locked safety contract requires full rollback.

## Cross-platform portability

- Always use `os.homedir`, `path.join/resolve/relative/realpath`; validate traversal, absolute paths, drive letters, and UNC roots. Evidence: `src/shared/path-resolver.ts:73-171`; tests `tests/utils/path-resolver.test.ts:32-120,206-240,372-438`.
- Treat symlink/realpath boundaries as security boundaries.
- Spawn executable plus argv; never interpolate user-controlled paths into shell strings.
- Use `pathToFileURL` for ESM paths on Windows.
- Respect `NO_COLOR`, non-TTY mode, and ASCII fallback.
- Use temporary isolated home/config/registry directories in every canary; never touch the runner's real user state.
- Prefer native archive tools with argv plus a bounded JS fallback. ClaudeKit evidence: `src/domains/installation/extraction/zip-extractor.ts:29-169`, `native-zip-commands.ts:9-48`.

## Test and release gates

PR gates:

1. Typecheck, lint, focused unit/integration tests, build.
2. `npm pack --json`; inspect allowed files, bin, engines, version parity, and absence of Bun/dev/native leakage.
3. Install tarball into an isolated `--prefix`; run plain Node `ak --version`, `ak --help`, and non-destructive canaries for all seven V1 commands.
4. Matrix: current active Node LTS on macOS, Ubuntu, Windows.
5. Canaries: fresh install, upgrade, Go/npm collision, PATH ambiguity, spaces/backslashes/UNC, non-TTY, JSON, no-interactive, lock contention, injected write failure, full rollback, and sequential multi-kit update.

ClaudeKit package proof is strong: `scripts/prepublish-check.js:15-27,100-145,173-203,400-515`; tests `tests/scripts/prepublish-check.test.ts:8-112`. Its local seven-gate chain is `scripts/ci-local.sh:32-79`. Current hosted CI is Ubuntu-only (`.github/workflows/ci.yml:10-83`), so it does not satisfy AgentKit's cross-OS requirement.

Release gates:

- Record exact source SHA, packed tarball, integrity hash, npm version/dist-tag, and provenance/publisher receipts.
- Publish immutable version to public `beta`; execute cross-OS isolated installed-package canaries and soak.
- Promote the same npm version/artifact to `latest` by dist-tag; never rebuild.
- Repeat post-promotion install canaries.
- Supply auth through `NODE_AUTH_TOKEN`/temporary npm config; never CLI arguments or logs.
- Keep release workflow concurrency non-cancelling during publish/promotion.

ClaudeKit rebuilds dev and stable independently (`.github/workflows/release-dev.yml:86-156`, `.github/workflows/release.yml:23-98`, `.releaserc.js:47-59`); do not copy this for exact-artifact promotion.

## Regression history worth preserving

| Commit | Painful lesson for AgentKit |
|---|---|
| `8dd04880` | npm installs must not require Bun at runtime. |
| `f037ab26` | native binaries made npm delivery fragile; prefer npm-only Node runtime. |
| `db5b2919`, `9eda3c04` | sync package/version metadata before build and package verification. |
| `c31ab34f` | eliminate shell interpolation in package checks. |
| `e29efaa4` | active binary path outranks stale package-manager cache. |
| `df566bc4` | Windows PATH mismatch needs `where`-based actionable guidance. |
| `c63267a1`, `4570795f` | self-update needs long bounded timeout and must not depend on optional native modules. |
| `2461796b`, `52194219` | `.cmd` handoff is tricky; prefer current Node plus resolved entrypoint over general shell spawn. |
| `d2173491`, `0995d999` | archive extraction differs by OS; native tools prevented Windows/Linux hangs. |
| `a28b62cc`, `3d981617` | registry paths, locks, and separator-safe validation prevent TOCTOU/corruption. |
| `8cc30b48` | unknown legacy checksum state needs a healing path, not permanent skip. |
| `3f75cf6f`, `6f2faa8b` | destructive changes require snapshot plus atomic rollback under lock. |
| `a05260f0`, `0abfab9a` | ASCII fallback and Windows ESM URL conversion are packaging contracts. |

## Recommended implementation phases

1. Contract fixtures: seven command schemas, stable JSON/errors/exit codes, state schema, Go/npm detection fixtures, auth API contract.
2. npm kernel: Node wrapper, composition root, output/prompt/error services, package checks, isolated tarball canary.
3. Auth: `AuthClient`, `CredentialStore`, session refresh/revoke, `login/logout`, redaction tests.
4. Kit lifecycle: locks, pure planner, checksums, snapshots, atomic apply, `init/migrate/uninstall`.
5. Guided update: PM ownership, all-PATH binary classification, fresh-runtime handoff, sequential registered-kit transactions.
6. Doctor/support: local scrubbed artifact, preview, explicit consent, then issue/email draft. Never auto-upload.
7. Public beta: cross-OS package canaries, provenance receipts, soak.
8. Stable promotion: move the same artifact to `latest`, then post-promotion canaries.

## Verified facts versus assumptions

Verified from source SHA `528f5f24f6f4dc4eca153a23b6076a4f147a7d4f`: ClaudeKit ships a Node npm wrapper; has tested package-manager detection, versioned checksum registry, pure reconciliation, locks/snapshots, and tarball install checks; hosted CI is Ubuntu-only; dev/stable releases rebuild independently; it does not implement AgentKit OTP/device `login/logout`.

Assumptions/recommendations requiring AgentKit evidence: backend login/session endpoints; durable state locations and schema compatibility; exact Go binary signatures and legacy state; supported Node LTS floor; credential storage policy per OS; npm org provenance and dist-tag permissions; final kit archive format; required beta soak duration.

## Unresolved questions

1. Which auth flows are V1 contract: API key, OTP, browser/device code, or a prioritized combination?
2. What authoritative signatures distinguish legacy Go `ak` binaries and state on each OS?
3. Which Node LTS versions must be supported at beta launch?
4. Where may credentials be stored on Windows/macOS/Linux, and is OS keychain integration required?
5. What exact beta soak/canary threshold authorizes `latest` dist-tag promotion?
