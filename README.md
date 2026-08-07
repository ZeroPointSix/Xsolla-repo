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
canonical repository-root check. This is still experimental: Issue #5 has not
implemented timeout and output bounds.

### Reliability, discoverability, latency/context, and output-size tradeoffs

A CLI command is discoverable through its executable, `--help`-style usage,
and repository documentation. It lets a developer wait for the review in their
terminal and keep the complete Markdown report on the local filesystem. That
is a better fit for repository reviews, whose report and command output can be
large. A stdio MCP result would consume agent context, make output-size limits
the caller's problem, and add process/protocol failure modes. The experimental
MCP source has no production reliability, latency, discoverability, or
output-size commitment.

### Consistency policy

Only the CLI has a production behavior guarantee. There is no supported MCP
availability or parity claim. A future production MCP interface must retain
Issue #1's typed repository-path mapping and Issue #4's shellless, allowlisted
validation policy, add Issue #5's timeout and output bounds, then be specified
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

The report is written to `review-report.md`.

## Retained experimental MCP source

`src/mcp-server.ts` and its package script are an experimental compatibility
surface, not a production tool-use recommendation. Before starting it, configure
an existing permitted root with `REPOSITORY_INSPECTOR_MCP_ROOT`; every requested
repository is canonicalized and must remain inside that root. Its default
validation-command allowlist and the only opt-in that broadens it are documented
in the trust-boundary section above. The implementation never invokes a shell.

The interface remains experimental because it does not yet provide Issue #5's
timeout and output bounds. Do not treat its constrained policy as a substitute
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