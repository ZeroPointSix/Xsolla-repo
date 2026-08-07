# 回归覆盖审计矩阵

审计基线：父分支 `chore/issue-14-remove-unjustified-hono-override`（PR #30，`4e1df89`）。本表核对该堆叠中先前 Issue PR 的专属回归覆盖；当前 #9 的端到端核心流程测试单列于末行。

| Issue / PR | 专属回归目标 | 覆盖位置或自动化证据 |
| --- | --- | --- |
| #1 / #21 | MCP snake_case 请求映射 | `test/mcp-server.test.ts`：真实内存 MCP 客户端请求和 `structuredContent`。 |
| #2 / #20 | 仅生成生产 `dist`，编译 CLI 可启动 | `npm run build`、`node dist/cli.js --help`、`.github/workflows/public-checks.yml`。 |
| #3 / #23 | 非零退出、信号与串行后续校验 | `test/validation.test.ts`：failed、SIGTERM、`continues serially after a failed validation`。 |
| #4 / #22 | 校验不经 Shell、MCP 前置拒绝危险输入 | `test/validation.test.ts` 的 marker 用例；`test/mcp-server.test.ts` 的 option-like `base_ref`。 |
| #5 / #24 | 超时进程树清理及有界输出 | `test/validation.test.ts`：POSIX/Windows 超时、taskkill、截断与 UTF-8 边界。 |
| #6 / #19 | 严格 CLI 参数解析 | `test/args.test.ts`、`test/cli.test.ts`：缺值、未知参数、空格路径和帮助入口。 |
| #7 / #25 | Git 基准引用不被同名 tag 混淆 | `test/git.test.ts`：upstream、`origin/HEAD`、`main`、`master` 的真实仓库用例。 |
| #8 / #26 | NUL 状态流无损且失败关闭 | `test/git.test.ts` 与 `test/fixtures/git-name-status.ts`：A/D/M/R/C/T/U、Unicode、制表符、换行与畸形流。 |
| #10 / #32 | CI 编译入口与公共检查 | `.github/workflows/public-checks.yml`：PR 触发、typecheck、lint、build、编译 CLI help、全量测试和 production audit；MCP stdio 由最终手动 smoke 覆盖，不在该工作流中运行。 |
| #11 / #29 | Markdown 路径转义、围栏和输出目标 | `test/report.test.ts`、`test/cli.test.ts`。 |
| #12 / #27 | 合并已提交、暂存、未暂存和未跟踪变更 | `test/git.test.ts`：真实仓库完整视图、复制、重命名和删除后重建。 |
| #13 / #28 | 格式无关 `ReviewResult`、CLI JSON、MCP 结构化响应 | `test/core.test.ts`、`test/cli.test.ts`、`test/mcp-server.test.ts`。 |
| #14 / #30 | 生产依赖解析与漏洞消除 | `npm ls @modelcontextprotocol/sdk @hono/node-server --all`、`npm audit --omit=dev --package-lock-only`；依赖配置变更不适用单元回归。 |
| #15 / #18 | CLI 优先的接口边界文档 | `README.md`、`SUBMISSION.md` 审阅；文档决策不适用运行时回归。 |
| #9 / 本 PR | 端到端核心编排：提交变更、当前未跟踪文件和安全校验 | `test/core-flow.test.ts`：临时 Git 仓库直接断言结构化 `ReviewResult`，不快照 Markdown。 |

结论：运行时修复均有定位测试；构建、CI、依赖审计和文档决策通过相应自动化命令或审阅证据覆盖。本 PR 仅新增 #9 的独立核心流程回归测试及本审计矩阵，未修改 `src/`。
