# Research: AgentKit Go contracts and user pain for the TypeScript V1

Date: 2026-07-28
Scope: read-only study for public npm `@bestagentkits/ak`; commands `login`, `logout`, `init`, `update`, `migrate`, `uninstall`, `doctor`.
Source boundary: local `/Volumes/GOON/www/claudekit/agentkit` at `609febcc4b34c77a074a8327c38b079e84c8951c`, branch `dev`, clean, 14 commits behind `origin/dev`. Source/tests below are implementation evidence, not proof of a shipped artifact.

## Executive conclusion

Do not port the Go command names literally. Port its stable machine-output, ownership, preview, snapshot, locking, reconciliation, rollback, redaction, and recovery contracts.

The largest semantic mismatch is naming:

- Go `ak init` adopts project ownership; Go `ak kit init` installs a kit. Locked V1 requires both names to install/init kits identically.
- Go root `uninstall` removes an AgentKit-managed project; Go `kit uninstall` removes a kit. V1 should reuse the latter safety boundary.
- Go root `migrate` moves ClaudeKit state to AgentKit. V1 needs a guided Go-binary-to-npm transition: inspect and explain, never remove/reorder automatically.

The largest product blockers are server-side OTP sessions and orchestration. Current OTP access lasts about 15 minutes with no refresh credential; remote materialization intentionally accepts one runtime per call; Windows staged replacement can leave a persistent blocker.

## Evidence and reusable common contracts

### Universal CLI contract

- Flags: `--yes/-y`, `--no-interactive`, `--quiet/-q`, `--json`, `--verbose/-V`; env equivalents include `AK_YES` and `AK_NO_INTERACTIVE` (`apps/cli/internal/flags/{register,universal,env}.go`).
- `--json` implies non-interactive. Output precedence is JSON, then plain/non-TTY, then pretty; JSON beats quiet (`internal/render/renderer.go`).
- JSON success uses `{schema_version:1, kind, data}` through `render.WrapJSON`.
- JSON errors go to stderr with `schema_version`, human `error`, closed `error_code`, numeric `exit_code`, optional `auth`, optional `recovery` (`internal/render/json.go`).
- Stable shared exits are 0 success, 1 runtime, 2 invalid input, 3 cancel/preview-not-applied, 4 unmet dependency/auth in relevant commands, 5 not found, 6 conflict/drift, 7 security violation. Preserve these meanings even if command-specific help lists a subset.
- V1 requirement: every machine field remains snake_case and additive within schema 1; breaking shape requires a schema bump. Never make scripts parse prose.

### Mutation contract

The reusable sequence is:

1. Resolve exact target, scope, runtime, channel, and ownership.
2. Reject invalid/occupied/unsafe state before opening a transaction.
3. Build a read-only plan and classify owned-clean, owned-modified, foreign, missing, and unsafe paths.
4. Require explicit confirmation; scripted mutation requires `--yes`.
5. Acquire one lifecycle lock and revalidate the plan under lock.
6. Take mandatory bounded snapshots/preimages.
7. Materialize and verify every remote input before the first user-state write.
8. Emit desired state atomically; delete only hash-verified stale owned paths; write the manifest last.
9. Roll back all changed targets on failure and retain machine-readable recovery receipts if rollback is incomplete.

Never delete a runtime home, infer ownership from a filename alone, follow symlink/junction escape paths, or let `--yes` imply a destructive mode change.

## Command-by-command reuse and V1 gaps

| V1 command | Strong Go contract to reuse | Current Go mismatch / V1 decision |
|---|---|---|
| `login` | Email OTP start/verify; API-key and license flows; registry binding; bounded HTTP bodies/timeouts; API-key reauth retries exactly once; CLI/App credential slots | Current switches by precedence instead of rejecting multiple auth flags. Session schema has no refresh token, expiry, session ID, or server revocation. V1 must enforce mutual exclusion and add 30-day revocable OTP device sessions with refresh rotation. |
| `logout` | Idempotent removal of CLI slot and saved API key while preserving Desktop/App slot | Current logout is local-only. V1 should attempt current-session revoke, always clear local CLI credentials in a finally path, and report whether server revoke succeeded. |
| `init` | Kit route resolution, signed remote package verification, explicit local/dev source, ownership manifests, collision checks, install-mode transition guard, snapshots, lock, recovery | Alias `ak init` and `ak kit init` to one kit operation. Do not port root ownership-adoption behavior. Scripted/non-TTY init must require `--yes`; current kit init can proceed with `--no-interactive` alone. |
| `update` | Preview by default; stale-plan detection; skip foreign/modified state; mandatory snapshots; deterministic per-runtime/kit status; signed metadata and artifact verification | Locked `-y` must first update the npm runtime through its owning package manager, then remotely resolve and process detected project/global/runtime kits sequentially. Current Go project/global paths are separate and remote artifacts accept one runtime. Define batch rollback or explicitly document per-target commit; do not imply atomicity if continuing after failure. |
| `migrate` | Read-only discovery, versioned plan/journal, preimage before mutation, resumable state, explicit rollback | Go migration is ClaudeKit-to-AgentKit and mutating. V1 migration must detect every `ak` on PATH, identify Go vs npm provenance, preserve compatible state, and print exact one-time steps. It must not delete the Go binary or edit PATH. |
| `uninstall` | Kit uninstall plans from owned manifests/hashes, preserves modified/foreign content, lifecycle lock, snapshots, exact rollback journals, shared-config ownership strip | Use kit-uninstall semantics, not root project deletion. Default preview; only `--yes` mutates. Remove npm runtime only when explicitly requested and via the owning package manager; never remove runtime homes. |
| `doctor` | Read-only concurrent checks; `ok/warn/fail/skip`; evidence, details, fix command; JSON `doctor.report`; default exit 0 with optional `--exit-on-fail` | Add Node/npm version, npm package provenance, duplicate `ak` executables, Go/npm PATH precedence, stale staged update, session expiry/refresh/revoke, registry reachability, and detected kit ownership. Avoid Go's shell-string `--fix`; model fixes as reviewed structured argv actions. |

## Auth/backend dependency

Current client endpoints are:

- `POST /api/agentkit/auth/otp/start`
- `POST /api/agentkit/auth/otp/verify`
- `POST /api/agentkit/auth/api-key`
- `POST /api/agentkit/auth/license-key/activate`, with legacy activation fallback

The backend implementation is not in the audited AgentKit repository, so the following is a required external contract, not confirmed-current server behavior.

Required server model:

- Device/session family: opaque `session_id`, `device_id`, user, created/last-used/expiry/revoked timestamps, client metadata.
- Short-lived bearer access token plus opaque 30-day refresh token. Store only refresh-token hashes.
- Rotate refresh tokens on every use; invalidate the predecessor; detect reuse and revoke the family.
- Current-session revoke endpoint, plus a user-visible device/session list and per-session revocation path.
- OTP remains short-lived, single-use, attempt-limited, rate-limited, and enumeration-safe. Never persist the raw OTP.

Required endpoints/behavior:

- OTP verify returns access token, refresh token, access expiry, refresh expiry, session ID, and device ID.
- `POST /api/agentkit/auth/refresh` atomically consumes one refresh token and returns the rotated pair.
- `POST /api/agentkit/auth/logout` or `/sessions/current/revoke` is idempotent.
- Concurrent refresh must have one winner; losing clients reload the newly persisted local pair or return an actionable re-login state.
- API-key login may keep its existing one-retry remint path; do not silently convert a raw API key into a 30-day refresh session without an explicit threat-model decision.

Client persistence must be temp-write + fsync/close + atomic replace with Windows sharing-violation retry, restrictive permissions where meaningful, and a credential-store adapter where available. A crash must leave either the old valid pair or the new valid pair, never a mixed pair.

## Diagnostics and feedback contract

Go already provides `ak diagnostics export`:

- Runs doctor JSON, emits `diagnostics.export`, is read-only, redacts tokens, API keys, JWTs, GitHub/LLM/Slack/AWS/Google secrets, private keys, basic-auth URLs, secret assignments, email, and home/local path prefixes.
- Reports detector counts without including raw values (`commands/diagnosticscmd/export.go`, `runtime/diagnostics/redact.go`).

