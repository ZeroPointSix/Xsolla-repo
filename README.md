# Repository Inspector

This is a small TypeScript developer tool that inspects changes in a Git
repository, runs optional validation commands, and produces a Markdown report.
Its production interface is the command line. The bundled stdio MCP server is
only a local experimental/compatibility adapter, not a production interface.

## Your task

Investigate the repository and improve it as you judge best. The starter works
for a narrow happy path, but production use may expose correctness, safety,
reliability, contract, output, documentation, or testing weaknesses.

You are not expected to finish everything. We care about how you investigate,
prioritize, implement, verify, and explain a meaningful scope.

## Product decision

**Decision: CLI-first. The CLI is the sole production contract.** The bundled
stdio MCP server remains available only as a local experimental/compatibility
adapter; it is not a supported production endpoint and is not a second
production contract.

### Primary user and execution environment

The primary user is a developer reviewing a repository from their own local
terminal and working directory. The CLI makes the target repository, command,
and optional validation command visible to that developer at invocation time.
An AI coding agent may launch the local stdio adapter during an experiment, but
that does not change the production audience or execution model.

### Trust boundary and allowed capabilities

The CLI runs with the invoking developer's local permissions. In particular,
an optional validation command is executable code selected by that developer;
the production contract therefore assumes the developer makes that decision in
their own shell context. A model-mediated MCP call has a different trust
boundary: prompt-influenced input could select repository paths or validation
commands. The local adapter must not be treated as authorization to expose
those capabilities to an agent, a remote caller, or an unattended workflow.

### Reliability, discoverability, latency/context, and output-size tradeoffs

A CLI command is discoverable through its executable, `--help`-style usage,
and repository documentation. It lets a developer wait for the review in their
terminal and keep the complete Markdown report on the local filesystem. That
is a better fit for repository reviews, whose report and command output can be
large. Passing the report through stdio into an agent consumes context, makes
output-size limits part of the caller's problem, and adds process/protocol
failure modes. Keeping MCP experimental avoids promising production
reliability, latency, discoverability, or output-size behavior that this
adapter is not designed to provide.

### Consistency policy

Only the CLI has a production behavior guarantee. The MCP adapter must not
advertise independent production semantics or capabilities. When it is used
locally, it should remain a thin translation to the review operation rather
than a second implementation; any future production behavior must be specified
and documented for the CLI first. There is deliberately no promise of
production parity, stability, or remote availability for the adapter.

### Evidence that would change the decision

This decision would be reconsidered if sustained, representative usage showed
that agent-driven requests are the dominant production workflow and an
agent-facing interface could enforce an explicit capability policy for
repository access and validation commands. It would also require evidence that
bounded/structured results solve the agent context and output-size problem, and
that the interface meets measurable reliability and latency targets. Absent
that evidence, the CLI remains the only production contract.

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

## Local experimental MCP adapter

The stdio server is retained for local experiments and compatibility only. It
is not a production endpoint, is not supported for remote or unattended use,
and must not be used to grant an AI agent production access to repository paths
or validation commands.

Start it locally with:

```bash
npm run mcp-server
```

It exposes a `review_repository` tool for experimentation. Its availability
does not add a production contract beyond the CLI.

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