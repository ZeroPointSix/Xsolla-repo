# Submission

## What did you investigate first, and why?

## What did you choose to implement or fix?

## What did you intentionally not do?

## Interface decision

- Decision: **CLI-first.** The CLI is the sole production contract. The stdio MCP source is an experimental compatibility interface, not a production interface or a general-purpose agent command-execution capability.
- Primary user and execution environment: A developer runs an explicit review from their local terminal and working directory. No agent or untrusted caller is a supported production MCP user.
- Trust boundary and allowed capabilities: The CLI inherits the invoking developer's local permissions, but tokenizes validation commands and launches them without a shell. Experimental MCP requires a canonical repository path under `REPOSITORY_INSPECTOR_MCP_ROOT` and allows only `npm test`, `npm run typecheck`, and `npm run lint` by default. `REPOSITORY_INSPECTOR_MCP_ALLOW_ANY_VALIDATION_COMMANDS=1` explicitly broadens commands without removing the shellless parser or root check. Issue #5's timeout and output bounds remain unimplemented.
- Reliability, discoverability, latency/context, and output tradeoffs: The CLI is discoverable as an executable and documented command, while its complete Markdown report can remain on the local filesystem. A stdio MCP result would add process/protocol failure modes and put report size into an agent's context budget. The experimental MCP interface has no production reliability, latency, discoverability, or output-size commitment.
- How supported interfaces remain consistent: The CLI alone has a production behavior guarantee. A future production MCP interface must retain Issue #1's typed repository-path mapping and Issue #4's shellless, allowlisted validation policy, then add Issue #5's timeout and output bounds before being specified against the CLI.
- Evidence that would change this decision: Reconsider only if representative, sustained evidence shows agent-driven requests dominate production use and an agent-facing interface can preserve the existing repository and execution policy while adding bounded results that fit agent context limits and measurable production reliability and latency.

## How did you use an AI coding agent?

## Where did you check, correct, or reject an AI suggestion? (required)

## Commands used to verify the result, with outcomes

## A blocker you hit and how you approached it

## Known limitations and the next three things you would do

## Approximate focused-work time

- Start:
- Finish: