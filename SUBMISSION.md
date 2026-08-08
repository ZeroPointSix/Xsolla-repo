# Submission

## What did you investigate first, and why?

我先没去堆功能，而是先看这个 starter **能不能真的跑起来**。

CI 看着全绿，但 #16 里已经盘过：绿灯挡不住两个 P0。我按那个思路复现：

1. `npm ci` / typecheck / test —— 基线还在。
2. `npm run build` 之后看 `bin` —— `inspector` 指着不存在的 `dist/cli.js`（#2）。
3. 起 stdio MCP 打一次 `review_repository` —— `repo_path` / `repoPath` 字段对不上，路径永远是 `undefined`（#1）。

所以优先级很简单：**先让 CLI 和 MCP 两条路能用**，再谈安全、Git 解析、报告和测试。不是因为 CI 绿就相信它，而是用真实调用拆穿「绿但坏」。

## What did you choose to implement or fix?

按 #16 的工作方式做的：一类问题一个小 PR，不塞一个大 diff。#17 那种一把梭的 hybrid 实现关了，没合。

落地顺序大致是：

**先能跑**
- #1：MCP 对外统一 snake_case，内部映射到 `ReviewRequest`；去掉 `any`，core 当事实源（#1 评论里说的：core 一层，CLI/MCP 只做封装）。
- #2：构建只编 `src`，`bin` 对准 `dist/cli.js`。

**再谈校验别把自己搞挂、别把 shell 打开**
- #3：校验失败返回 `failed`，别整次 review 崩掉；stdout/stderr 分开；串行后续命令继续跑。
- #4：`exec` 换掉，改分词 + `spawn({ shell: false })`。MCP 侧另加根目录限制和默认 allowlist——这是兼容层的收口，不是产品主叙事（主叙事见下面 Interface decision）。
- #5：timeout、输出上限、超时杀进程树；CLI 松一点（60s / 256KiB），MCP 紧一点（15s / 32KiB）。大结果优先落盘，而不是往 context 里灌。

**CLI / Git 契约说清楚就兑现**
- #6：路径别再 `split(" ")[0]`；缺值、未知参数直接报错；补 help/version。
- #7：`baseRef` 别写死 `main`，按 upstream → origin/HEAD → main/master 找；参数和路径用 `--` 隔开。
- #8：`-z` 解析 rename/copy，畸形流 fail-closed，别拼出磁盘上不存在的脏路径。
- #12：类型里写了 `untracked` 就真的产出；本地审查看 committed + staged + unstaged + untracked。

**输出和工程化**
- #13：选「实现」不选「删掉」——core 出 `ReviewResult`，CLI 选 markdown/json，MCP 给 `structuredContent`。结构化输出不等于必须上 MCP。
- #11：报告要看得见校验过没过；围栏别被输出里的 ``` 撑破；`--output` / `-` 可配。
- #14：没有出处的 `@hono/node-server` override 删掉，SDK 升到 1.30，audit 清零。
- #9 / #10：每修一带测；CI 加 lint、装包后的 CLI smoke、编译后的 MCP smoke。

相关 PR（都已进 `main`）：[#18](https://github.com/ZeroPointSix/Xsolla-repo/pull/18)–[#33](https://github.com/ZeroPointSix/Xsolla-repo/pull/33)。对照表在 `test/REGRESSION-COVERAGE-MATRIX.md`。

## What did you intentionally not do?

- **没把 MCP 当成和 CLI 平级的生产接口。** starter 里有 MCP，不等于必须长期维护两套同等级承诺。它现在是实验/兼容入口。
- **没为了卡 90 分钟把已知 P1 留着装完成。** 时间明显超了，文末如实写；评估说明 completion 不是目标，scope 和 verification 更重要，我站这边。
- **还没走 Security → Report a vulnerability。** 要 Name / Email，提交人自己填；代码和这篇 SUBMISSION 只是交卷材料。
- **合完分支还没收拾干净。** 不影响 `main` 能不能用，是后续卫生问题。

## Interface decision

**结论：CLI-first。**  
详细推理写在 [#16 的讨论](https://github.com/ZeroPointSix/Xsolla-repo/issues/16#issuecomment-5217159577) 和 [#15 的口述整理](https://github.com/ZeroPointSix/Xsolla-repo/issues/15#issuecomment-5217046003) 里，这里是定稿版。

### 为什么不是 hybrid / MCP-first

这个工具本质是 **跑在代码旁边的 repo-local 检查器**：读 git、跑 validation、出报告。资源就在当前 workspace。只要开发者或 Agent 已经有 shell/workspace，最短路径是：

```text
人 / Agent → CLI → 本机 git / 文件系统 / 校验进程
```

而不是再人为加一层：

```text
Agent → MCP client → MCP server → 再碰同一份仓库
```

MCP 真正合适的是 Notion / Slack / Linear 这类 **外部服务边界**——统一鉴权、审计、远端数据、复杂 API。把一个本地 inspector 硬抬成「服务」，是在制造边界，不是在解决边界。

另外：
- **上下文**：多个 MCP 同时挂着时，tool schema 常驻 context，可发现性会变成 context 腐蚀。CLI 更适合懒加载：prompt/skill 里知道有个 `inspector`，要用再 `--help`。
- **输出**：报告和 log 容易很大。CLI 自然是先落盘，Agent 需要哪段再 `grep`/`jq`/`head`。MCP 更容易被迫先塞进模型再截断——截断前的 token 往往已经花了。
- **信任边界**：`validationCommands` 本质是执行代码。给 MCP 完全放开 ≈ 把 RCE 交给可能被 prompt injection 带动的调用方；每次审批又会卡死高自主 Agent；死 allowlist 又把能力砍没。更干净的做法是 **sandbox 整个执行环境**，而不是在 adapter 上堆 micro-policy。底层 runner 仍然必须无 shell 拼接（#4），这和「要不要把 MCP 当主接口」是两件事。

所以：core 仍然是一份结构化结果；CLI 提供 markdown/json；Agent 也走 CLI。MCP 源码留着当实验兼容，**不广告、不承诺 parity**。

### README 五个问题（简答）

1. **主用户 / 环境**：本机开发者；已有 workspace/shell 的 coding agent（云端也是同一 sandbox 里跑 CLI）。
2. **信任边界**：CLI 吃调用者本机/沙箱权限；命令分词后 `shell: false`。MCP 实验路径额外要求 `REPOSITORY_INSPECTOR_MCP_ROOT`，默认只放行 `npm test` / `npm run typecheck` / `npm run lint`。
3. **可靠 / 发现 / 延迟 / 体积**：CLI 链路短；发现靠 skill + `--help` 渐进暴露；大输出落盘按需读；本地无多余协议往返。
4. **多接口怎么一致**：生产只保证 CLI。结构一致靠 core 的 `ReviewResult`，不靠「纪律上维护两个产品」。
5. **什么证据会改主意**：变成集中托管的 review 服务、Agent 不再天然有 workspace、公司强制走统一 Gateway 审计，或真实流量证明主路径必须是 MCP 且 context 成本可接受——再重开讨论。

## How did you use an AI coding agent?

用来扫仓库、按 issue 拆改动和测试草稿、对一下堆叠关系、整理文档。每条建议都自己对过源码、diff、测试或真跑 CLI/MCP。流程固定成：看 issue → 小 PR → 带能红能绿的测试 → 再往上叠。**不把模型总结当验收。**

## Where did you check, correct, or reject an AI suggestion? (required)

#4 上模型给过一句很常见的话：把 `exec` 换成 `execSync`，再包个 try/catch。

**拒了。** 原因就跟 issue 里写的一样：

- 还是走 shell，注入面还在；
- 同步卡住，观测性更差；
- 超时、输出上限、进程树一个都没解决。

最后做成：严格分词 → `spawn` 且 `shell: false` → 流式有界捕获 → 超时杀进程组 / Windows `taskkill` → 结果写进 `ValidationResult`。`test/validation.test.ts` 和 `test/mcp-server.test.ts` 盖住这条，不是口头改个 API 名。

## Commands used to verify the result, with outcomes

干净树（清掉 `node_modules` / `dist`），跟 CI 同序。CI 锁 Node `20.19.0` + `NPM_CONFIG_ENGINE_STRICT=true`。本机复验 Node `v24.18.0`。默认 npm cache 有权限坑，所以：

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

结果：
- 上面整段通过；
- 三次全量测试都是 **139 passed / 1 skipped**（非 Windows 跳过 Windows 专用用例）；
- production audit：**0 vulnerabilities**；
- smoke：装包后的 `inspector` 能 help + JSON review；编译后的 MCP 能 `review_repository` 并给出 `structuredContent`。

## A blocker you hit and how you approached it

默认 npm cache 报 `EACCES`。这是环境权限，不是依赖坏了或代码回归。导出独立 cache 目录后，CI 序、双 smoke、三轮 test 都过。没为这个去改业务代码。

测试里 marker / 子进程启动偶发抖，#31 只动了测试夹具和测试 timeout，**没放宽生产 timeout**。

## Known limitations and the next three things you would do

限制：
- MCP 仍是实验接口；
- Windows `taskkill` 路径在非 Windows 上 skip，缺 CI 实跑证据；
- 远端 feature 分支还没收。

接下来：
1. 填 Name / Email，走 Security → Report a vulnerability 交卷（`SECURITY.md`）。
2. 看 `main` Actions 是否全绿，删已合并分支。
3. 有余力再补 Windows runner；若以后真变成托管服务或统一 Gateway 场景，再重评要不要 MCP 生产化。

## Approximate focused-work time

- 大约从 2026-08-07 21:13 CST（#18）到 2026-08-08 06:10 CST（#33 收口验证）。
- 跨度大概 9 小时量级，**说不清成守住了 90 分钟**。选择把 #16 里列的问题做完并留下可追的 PR/测试，而不是时间盒到了就停。
