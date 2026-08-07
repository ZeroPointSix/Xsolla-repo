# Submission

## What did you investigate first, and why?

## What did you choose to implement or fix?

## What did you intentionally not do?

## Interface decision

- Decision: **CLI-first.** The CLI is the sole production contract. The stdio MCP server is retained only as a local experimental/compatibility adapter and is not a production interface.
- Primary user and execution environment: A developer runs an explicit review from their local terminal and working directory. An AI coding agent can use the local stdio adapter experimentally, but it is not the production user or execution model.
- Trust boundary and allowed capabilities: The CLI inherits the invoking developer's local permissions. Optional validation commands are executable code chosen by that developer in their shell context. An MCP request can be influenced by model input, so the adapter must not be interpreted as authority to expose repository paths or validation commands to an agent, remote caller, or unattended workflow.
- Reliability, discoverability, latency/context, and output tradeoffs: The CLI is discoverable as an executable and documented command, while its complete Markdown report can remain on the local filesystem. A stdio MCP result adds process/protocol failure modes and puts report size into an agent's context budget. The adapter therefore carries no production reliability, latency, discoverability, or output-size commitment.
- How supported interfaces remain consistent: The CLI alone has a production behavior guarantee. The MCP server must remain a thin local translation to the review operation, not an independent implementation or contract. Future production behavior is specified and documented for the CLI first; no production parity, stability, or remote-availability guarantee is made for MCP.
- Evidence that would change this decision: Reconsider if representative, sustained evidence shows agent-driven requests dominate production use, and an agent-facing interface can enforce an explicit capability policy for repository access and validation commands. It would also need bounded/structured results that fit agent context limits and measured production reliability and latency.

## How did you use an AI coding agent?

## Where did you check, correct, or reject an AI suggestion? (required)

## Commands used to verify the result, with outcomes

## A blocker you hit and how you approached it

## Known limitations and the next three things you would do

## Approximate focused-work time

- Start:
- Finish: