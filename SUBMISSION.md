 # Submission

## What did you investigate first, and why?
很简单，自己clone下来编译一下，按照仓库提供的功能调用一下，发现功能性问题
然后源码丢给Ai分析一下安全性和兼容性问题，把问题汇总一下，排个序
所以优先级很简单：让工具可以正常使用，再谈安全、Git 解析、报告和测试。


## What did you choose to implement or fix?

按 #16 的工作方式做的：一类问题一个小 PR，不塞一个大 diff。
落地顺序大致是：

**先能跑**
- #1：MCP 对外统一 snake_case，内部映射到 `ReviewRequest`；去掉 `any`，core 当事实源（#1 评论里说的：core 一层，CLI/MCP 只做封装）。
- #2：构建只编 `src`，`bin` 对准 `dist/cli.js`。

**再去优化工具设计，确定可以正常跑**
- #3：校验失败返回 `failed`，别整次 review 崩掉；stdout/stderr 分开；串行后续命令继续跑。
- #4：`exec` 换掉，改分词 + `spawn({ shell: false })`。MCP 侧另加根目录限制和默认 allowlist——这是兼容层的收口，不是产品主叙事（主叙事见下面 Interface decision）。
- #5：timeout、输出上限、超时杀进程树；CLI 松一点（60s / 256KiB），MCP 紧一点（15s / 32KiB）。大结果优先落盘，而不是往 context 里灌。

**CLI / Git 契约说清楚就百分百支持兑现**
- #6：路径别再 `split(" ")[0]`；缺值、未知参数直接报错；补 help/version。
- #7：`baseRef` 别写死 `main`，按 upstream → origin/HEAD → main/master 找；参数和路径用 `--` 隔开。
- #8：`-z` 解析 rename/copy，畸形流 fail-closed，别拼出磁盘上不存在的脏路径。
- #12：类型里写了 `untracked` 就真的产出；本地审查看 committed + staged + unstaged + untracked。

**输出和工程化**
- #13：选「实现」不选「删掉」——core 出 `ReviewResult`，CLI 选 markdown/json，MCP 给 `structuredContent`。结构化输出不等于必须上 MCP。
- #11：报告要看得见校验过没过；围栏别被输出里的 ``` 撑破；`--output` / `-` 可配。
- #14：没有出处的 `@hono/node-server` override 删掉，SDK 升到 1.30，audit 清零。
- #9 / #10：每修一带测；CI 加 lint、装包后的 CLI smoke、编译后的 MCP smoke。

## What did you intentionally not do?

- **没把 MCP 当成和 CLI 平级的生产接口（我自己是认为在本测试场景下面，cli优先级最高，mcp可有可无，最多属于那种 cli mcp start的附属关系）。** starter 里有 MCP，不等于必须长期维护两套同等级承诺。它现在是兼容对外入口。
- **没为了卡 90 分钟** 没有选择二线模型，用的是gpt sol ultracode 确实太慢了，找出来问题跑了一个晚上才出来结果，以我对GPT的了解肯定存在非常多的不必要的兜底式设计，不过无所谓了，功能修复完成，考核为先。

## Interface decision

**结论：CLI-first。**  
详细推理写在 [#16 的讨论](https://github.com/ZeroPointSix/Xsolla-repo/issues/16#issuecomment-5217159577) 和 [#15 的口述整理](https://github.com/ZeroPointSix/Xsolla-repo/issues/15#issuecomment-5217046003) 里，这里是分别是我的录音原稿和 AI汇总过后，我基本认为可以表达我对于这个场景下面的选择。

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
2. **信任边界**：CLI 吃调用者本机/沙箱权限；命令分词后 `shell: false`。MCP 实验路径额外要求 `REPOSITORY_INSPECTOR_MCP_ROOT`，默认只放行 `npm test` / `npm run typecheck` / `npm run lint`（过于麻烦了，不值当）。
3. **可靠 / 发现 / 延迟 / 体积**：CLI 链路短；发现靠 skill + `--help` 渐进暴露；大输出落盘按需读；本地无多余协议往返。
4. **多接口怎么一致**：生产只保证 CLI。结构一致靠 core 的 `ReviewResult`，不靠「纪律上维护两个产品」。
5. **什么证据会改主意**：变成集中托管的 review 服务、Agent 不再天然有 workspace、公司强制走统一 Gateway 审计，或真实流量证明主路径必须是 MCP 且 context 成本可接受——再重开讨论。

这个问题看我的音频 or 还有那个汇总稿会比较好，这里太简陋了。



## How did you use an AI coding agent?

用来扫仓库、按 issue 拆改动和测试草稿、对一下堆叠关系、整理文档。每条建议都自己思考、本地跑测试。流程固定成：看 issue → 小 PR → 带能红能绿的测试 → 再往上叠。一切以事实为基准，以实际结果为准。


## Where did you check, correct, or reject an AI suggestion? (required)

主要是AI觉得需要混合并行cli和mcp的关系，但是我的观点完全是相反的，cli优先，至于理由过长，同样还是看那个录播文字稿 or 音频。


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


## A blocker you hit and how you approached it

没有遇到。 5.6 sol max 智商足够，面对这种测试。我觉得AI时代最大的问题就是，发现不了问题。

## Known limitations and the next three things you would do

如果真的需要的话，下一步可能会考虑如果做到远程审查，or 接入 更好的评标标准，更加符合公司内部情况。


## Approximate focused-work time

- 跨度大概 2（think）+9（code） 小时量级，还是想着表达清楚自己的想法优先，没有局限于时间限制。
