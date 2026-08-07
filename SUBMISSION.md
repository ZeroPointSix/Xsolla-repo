# Submission

## What did you investigate first, and why?

我先确认 starter 的可执行交付路径，而不是把既有 CI 绿灯视为功能正确：安装依赖、运行 typecheck/test、检查编译产物与 `bin` 声明，并以 stdio MCP 的真实工具调用检查 `review_repository`。原因是 Issue #16 的初始盘点已经指出两项会让用户无法使用工具的 P0：MCP 请求字段契约错配（#1）与 `bin` 指向不存在的构建入口（#2）。这一步也为后续优先级提供了依据：先让 CLI/MCP 路径可运行，再处理执行边界、资源限制、Git/报告契约和回归覆盖。

## What did you choose to implement or fix?

本次完成的是完整的、按 Issue 拆分的堆叠交付；本 PR 只做最终文档收口，不改运行时行为。

- 修复 MCP `snake_case` 请求到核心 `ReviewRequest` 的类型化映射（#1），并修正生产 `dist/cli.js` 构建与 `bin` 布局（#2）。
- 让校验的非零退出、信号和后续串行校验成为结构化结果（#3）；将执行改为无 Shell 的有界 `spawn` 路径，并对实验性 MCP 加入仓库根目录、命令 allowlist 与选项型 `base_ref` 拒绝（#4）。
- 实现校验超时、进程树终止、stdout/stderr 有界捕获和截断诊断（#5）。
- 严格解析 CLI 参数（#6）；使用安全的 Git 基准引用回退（#7）；无损、失败关闭地解析 Git rename/copy 状态（#8）；并将已提交、暂存、未暂存和未跟踪文件合并到本地审查视图（#12）。
- 实现共享的结构化结果、CLI JSON 与 MCP `structuredContent`（#13），安全地渲染 Markdown 并完善 `--output` 行为（#11）。
- PR #31 补充核心流程和定位回归测试（#9）；#32 增加 TypeScript ESLint、PR 检查、已安装 CLI 与编译 MCP smoke/audit（#10）；#30 删除无依据的 Hono override、升级 MCP SDK 后重新锁定依赖（#14）。
- 将产品定位定为 CLI-first，保留 MCP 为受限的实验性兼容接口（#15）。

### Delivery stack and intended merge order

以下 PR 均为独立、按依赖自下而上排列的堆叠；查阅本收口时它们被有意保留为未合并状态，不能假定任何一个已经进入 `main`。应先合并父 PR，再将下一项的 base 调整到已合并目标分支。

