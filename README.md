# Repository Inspector

Repository Inspector is a small TypeScript tool. It finds changes in a Git
repository, runs optional validation commands, and creates a bounded review
report. It has a CLI and an MCP stdio server.

## Interface decision: hybrid

The core returns one structured `ReviewResult`. The CLI and MCP server are thin
adapters around that result.

- The CLI is for a developer at a local terminal or in CI. It can run any
  explicit executable and argument list, but it does not use a shell.
- MCP is for an AI coding agent in a local stdio process. It limits repository
  roots, validation commands, run time, and output size.
- Both interfaces use the same Git inspection, validation, and report data.
- The CLI can write full Markdown or JSON. MCP returns `structuredContent` and
  a bounded Markdown view of the same result.

This choice would change if usage data showed that one interface handles almost
all real work. It would also change if MCP always ran inside a disposable,
isolated sandbox with a separate permission prompt for each command.

## Trust boundary

Validation commands execute with the permissions of this process. The runner
uses `spawn` with `shell: false`; shell operators, pipelines, redirects, and
expansion are not supported.

The CLI treats the local user as trusted because the user already controls the
terminal. MCP treats its caller as untrusted:

- `INSPECTOR_MCP_ALLOWED_ROOTS` is a platform-delimited list of allowed root
  directories. The default is the server working directory.
- `INSPECTOR_MCP_ALLOWED_COMMANDS` is a comma-delimited exact allowlist. The
  default allows `npm test`, `npm run test`, `npm run typecheck`,
  `npm run lint`, and `npm run build`.
- MCP accepts at most 10 validation commands, uses a 15 second default timeout,
  and keeps at most 32 KiB from each output stream.

Only set broader roots or commands when the MCP server runs in an isolated
environment that you control.

## Git inspection

The tool validates the repository and base ref before it runs a diff. If no
base ref is provided, it tries the current upstream, `origin/HEAD`, `main`, and
`master`, in that order. It reports:

- committed changes from the merge base to `HEAD`;
- staged and unstaged changes;
- untracked files;
- add, modify, delete, rename, copy, type-change, and conflict states.

Git output uses NUL delimiters, so spaces and non-ASCII file names are kept.

## Setup

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## CLI

```bash
npm run inspector -- review --repo ./path/to/repo --format markdown
npm run inspector -- review --repo ./path/to/repo --validate "npm test"
npm run inspector -- review --repo ./path/to/repo --format json --output -
```

Run `npm run inspector -- --help` for all options. A failed, timed-out, or
unstartable validation is included in the report. The CLI then exits with code
2. Usage and tool errors use exit code 1.

## MCP

Start the stdio server with:

```bash
npm run mcp-server
```

It exposes `review_repository` with one naming style:

- `repo_path` (required)
- `base_ref`
- `validation_commands`
- `timeout_ms`
- `max_output_bytes`

## Output limits

The validation runner streams output instead of using `exec` buffers. It keeps
the start and end of large output and adds an omission marker. The CLI defaults
to 60 seconds and 256 KiB per stream. MCP uses stricter limits. Both can lower
or raise limits within their documented boundaries.

## Dependency note

`@hono/node-server` is a real transitive dependency of
`@modelcontextprotocol/sdk`. The override to `2.0.10` is retained on purpose;
the SDK currently declares `^1.19.9`. Remove the override only after the SDK
supports the selected major version directly and the MCP tests pass without it.

## Assessment task

This repository started as the Xsolla AI-First Engineering Intern assessment.
The work is time-boxed to 90 focused minutes. Accurate scope and verification
matter more than a large diff. Complete `SUBMISSION.md` in the final commit.

Submit through **Security -> Report a vulnerability** as described in
`SECURITY.md`. That form needs the candidate's name, application email, and
repository URL.
