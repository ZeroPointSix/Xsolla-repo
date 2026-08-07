# Repository Inspector

This is a small TypeScript developer tool that inspects changes in a Git
repository, runs optional validation commands, and produces a Markdown report.
Its sole production interface is the command line. The bundled stdio MCP
source is an experimental compatibility interface with a constrained execution
policy; it is not a production interface.

## Your task

Investigate the repository and improve it as you judge best. The starter works
for a narrow happy path, but production use may expose correctness, safety,
reliability, contract, output, documentation, or testing weaknesses.

You are not expected to finish everything. We care about how you investigate,
prioritize, implement, verify, and explain a meaningful scope.

## Product decision

**Decision: CLI-first. The CLI is the sole production contract.** The bundled
stdio MCP source is retained as an experimental compatibility interface. It is
not a production interface and must not be represented as a general-purpose
agent command-execution capability.

### Primary user and execution environment

The primary user is a developer reviewing a repository from their own local
terminal and working directory. The CLI makes the target repository, command,
and optional validation command visible to that developer at invocation time.
No agent or untrusted caller is a supported MCP user in the current state.

### Trust boundary and allowed capabilities

The CLI runs with the invoking developer's local permissions. A developer may
choose any validation executable and arguments, but the command is tokenized
and launched with `shell: false`: shell separators, pipelines, redirects,
substitutions, newlines, and malformed quotes are rejected rather than
interpreted.

Experimental MCP applies a separate policy before it starts Git or a validation
process. `REPOSITORY_INSPECTOR_MCP_ROOT` is required and `repo_path` is resolved
with canonical real paths; the resolved repository must be inside that root,
so a path or symlink cannot escape it. By default, `validation_commands` must
exactly equal one of the following strings:

- `npm test`
- `npm run typecheck`
- `npm run lint`

Set `REPOSITORY_INSPECTOR_MCP_ALLOW_ANY_VALIDATION_COMMANDS=1` only when the
MCP host deliberately accepts the broader local-executable capability. That
opt-in removes the command allowlist, not the shellless tokenizer or the
canonical repository-root check.

### Reliability, discoverability, latency/context, and output-size tradeoffs

A CLI command is discoverable through its executable, `--help`-style usage,
and repository documentation. Each CLI validation has a 60-second timeout and
captures at most 256 KiB (262,144 bytes) from each of stdout and stderr.
Experimental MCP uses a 15-second timeout and captures at most 32 KiB (32,768
bytes) from each stream. A configured per-stream budget must be a safe integer
from 128 bytes through the practical 16 MiB (16,777,216-byte) maximum. Capture
is streaming and bounded: when a stream exceeds its limit, the report preserves
a head and tail, inserts a visible `[..., <count> bytes omitted ...]` marker
within that same budget, and reports the retained and omitted source-byte
counts. Retained arbitrary bytes are made valid UTF-8 without expansion, then
cut only at grapheme-cluster boundaries. Timed-out commands receive the
`timed_out` status; POSIX process groups receive `SIGTERM`, then `SIGKILL` after
one second if needed. Windows uses shellless `taskkill /PID <pid> /T`, followed
by `/F` after the same grace period, to clean up the process tree. If Windows
cleanup cannot be confirmed, the result and report expose a termination
cleanup diagnostic rather than claiming success.

### Consistency policy

Only the CLI has a production behavior guarantee. There is no supported MCP
availability or parity claim. A future production MCP interface must retain
Issue #1's typed repository-path mapping, Issue #4's shellless, allowlisted
validation policy, and these timeout and output bounds before being specified
and documented against the CLI.

### Evidence that would change the decision

This decision would be reconsidered only if sustained, representative usage
showed that agent-driven requests are the dominant production workflow and an
agent-facing interface could enforce typed repository-path mapping, a
shellless, allowlisted validation policy, and timeout and output bounds. It
would also require evidence that bounded/structured results solve the agent
context and output-size problem and that the interface meets measurable
reliability and latency targets. Until then, the CLI remains the only production
contract.

## Time and rules

- Maximum **90 focused minutes** within 48 hours of receiving the invitation.
- Use AI coding tools freely. Verify their work and document at least one
  suggestion you corrected or rejected.
- Work in your own repository created from this template.
- Commit as you work and complete `SUBMISSION.md` in your final commit.
- Completion is not required. Accurate scope and verification matter more than
  a large diff.

## Setup

```bash
npm install
npm run typecheck
npm test
```

## CLI

```bash
npm run inspector -- review --repo ./path/to/repo --format markdown
npm run inspector -- review --repo ./path/to/repo --validate "npm test"
```

When `--base-ref` is omitted, the inspector resolves a commit from the current
branch's upstream, then `refs/remotes/origin/HEAD`, `refs/heads/main`, and
`refs/heads/master`. The local fallbacks support standalone repositories and the
fully qualified fallback refs prevent same-named tags from being selected. If none
resolves, pass an existing commit ref explicitly with `--base-ref <commit-ish>`.

### Git change parsing

The inspector requests Git's NUL-delimited `--name-status -z` output with rename
and copy detection (including `--find-copies-harder`). A complete valid stream is
parsed losslessly: `A`, `D`, `M`, `R<score>`, `C<score>`, `T`, and `U` records
retain their original paths, including Unicode, tabs, and newlines. An empty
stream means there are no changed files.

The parser is deliberately fail-closed. It throws a typed
`GitNameStatusParseError` and returns no changed-file list when a stream contains
an empty or unknown status field, an incomplete or misaligned record, or lacks
the final NUL terminator. It does not try to resynchronize malformed fields,
because doing so could fabricate paths or misassign later fields to an earlier
status record.

The report is written to `review-report.md`.

## Retained experimental MCP source

`src/mcp-server.ts` and its package script are an experimental compatibility
surface, not a production tool-use recommendation. Before starting it, configure
an existing permitted root with `REPOSITORY_INSPECTOR_MCP_ROOT`; every requested
repository is canonicalized and must remain inside that root. Its default
validation-command allowlist and the only opt-in that broadens it are documented
in the trust-boundary section above. The implementation never invokes a shell.

The interface remains experimental despite its 15-second timeout and 32 KiB
per-stream output bounds. Do not treat its constrained policy as a substitute
for a general-purpose agent command-execution boundary.

## Project layout

```text
src/core.ts         shared review orchestration
src/cli.ts          command-line adapter
src/mcp-server.ts   MCP adapter
src/git.ts          Git inspection
src/validation.ts   validation execution
src/report.ts       Markdown report generation
test/               public starter tests
```

When finished, submit via **Security → Report a vulnerability** on this
repo — see `SECURITY.md` for exactly what to include. Do not reply by email;
that submission channel is not monitored.