| 顺序 | PR | 覆盖 Issue / 范围 |
| --- | --- | --- |
| 1 | [#18](https://github.com/ZeroPointSix/Xsolla-repo/pull/18) | #15：CLI-first 决策 |
| 2 | [#19](https://github.com/ZeroPointSix/Xsolla-repo/pull/19) | #6：严格 CLI 参数 |
| 3 | [#20](https://github.com/ZeroPointSix/Xsolla-repo/pull/20) | #2：生产构建与 `bin` 布局 |
| 4 | [#21](https://github.com/ZeroPointSix/Xsolla-repo/pull/21) | #1：MCP 请求契约 |
| 5 | [#22](https://github.com/ZeroPointSix/Xsolla-repo/pull/22) | #4：无 Shell 校验策略 |
| 6 | [#23](https://github.com/ZeroPointSix/Xsolla-repo/pull/23) | #3：校验失败结果 |
| 7 | [#24](https://github.com/ZeroPointSix/Xsolla-repo/pull/24) | #5：超时、进程树清理与输出限制 |
| 8 | [#25](https://github.com/ZeroPointSix/Xsolla-repo/pull/25) | #7：安全 Git 基准解析 |
| 9 | [#26](https://github.com/ZeroPointSix/Xsolla-repo/pull/26) | #8：无损 Git 状态解析 |
| 10 | [#27](https://github.com/ZeroPointSix/Xsolla-repo/pull/27) | #12：未跟踪工作树文件 |
| 11 | [#28](https://github.com/ZeroPointSix/Xsolla-repo/pull/28) | #13：结构化 JSON 输出 |
| 12 | [#29](https://github.com/ZeroPointSix/Xsolla-repo/pull/29) | #11：安全 Markdown 报告与输出目标 |
| 13 | [#30](https://github.com/ZeroPointSix/Xsolla-repo/pull/30) | #14：移除无依据 Hono override |
| 14 | [#31](https://github.com/ZeroPointSix/Xsolla-repo/pull/31) | #9：核心流程回归与覆盖审计 |
| 15 | [#32](https://github.com/ZeroPointSix/Xsolla-repo/pull/32) | #10：lint、PR 检查、已安装 CLI 与编译 MCP smoke |

本收口 PR 建立在 #32 之上。按本请求，以上 PR 与本 PR 都没有合并。

## Dependency configuration verification

无来源的 override 会静默替换传递依赖的版本，掩盖上游兼容性和安全更新路径。#30 的声明基线是 #29 `fix/issue-11-safe-markdown-reporting`（`256c010`）：其 `package.json` 使用 `@modelcontextprotocol/sdk@1.29.0`，并通过 override 强制 `@hono/node-server@2.0.10`。

在 2026-08-08（CST）以 npm 11.16.0 对该基线的锁文件运行 `npm audit --omit=dev --package-lock-only --cache /tmp/xsolla-repo-npm-cache`，结果为 3 个生产依赖漏洞（1 moderate、2 high）。#30 移除 override、将 SDK 升级为 `^1.30.0` 并重新生成锁文件后，解析树为：

```text
@modelcontextprotocol/sdk@1.30.0
└── @hono/node-server@2.1.0
```

同一审计上下文在更新后报告 0 个生产漏洞。最终收口再次运行 `npm audit --omit=dev --package-lock-only --cache /tmp/xsolla-repo-npm-cache`，结果仍为 `found 0 vulnerabilities`。

## What did you intentionally not do?

- 本收口 PR 没有修改 `src/`、运行时依赖、测试逻辑或 CI 行为；它仅校正/补全交付文档。
- 没有把实验性 MCP 宣传或扩展为生产级、通用 agent 命令执行接口；它仍没有生产可用性或 CLI 行为一致性承诺。
- 没有合并任何堆叠 PR。它们被明确保留给审阅者按上表自下而上审阅和合并。
- 没有发送 GitHub 的私有 Security → Report a vulnerability 评估提交。该外部提交需要候选人姓名和申请邮箱，二者都未提供；本请求授权的是仓库分支/PR 创建，不是该独立外部提交。它是下面列出的人工后续步骤，不应被记为已完成工作。

## Interface decision

- **Decision: CLI-first。** CLI 是唯一生产契约；stdio MCP 仅是实验性兼容接口，不是生产工具，也不是不受信任 agent 的通用命令执行能力。
- **Primary user and execution environment:** 开发者从本地终端、自己的工作目录明确发起审查。CLI 继承该开发者的本地权限，但仍把校验命令分词并以 `shell: false` 启动；Shell 分隔符、管道、重定向、替换、换行和畸形引号会被拒绝而非解释。
- **Experimental MCP boundary:** MCP 要求 `REPOSITORY_INSPECTOR_MCP_ROOT`，并以 canonical real path 确认 `repo_path` 位于该根目录内。默认只允许精确的 `npm test`、`npm run typecheck`、`npm run lint`；`REPOSITORY_INSPECTOR_MCP_ALLOW_ANY_VALIDATION_COMMANDS=1` 只会放宽 allowlist，不会绕过分词、无 Shell 启动或根目录检查。
- **Implemented prerequisites:** #1 已实现 `repo_path`、`base_ref`、`validation_commands` 到核心类型的映射；#4 已实现无 Shell、命令策略和 MCP 根目录限制；#5 已实现资源边界。因此 README/SUBMISSION 不再把 #5 表述为未完成：CLI 的每个校验为 60 秒、每条 stdout/stderr 最多 256 KiB，MCP 为 15 秒、每条最多 32 KiB。捕获以流式 head/tail 方式保留可见截断标记及保留/省略字节数；超时时在 POSIX 终止进程组，在 Windows 使用无 Shell 的 `taskkill` 终止进程树，并报告未能确认的清理诊断。
- **Reliability and output tradeoff:** CLI 的可发现性来自可执行文件、帮助和本地报告；MCP 额外引入进程/协议失败模式及 agent context 预算。MCP 成功时返回相同的 `structuredContent`，文本只保留有上限的摘要。它虽有上述限制，仍没有生产可靠性、延迟、可发现性或 parity 承诺。
- **Evidence that would change the decision:** 只有当持续、具代表性的使用数据表明 agent 驱动请求主导生产使用，并证明该接口可持续执行类型化路径映射、根目录/allowlist/无 Shell 策略、超时和输出限制，且能量化满足上下文、可靠性和延迟目标时，才重新评估 MCP 的生产定位。

## How did you use an AI coding agent?

使用 AI coding agent 进行仓库调查、按 Issue 拆分的变更/测试草案、堆叠关系核对和文档整理；每一项建议都通过源码、Git diff、测试或实际 CLI/MCP 调用复核。工作流始终以小 Issue PR 为单位：先检查父分支和契约，再实现及添加定位测试，最后记录命令结果和堆叠依赖；没有把 agent 的摘要当作验证证据。

## Where did you check, correct, or reject an AI suggestion? (required)

关于 #4，AI 建议曾是“把 `exec` 换为 `execSync`，再加 `try/catch`”。我拒绝了它：`execSync` 仍经 Shell 解释，不能消除命令注入面；同步阻塞会损害并发/可观测性；而且这个替换本身没有给 stdout/stderr、超时和子进程树设置可证明的有界处理。

经检查后采用并验证的是无 Shell、有界的 `spawn` 设计：先把命令严格分词并拒绝 Shell 语法，再以 `shell: false` 启动可执行文件；异步流式捕获按每条流的预算保留 head/tail 和省略计数；到期后终止 POSIX 进程组或 Windows `taskkill` 进程树，并把退出、信号、超时或清理诊断写进结构化校验结果。`test/validation.test.ts`、`test/mcp-server.test.ts` 和最终定向测试验证了这一修正，而不是仅接受建议的表面替换。

## Commands used to verify the result, with outcomes

最终收口从移除 `node_modules` 与 `dist` 的干净工作树执行。为避免环境默认 npm cache 的所有权问题，先运行 `export npm_config_cache=/tmp/xsolla-repo-npm-cache`；以下是实际执行的、与 `.github/workflows/public-checks.yml` 相同顺序的命令。CI 只运行其中第一处 `npm test`；后两次是本次要求的正常模式稳定性复验。

```sh
export npm_config_cache=/tmp/xsolla-repo-npm-cache
npm ci --cache /tmp/xsolla-repo-npm-cache
npm run typecheck
npm run lint
npm run build
npm run smoke:installed-cli
npm run smoke:compiled-mcp
npm test
npm test
npm test
npm audit --omit=dev --package-lock-only --cache /tmp/xsolla-repo-npm-cache
```

- `npm ci --cache /tmp/xsolla-repo-npm-cache`：通过，实际输出为新增 247 个包、审计 248 个包、`found 0 vulnerabilities`。npm 另提示 `esbuild` 与 `fsevents` 的 install script 尚待 allow-scripts 审批；这不是安装失败，也没有在本 PR 执行或变更脚本策略。
- `npm run typecheck`、`npm run lint`、`npm run build`：依次通过。
- `npm run smoke:installed-cli`：通过（exit 0）。这是 #32 提交的 `scripts/smoke-installed-cli.mjs` 的准确 npm 调用，不是手工拼接 `node` 或占位路径：脚本确认已构建的 `package.json` `bin.inspector` 目标存在，执行 `npm pack --json` 并解析 tarball，断言其中包含该声明的 bin 目标；随后临时安装该 tarball，断言 `node_modules/.bin/inspector` 存在且 `inspector review --help` 匹配 `Usage: inspector review`。脚本还创建两次提交的临时 Git 仓库，并以已安装 binary 的参数数组 `["review", "--repo", repositoryPath, "--base-ref", "HEAD~1", "--format", "json", "--output", reportPath]` 写入 JSON，再解析并精确断言 `changedFiles` 为 `[{ path: "added-by-smoke.txt", status: "added" }]`。本次运行成功；该脚本本身不打印额外的成功文本。
- `npm run smoke:compiled-mcp`：通过（exit 0）。这是 #32 提交的 `scripts/smoke-compiled-mcp.mjs` 的准确 npm 调用：先断言 `dist/mcp-server.js` 存在，创建两次提交的临时 Git 仓库，然后以已提交的 `Client({ name: "repository-inspector-mcp-smoke", version: "1.0.0" })` 和 `new StdioClientTransport({ command: process.execPath, args: [mcpServerPath], cwd: projectRoot, env: { ...process.env, REPOSITORY_INSPECTOR_MCP_ROOT: temporaryRoot } })` 启动编译 MCP。客户端调用 `review_repository`，实参是 `{ repo_path: repositoryPath, base_ref: "HEAD~1" }`；脚本断言结果是非错误对象、有对象类型的 `structuredContent`、有数组类型的 `changedFiles`，并精确断言该数组为 `[{ path: "added-by-mcp-smoke.txt", status: "added" }]`。本次运行成功；该脚本同样不打印额外的成功文本。
- 三次 `npm test`：全部在正常全量模式通过；每次均为 `8 passed` 测试文件、`139 passed | 1 skipped` 测试、合计 140。
- `npm audit --omit=dev --package-lock-only --cache /tmp/xsolla-repo-npm-cache`：通过，`found 0 vulnerabilities`。
- `git diff --check origin/ci/issue-10-pr-lint-and-entrypoint-checks...HEAD`：在本 PR 文档变更完成后通过。

## A blocker you hit and how you approached it

环境中的默认 npm cache 曾因所有权导致 `EACCES`，不能把该失败误报为依赖或代码问题。未导出 cache 环境变量时，已安装 CLI smoke 的临时 `npm install` 也会读到该默认 cache 并失败；从干净工作树导出 `npm_config_cache=/tmp/xsolla-repo-npm-cache` 后，完整 CI 顺序、两个 smoke、三次全量测试和 production audit 均通过。没有为此修改运行时代码、依赖或 smoke 脚本。

测试稳定性也单独处理。PR #31 在复现 marker/子进程启动等待与 MCP 集成 deadline 的波动后，只调整测试夹具同步、集成测试 deadline 和测试专用 timeout，不改变 `src/` 的生产 timeout 策略；其 PR 记录了连续 10 次正常全量测试通过。最终收口再次以正常模式连续运行全量测试 3 次，均为 139 passed、1 skipped，作为当前稳定性证据。

## Known limitations and the next three things you would do

已知限制是 MCP 仍为实验性接口；本地测试不能替代跨平台生产可靠性/延迟数据，且 macOS 上 Windows 专用测试会跳过。下一步按优先顺序是：

1. 让审阅者依上表自下而上审阅、更新 base 并合并堆叠 PR；当前没有合并任何 PR。
2. 在 GitHub CI 观察所有堆叠 PR 的检查，并增加/确认 Windows 运行的超时和 `taskkill` 行为证据，再决定是否需要跨平台调整。
3. 由候选人提供姓名、申请邮箱和自有仓库 URL，并在获得对该独立外部动作的确认后，手工通过 GitHub **Security → Report a vulnerability** 提交；该私有提交目前未发送。

## Approximate focused-work time

- Start: approximately 2026-08-07 21:13 CST（该堆叠的 #18 首个提交）。
- Finish: approximately 2026-08-08 06:10 CST（rebase 到 #32 更新后的 head、干净安装、完整 CI 顺序、两个已提交 smoke、三次全量测试和文档收口）。
- Elapsed span: approximately 8 hours 57 minutes. 精确的个人专注分钟数未单独计时；但这套逐 Issue、逐 PR 的实现、rebase、验证和收口工作显然超过原评估的 90 分钟 timebox。不能诚实地把它表述为遵守了原 90 分钟限制。