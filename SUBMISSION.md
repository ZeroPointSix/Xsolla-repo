# Submission

## What did you investigate first, and why?

## What did you choose to implement or fix?

## What did you intentionally not do?

## Interface decision

- Decision: **CLI-first.** The CLI is the sole production contract. The stdio MCP source is retained as experimental compatibility code only; it is not a production interface and is not available for agent experiments or untrusted use.
- Primary user and execution environment: A developer runs an explicit review from their local terminal and working directory. No agent or untrusted caller is a supported MCP user in the current state.
- Trust boundary and allowed capabilities: The CLI inherits the invoking developer's local permissions. Optional validation commands are executable code chosen by that developer in their shell context. The retained MCP source does not establish an agent-facing trust boundary: Issue #1 has not corrected its path mapping, and Issues #4 and #5 have not replaced shell execution with allowlisted, root-confined, resource-bounded execution. This PR does not implement those fixes.
- Reliability, discoverability, latency/context, and output tradeoffs: The CLI is discoverable as an executable and documented command, while its complete Markdown report can remain on the local filesystem. A stdio MCP result would add process/protocol failure modes and put report size into an agent's context budget. Because the source is not available for use, it carries no reliability, latency, discoverability, or output-size commitment.
- How supported interfaces remain consistent: The CLI alone has a production behavior guarantee. There is no supported MCP behavior or parity claim. Any future MCP interface must first satisfy the unfinished #1, #4, and #5 safeguards and then be specified and documented against the CLI.
- Evidence that would change this decision: Reconsider only if representative, sustained evidence shows agent-driven requests dominate production use and an agent-facing interface can enforce the required path mapping plus shellless, allowlisted, root-confined, resource-bounded execution. It would also need bounded/structured results that fit agent context limits and measured production reliability and latency.

## How did you use an AI coding agent?

## Where did you check, correct, or reject an AI suggestion? (required)

## Commands used to verify the result, with outcomes

## A blocker you hit and how you approached it

## Known limitations and the next three things you would do

## Approximate focused-work time

- Start:
- Finish: