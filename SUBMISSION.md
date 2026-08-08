# Submission

## What did you investigate first, and why?

我先确认 starter 的可执行交付路径，而不是把既有 CI 绿灯视为功能正确：安装依赖、运行 typecheck/test、检查编译产物与 `bin` 声明，并以 stdio MCP 的真实工具调用检查 `review_repository`。

原因来自 Issue #16 的初始盘点：CI 全绿仍掩盖两项会让用户无法使用工具的 P0——MCP 请求字段契约错配（#1）与 `bin` 指向不存在的构建入口（#2）。这一步也定下后续优先级：**先让 CLI/MCP 路径可运行，再处理执行边界、资源限制、Git/报告契约和回归覆盖**；每个缺陷按 Issue 拆独立 PR，并配「先失败、再通过」的定位测试。

## Design and implementation approach

### 总设计原则（对齐 #15 / #16）

1. **core 单一契约**：`reviewRepository` 只返回格式无关的 `ReviewResult`（`src/core.ts` + `src/types.ts`）。CLI 与 MCP 是薄适配器：CLI 负责参数/渲染/落盘，MCP 负责 snake_case 映射、策略门禁与 `structuredContent`。
2. **CLI-first**：CLI 是唯一生产契约；stdio MCP 保留为实验性兼容接口，不承诺与 CLI 的生产级 parity。
3. **失败可报告、执行有界**：校验失败返回结构化 `failed`/`timed_out`/`error`，不拖垮整次 review；进程启动一律 `shell: false`，并有超时、输出上限与进程树清理。
4. **契约与实现一致**：类型里声明的能力（JSON 输出、`untracked`、rename/copy 等）要么兑现，要么删除；不保留静默失效的字段。
5. **按 Issue 堆叠交付**：#18–#33 自下而上合并进 `main`；早期单体 PR #17 关闭未合并，避免不可审的大 diff。

### 按 Issue 的设计 → 代码落点

| Issue | 设计选择 | 实际代码修改思路 |
| --- | --- | --- |
| #1 | MCP 对外全 snake_case，内部映射到 `ReviewRequest`；去掉 `any` | `src/mcp-server.ts`：`mcpReviewRequestSchema` + `toReviewRequest`；`inputSchema`/`outputSchema` 类型化 |
| #2 | 生产构建只编译 `src`，`bin` 指向 `dist/cli.js` | `tsconfig.build.json` + `npm run build` clean；`package.json` `bin.inspector` = `./dist/cli.js` |
| #3 | 非零退出返回 `failed`，串行继续后续校验；stdout/stderr 分列 | `src/validation.ts`：`passed`/`failed`/`error`/`timed_out`；不因业务失败 reject |
| #4 | 无 Shell `spawn`；MCP 根目录 + 命令 allowlist + 拒绝 option-like `base_ref` | `tokenizeValidationCommand` + `shell: false`；`validateMcpReviewRequest` |
| #5 | CLI/MCP 分层超时与输出预算；超时杀进程树；截断 head/tail | CLI 60s / 256 KiB；MCP 15s / 32 KiB；POSIX 进程组与 Windows `taskkill` |
| #6 | 严格 argv：路径不二次 split；缺值/未知参数报错；help/version | `src/args.ts` + `src/cli.ts` |
| #7 | baseRef 探测：upstream → `origin/HEAD` → `main`/`master`；参数隔离 | `src/git.ts` 安全解析与错误包装 |
| #8 | NUL 定界 `--name-status -z`；R/C 保留 previousPath；畸形流 fail-closed | `src/git.ts` + fixtures |
| #12 | 兑现 untracked：合并 committed/staged/unstaged/untracked | `changedFiles` 完整本地审查视图 |
| #13 | 实现而非删除：core 返回对象，适配层选 markdown/json | CLI `--format json`；MCP `structuredContent` |
| #11 | 渲染 status；动态围栏；可配 `--output`/`-` | `src/report.ts`、`src/cli.ts` |
| #14 | 查清传递依赖后删除无依据 override，升级 SDK | 去掉 overrides；`@modelcontextprotocol/sdk@^1.30.0` |
| #9/#10 | 每修一带测；CI 加 lint、installed CLI 与 compiled MCP smoke | `test/*`、`scripts/smoke-*.mjs`、`public-checks.yml` |
| #15 | 定稿 CLI-first，文档写清信任边界 | `README.md` Product decision + 本节 Interface decision |
| #16 | 总览跟踪与最终文档收口 | 堆叠合并 + 本文件 |

### Delivery stack（已合入 `main`）

合并窗口：2026-08-08（CST）。当前 `main` HEAD 为合并 PR #33 的 `e5f3aa4`。开放 Issue / PR 均为 0。

| 顺序 | PR | 覆盖 Issue / 范围 | 状态 |
| --- | --- | --- | --- |
| 1 | [#18](https://github.com/ZeroPointSix/Xsolla-repo/pull/18) | #15：CLI-first 决策 | merged → main |
| 2 | [#19](https://github.com/ZeroPointSix/Xsolla-repo/pull/19) | #6：严格 CLI 参数 | merged → main |
| 3 | [#20](https://github.com/ZeroPointSix/Xsolla-repo/pull/20) | #2：生产构建与 `bin` 布局 | merged → main |
| 4 | [#21](https://github.com/ZeroPointSix/Xsolla-repo/pull/21) | #1：MCP 请求契约 | merged → main |
| 5 | [#22](https://github.com/ZeroPointSix/Xsolla-repo/pull/22) | #4：无 Shell 校验策略 | merged（经堆叠进入 main） |
| 6 | [#23](https://github.com/ZeroPointSix/Xsolla-repo/pull/23) | #3：校验失败结果 | merged（经堆叠进入 main） |
| 7 | [#24](https://github.com/ZeroPointSix/Xsolla-repo/pull/24) | #5：超时、进程树清理与输出限制 | merged → main |
| 8 | [#25](https://github.com/ZeroPointSix/Xsolla-repo/pull/25) | #7：安全 Git 基准解析 | merged → main |
| 9 | [#26](https://github.com/ZeroPointSix/Xsolla-repo/pull/26) | #8：无损 Git 状态解析 | merged → main |
| 10 | [#27](https://github.com/ZeroPointSix/Xsolla-repo/pull/27) | #12：未跟踪工作树文件 | merged → main |
| 11 | [#28](https://github.com/ZeroPointSix/Xsolla-repo/pull/28) | #13：结构化 JSON 输出 | merged → main |
| 12 | [#29](https://github.com/ZeroPointSix/Xsolla-repo/pull/29) | #11：安全 Markdown 报告与输出目标 | merged → main |
| 13 | [#30](https://github.com/ZeroPointSix/Xsolla-repo/pull/30) | #14：移除无依据 Hono override | merged → main |
| 14 | [#31](https://github.com/ZeroPointSix/Xsolla-repo/pull/31) | #9：核心流程回归与覆盖审计 | merged → main |
| 15 | [#32](https://github.com/ZeroPointSix/Xsolla-repo/pull/32) | #10：lint、PR 检查、入口 smoke | merged → main |
| 16 | [#33](https://github.com/ZeroPointSix/Xsolla-repo/pull/33) | #16：最终交付收口文档 | merged → main |

说明：#22/#23 曾以中间分支为 base 合并，再经后续 PR 进入 `main`；审阅时以 `main` 上的最终代码与上表 PR 为准。早期单体 PR [#17](https://github.com/ZeroPointSix/Xsolla-repo/pull/17) 关闭未合并。

## What did you choose to implement or fix?

在 `main` 上已落地的完整范围（与上表一致）：

- **可运行性（P0）**：MCP snake_case → `ReviewRequest` 映射（#1）；生产 `dist/cli.js` 与 `bin` 一致（#2）。
- **校验正确性与安全（P1）**：失败结构化且串行继续（#3）；无 Shell + MCP 策略门禁（#4）；超时/截断/进程树清理（#5）。
- **CLI / Git 契约（P1）**：严格参数（#6）；安全 baseRef（#7）；NUL 无损 rename/copy 解析（#8）；完整本地变更含 untracked（#12）。
- **输出与工程化（P2）**：JSON + `structuredContent`（#13）；安全 Markdown 与 `--output`（#11）；回归矩阵与核心流程测试（#9）；ESLint + installed CLI / compiled MCP smoke + audit（#10）；移除无依据 override（#14）。
- **产品决策（#15）**：CLI-first，MCP 实验性兼容。

## Dependency configuration verification

无来源的 override 会静默替换传递依赖版本。#30 前基线使用 `@modelcontextprotocol/sdk@1.29.0` 并通过 override 强制 `@hono/node-server@2.0.10`；当时 `npm audit --omit=dev --package-lock-only` 报 3 个生产漏洞。

#30 删除 override、将 SDK 升为 `^1.30.0` 并重锁后：

```text
@modelcontextprotocol/sdk@1.30.0
└── @hono/node-server@2.1.0
```

同一审计上下文为 `found 0 vulnerabilities`。`main` 收口复验结果相同。当前 `package.json` 无 `overrides` 字段。

## What did you intentionally not do?

- **没有把实验性 MCP 做成生产级通用 agent 命令执行接口**：无生产可用性、延迟或与 CLI 行为一致性承诺；默认仍受根目录与 allowlist 约束。
- **没有为了赶 90 分钟 timebox 而砍掉已识别的 P1/P2**：实际选择完整堆叠交付并如实记录超时（见文末时间）。
- **没有发送 GitHub Security → Report a vulnerability 私有交卷表单**：该动作需要候选人全名与申请邮箱（见 `SECURITY.md`），二者须由提交人确认后单独填写；本仓库工作只准备代码与 `SUBMISSION.md`，不代替该外部表单。
- **没有在合并后立即删除全部远端 feature 分支**：功能已在 `main`；分支清理可作为合入后的仓库卫生项，不阻塞交卷叙述。

## Interface decision

- **Decision: CLI-first。** CLI 是唯一生产契约；stdio MCP 是实验性兼容接口，不是不受信任 agent 的通用命令执行能力。
- **Primary user and execution environment:** 开发者从本地终端、自己的工作目录明确发起审查。CLI 继承该开发者的本地权限，但校验命令仍经分词并以 `shell: false` 启动；Shell 分隔符、管道、重定向、替换、换行和畸形引号会被拒绝。
- **Why not hybrid-as-equal or MCP-first:** Issue #15 曾倾向「core + 双适配器」。落地后保留该结构，但**产品承诺只给 CLI**：MCP 额外引入进程/协议失败与 agent context 成本，且校验能力必须更窄。在缺少「agent 为主路径」的代表性证据前，不把 MCP 升为生产接口。
- **Experimental MCP boundary:** 要求 `REPOSITORY_INSPECTOR_MCP_ROOT`；`repo_path` 经 canonical real path 必须落在根内。默认仅精确允许 `npm test`、`npm run typecheck`、`npm run lint`。`REPOSITORY_INSPECTOR_MCP_ALLOW_ANY_VALIDATION_COMMANDS=1` 只放宽 allowlist，不绕过 tokenizer、无 Shell 或根检查。
- **Implemented prerequisites:** #1 类型化路径映射；#4 shellless + 策略；#5 资源边界（CLI 60s/256KiB，MCP 15s/32KiB；流式 head/tail 截断；POSIX/Windows 进程树清理与失败诊断）。
- **Evidence that would change the decision:** 仅当持续数据表明 agent 驱动为主，且能在类型化路径、根/allowlist/shellless、超时与输出限制下满足可测的可靠性与延迟目标时，才重评 MCP 生产定位。

## How did you use an AI coding agent?

使用 AI coding agent 做仓库调查、按 Issue 拆分的变更/测试草案、堆叠关系核对和文档整理。每一项建议都经源码、diff、测试或真实 CLI/MCP 调用复核。工作流以小 Issue PR 为单位：核对父分支与契约 → 实现并加定位测试 → 记录命令结果与依赖顺序。**不以 agent 摘要代替验证证据。**

## Where did you check, correct, or reject an AI suggestion? (required)

关于 **#4**，AI 建议曾是「把 `exec` 换成 `execSync` 再加 `try/catch`」。**已拒绝。**

- `execSync` 仍走 Shell，不能消除命令注入面。
- 同步阻塞损害可观测性，且未给 stdout/stderr、超时和子进程树提供可证明的有界处理。

**改为并已验证的方案：** 严格分词并拒绝 Shell 语法 → `spawn(..., { shell: false })` → 按流预算异步捕获 head/tail 与省略字节数 → 超时后 POSIX 进程组或 Windows `taskkill` 清理 → 将退出码/信号/超时/清理诊断写入 `ValidationResult`。证据在 `test/validation.test.ts`、`test/mcp-server.test.ts` 与 CI smoke，而非接受表面替换。

## Commands used to verify the result, with outcomes

收口与合入前在干净工作树（无 `node_modules`/`dist`）按 `.github/workflows/public-checks.yml` 同序验证。CI 使用 Node `20.19.0` 与 `NPM_CONFIG_ENGINE_STRICT=true`；根包引擎 `^20.19.0 || ^22.13.0 || >=24`。本机复验 Node `v24.18.0`，并导出 `npm_config_cache=/tmp/xsolla-repo-npm-cache` 以避免默认 cache 权限问题。

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

- `npm ci`：通过；生产 audit 0 vulnerabilities（另有 esbuild/fsevents allow-scripts 提示，非失败）。
- `typecheck` / `lint` / `build`：通过。
- `smoke:installed-cli`：pack → 临时安装 → `inspector review --help` 与 JSON review 断言 `changedFiles`（exit 0）。
- `smoke:compiled-mcp`：启动 `dist/mcp-server.js`，`review_repository` 返回非错误 `structuredContent.changedFiles`（exit 0）。
- 三次全量 `npm test`：每次 8 files passed，**139 passed | 1 skipped**（Windows 专用路径在非 Windows 上 skip）。
- `npm audit --omit=dev --package-lock-only`：`found 0 vulnerabilities`。

回归证据索引见 `test/REGRESSION-COVERAGE-MATRIX.md`。

## A blocker you hit and how you approached it

1. **默认 npm cache `EACCES`**：不能误判为依赖或业务代码失败。导出 `npm_config_cache=/tmp/xsolla-repo-npm-cache` 后完整 CI 序、双 smoke、三次全量测试与 audit 均通过；未因此改运行时代码或 smoke 脚本。
2. **测试稳定性**：#31 在 marker/子进程与 MCP 集成 deadline 波动后，只调测试夹具与测试专用 timeout，不放宽 `src/` 生产 timeout；并保留连续全量测试通过作为稳定性证据。

## Known limitations and the next three things you would do

**已知限制**

- MCP 仍为实验性接口。
- 本地/macOS CI 不能替代 Windows 上 `taskkill` 进程树清理的生产证据（相关测试在非 Windows 会 skip）。
- 远端仍可能残留已合并的 feature 分支，不影响 `main` 功能正确性。

**下一步（交卷向）**

1. **正式提交**：在确认候选人 **Name**、申请 **Email** 后，于本仓库 **Security → Report a vulnerability** 填写（见 `SECURITY.md`）：`Name` / `Email` / `Repo: https://github.com/ZeroPointSix/Xsolla-repo`，并指向本 `SUBMISSION.md`。
2. **合入后卫生**：确认 `main` 上 Actions 全绿；删除已合并远端分支。
3. **可选增强**：为 Windows runner 增加超时与 `taskkill` 证据；若出现真实 agent 主路径数据，再重评 MCP 是否升为生产接口。

## Approximate focused-work time

- Start: approximately 2026-08-07 21:13 CST（堆叠 #18 首个提交）。
- Finish: approximately 2026-08-08 06:10 CST（rebase 到 #32、干净安装、完整 CI 序、双 smoke、三次全量测试与 #33 文档收口）；其后堆叠 PR 已合并入 `main`。
- Elapsed span: approximately 8 hours 57 minutes 的实现与收口跨度。精确个人专注分钟数未单独计时；**不能诚实表述为遵守了原 90 分钟 timebox**。选择完整修复与可验证堆叠，而非在时间盒内留下已知 P0/P1。

## Submission checklist (pre-advisory)

- [x] #1 #2 已修且有测试/smoke
- [x] #3–#8 #11–#14 已按设计落地并合入 `main`
- [x] #15 CLI-first 决策已写进 README 与本文件
- [x] #9/#10 回归与 CI 门禁已合入
- [x] 独立 PR 链接可追溯（上表 #18–#33）
- [x] 「Where did you check, correct, or reject an AI suggestion?」已填
- [x] 未做项与理由已写明
- [ ] Security → Report a vulnerability（待 Name / Email 确认后提交）
