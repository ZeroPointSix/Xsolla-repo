# Submission

## What did you investigate first, and why?

I first ran the public typecheck, build, and test commands. They all passed. I
then tested the two advertised entry points instead of treating a green build
as proof of a usable product.

That exposed two release blockers. The compiled CLI path did not exist, and the
MCP schema used `repo_path` while its handler read `repoPath`. I next reviewed
the command execution boundary because MCP lets an AI agent supply validation
input.

## What did you choose to implement or fix?

- Fixed the MCP field mapping and removed `any` from the handler path.
- Fixed the build layout so `dist/cli.js` exists and tests are not emitted.
- Replaced shell-based `exec` with `spawn` and `shell: false`.
- Added MCP command and repository-root allowlists.
- Added validation timeout, bounded head/tail output, explicit exit data, and
  continued execution after a failed check.
- Added strict CLI parsing, paths with spaces, help, version, JSON, stdout, and
  configurable output and limits.
- Added base-ref detection, ref verification, readable Git errors, NUL-delimited
  status parsing, rename/copy data, worktree changes, and untracked files.
- Added structured core results and safe Markdown fences.
- Added regression tests and a compiled CLI smoke check in pull request CI.
- Increased the project version from 2.0.0 to 2.1.0.

## What did you intentionally not do?

I did not add a new lint stack in this time box. Strict TypeScript now checks the
MCP mapping, and the tests cover the repaired contracts, but a later change
should add ESLint rules for unsafe `any` and unhandled promises.

I did not submit the private vulnerability form. It requires the candidate's
name and application email, which are not repository data.

I retained the `@hono/node-server` override. `npm ls` confirmed that it changes
a real MCP SDK dependency from the SDK's declared `^1.19.9` range to `2.0.10`.
Removing it without the reason or upstream compatibility evidence would be a
guess, not cleanup.

## Interface decision

- Decision: hybrid.
- Primary user and execution environment: a developer at a local CLI and an AI
  coding agent using a local stdio MCP server.
- Trust boundary and allowed capabilities: the CLI user may select any
  executable and arguments. MCP is limited to configured roots and an exact
  command allowlist. Neither interface invokes a shell.
- Reliability, discoverability, latency/context, and output tradeoffs: CLI help,
  exit codes, files, and stdout fit terminal work. MCP has a discoverable schema,
  structured output, a shorter timeout, and a smaller output cap for model
  context.
- How supported interfaces remain consistent: one schema-normalized request and
  one `ReviewResult` are owned by core code. Adapters only map names, policy, and
  rendering.
- Evidence that would change this decision: if more than 95 percent of real use
  comes from one interface, I would make that interface primary. I would allow
  broader MCP execution only after per-task sandbox isolation and permission
  prompts were proven in production.

## How did you use an AI coding agent?

I used an AI coding agent to map the issue list to code, propose tests, implement
the bounded runner and adapters, and review the result. I verified each claim in
a Daytona checkout of the repository and used the public CI commands as gates.

## Where did you check, correct, or reject an AI suggestion? (required)

The first AI review recommended CLI-first because arbitrary MCP validation was
too dangerous. I corrected that after reading the product requirement and issue
#15: both users are explicit targets. The final design is hybrid, but MCP has a
smaller policy surface.

I also rejected the common suggestion to wrap `execSync` in `try/catch`. That
would still use a shell, would keep unbounded output risk, and would block the
process. The implementation uses `spawn`, separates the executable and
arguments, streams bounded output, and records failures as data.

## Commands used to verify the result, with outcomes

- `npm ci`: passed in Daytona.
- `npm run typecheck`: passed.
- `npm run build`: passed; only production source files were emitted.
- `node ./dist/cli.js --help` and `--version`: passed against the compiled CLI.
- `node ./scripts/mcp-smoke.mjs`: passed through a real stdio client/server call.
- `npm test`: 12 regression assertions failed before the fixes; all 19 passed
  after the fixes.
- `npm audit --omit=dev`: passed with zero vulnerabilities after the lockfile
  refresh.

## A blocker you hit and how you approached it

The local environment returned HTTP 403 for both GitHub clone and the npm
registry. I did not retry the same route. I used the authenticated GitHub
connector for issue and source data, then used an ephemeral Daytona sandbox for
the real checkout, dependency install, tests, build, and audit.

## Known limitations and the next three things you would do

1. Add ESLint with TypeScript-aware rules and make it a required CI check.
2. Replace exact MCP command strings with named, server-owned validation
   profiles for npm, pnpm, and other build systems.
3. Kill full process groups on timeout and add Windows coverage for child-process
   cleanup.

## Approximate focused-work time

- Start: 2026-08-07 08:06 UTC
- Finish: 2026-08-07 08:41 UTC
