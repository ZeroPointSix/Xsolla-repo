# Repository Inspector

This is a small TypeScript developer tool that inspects changes in a Git
repository, runs optional validation commands, and produces a Markdown report.
Its sole production interface is the command line. The bundled stdio MCP
source is retained as experimental compatibility code, but it is not a
production interface and is not available for use.

## Your task

Investigate the repository and improve it as you judge best. The starter works
for a narrow happy path, but production use may expose correctness, safety,
reliability, contract, output, documentation, or testing weaknesses.

You are not expected to finish everything. We care about how you investigate,
prioritize, implement, verify, and explain a meaningful scope.

## Product decision

**Decision: CLI-first. The CLI is the sole production contract.** The bundled
stdio MCP source is retained as experimental compatibility code only. It is
not a production interface and must not be advertised as safe, available for
agent experiments, or usable by untrusted callers.

### Primary user and execution environment

The primary user is a developer reviewing a repository from their own local
terminal and working directory. The CLI makes the target repository, command,
and optional validation command visible to that developer at invocation time.
No agent or untrusted caller is a supported MCP user in the current state.

### Trust boundary and allowed capabilities

The CLI runs with the invoking developer's local permissions. In particular,
an optional validation command is executable code selected by that developer;
the production contract therefore assumes the developer makes that decision in
their own shell context. The retained MCP source does not provide a safe
alternative trust boundary: its path mapping is not yet corrected by Issue #1,
and Issues #4 and #5 have not yet provided shellless, allowlisted,
root-confined, resource-bounded execution. This docs-only PR does not implement
any of those unfinished safeguards.

### Reliability, discoverability, latency/context, and output-size tradeoffs

A CLI command is discoverable through its executable, `--help`-style usage,
and repository documentation. It lets a developer wait for the review in their
terminal and keep the complete Markdown report on the local filesystem. That
is a better fit for repository reviews, whose report and command output can be
large. A stdio MCP result would consume agent context, make output-size limits
the caller's problem, and add process/protocol failure modes. Because the
source is not available for use, it has no reliability, latency,
discoverability, or output-size commitment.

### Consistency policy

Only the CLI has a production behavior guarantee. There is no supported MCP
behavior, availability, or parity claim. Any future MCP interface must first
implement the unfinished #1, #4, and #5 safeguards and then be specified and
documented against the CLI.

### Evidence that would change the decision

This decision would be reconsidered only if sustained, representative usage
showed that agent-driven requests are the dominant production workflow and an
agent-facing interface could enforce the required path mapping plus shellless,
allowlisted, root-confined, resource-bounded execution. It would also require
evidence that bounded/structured results solve the agent context and
output-size problem and that the interface meets measurable reliability and
latency targets. Until then, the CLI remains the only production contract.

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

`src/mcp-server.ts` and its package script are retained as compatibility source
only, not as startup or tool-use instructions. Do not start, register, connect
to, or invoke this MCP source for agent experiments, automation, or any
untrusted use.

It remains unavailable until Issue #1 corrects the repository-path mapping and
Issues #4 and #5 enforce shellless, allowlisted, root-confined,
resource-bounded execution. Those changes are unfinished and are explicitly
outside this docs-only PR.

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