Go feedback can attach that bundle and post authenticated feedback, but current scripted submission can bypass an explicit preview/consent step because confirmation is TTY-dependent.

Locked V1 must:

1. Build and scrub the bundle locally.
2. Show/save the exact scrubbed artifact and redaction counts.
3. Require explicit consent for each external destination, including `--yes` in scripted mode.
4. Submit only the reviewed bytes to GitHub issue or email.
5. On submission failure, retain a 0600 local draft and disclose its path.

Redaction is defense-in-depth, not proof of anonymity. Tests need seeded secrets in nested JSON, URLs, Windows escaped paths, multiline private keys, and false-positive fixtures.

## User pain and regression scars

| Evidence | User-visible failure | Contract consequence |
|---|---|---|
| GitHub #942 and #1163 | OTP login expires after about 15 minutes; repeated OTP login can reach 429; no transparent refresh | 30-day revocable device session with rotation is a backend launch blocker, not optional polish. |
| GitHub #1084 | Auto-detected Claude Code + Codex global refresh fails because one remote materializer rejects multiple targets | Resolve/verify one artifact per runtime, then orchestrate the complete deterministic plan. |
| GitHub #1152 | Windows self-update stages, old version remains, and stale pending state blocks kit commands across new shells | npm update must prove the active executable changed; doctor/migrate must enumerate every PATH candidate and recover stale state. |
| GitHub #1023/#1028 | Rename-over-existing can fail under Windows AV/indexer/file holders although in-place write worked | Centralize bounded retry for sharing/access/lock violations; never fall back silently to truncating writes. |
| `plans/reports/debug-260713-1448-global-skills-wipe-force-refresh.md` | Old force refresh deleted clean files before emit; interruption left empty skill directories | Desired-state emit first, stale owned cleanup second, manifest last; interruption tests are mandatory. Current local source documents/tests the convergent replacement, so this row is a historical scar. |
| `plans/reports/debug-260716-1002-global-runtime-home-wipe-rejected-install.md` | A read-only occupied-target rejection opened whole-home rollback and wiped live `~/.claude` | All rejection/precondition checks precede the transaction; preimages cover only declared mutation roots. Current local source places occupancy rejection before the transaction. |
| GitHub #832 | Generic `--yes` authorized native-to-plugin removal and wiped 91/91 skill files | Mode/scope switches need dedicated intent flags; confirmation is not ownership or transition authority. |

## Recommended delivery gates

1. Contract fixtures: argv, exits, success/error JSON, path/scope matrix, Go-state compatibility fixtures.
2. npm runtime: package provenance, cross-platform PATH enumeration, atomic persistence, global lifecycle lock.
3. Auth: backend refresh/revoke endpoints, rotation/reuse tests, logout finally semantics, rate-limit UX.
4. Init/uninstall: signed input, ownership plans, snapshot/rollback, interruption and symlink/junction tests.
5. Update: package-manager self-update proof, per-runtime remote plans, all-inputs-before-write, deterministic statuses.
6. Migrate/doctor: read-only Go/npm collision detection and copy-ready manual guidance.
7. Diagnostics/support: redaction corpus, byte-exact preview, per-destination consent.
8. Public beta: isolated macOS/Windows/Linux homes; Windows AV/share-lock and duplicate-PATH canaries; exact package/version/provenance receipts. Stable promotion only from the exact proven beta artifact.

## Facts, assumptions, unresolved questions

Facts: current local Go contracts and cited tests/source; GitHub issue contents read on 2026-07-28; historical incident reports above. No tests were run in this pass.

Assumptions: npm is the sole V1 runtime owner after guided migration; project/global installs may coexist; backend can add session storage and endpoints without breaking existing API-key/license clients.

Unresolved:

- What access-token TTL sits inside the locked 30-day refresh-session window?
- Is logout server failure warning-only after guaranteed local clear, or should scripts receive nonzero exit?
- Does `update -y` need command-wide rollback across every runtime/kit, or durable per-target commits with resumable continuation?
- Which compatible Go state files may TypeScript read in place versus copy only after consent?
- What exact GitHub/email destinations and authentication authorities own diagnostics submission?
