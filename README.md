# DSH 写作指导

为 DeepSeek Harness 增加“写作模式”。在正常聊天输入框创作，插件负责预设、世界书、角色卡、正则和扩展处理，回复保存在 DSH 会话历史中。

当前版本 **0.5.0**。已验证 Windows / DSH **0.2.2-rc.1**。这不是完整 SillyTavern 的移植；支持范围和仍未解决的问题见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)，开发记录见 [HANDOFF.md](HANDOFF.md)。

## 安装与更新

1. 克隆本仓库到固定目录；私有仓库需先登录有权限的 GitHub 账号。
2. 使用 Node.js 24.9+ 运行 `npm ci --ignore-scripts`。
3. 在 DSH 插件管理器安装本地目录并启用。目录内应直接包含 `package.json`。
4. 正常退出并重启 DSH。以本地目录安装后，请不要移动或删除目录。

桌面版内置命令也支持安装，例如：

```powershell
& '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add '<本地插件目录>'
```

升级插件前备份自己的 `~/.dsh/writing-guide/` 数据。更新代码与依赖后正常重启，不要反复 remove/install 热重载正在运行的脚本。

## 开始写作

1. 在 DSH 模型设置中配置可用连接。
2. 打开“写作指导 → 写作配置”，选择预设、角色卡、世界书和写作模型，点击保存。世界书支持搜索和多选；角色卡关联书自动加入并去重。
3. 新建 DSH 会话，选择“写作模式”，直接输入写作要求。
4. 想看显示正则、美化及隐藏结果时，切到同一会话的 **写作阅读**。原聊天输入框继续可用；**对话**保留原始记录。
5. 脚本套装在“扩展”中启用对应预设/角色卡来源、模板白名单和常驻运行。可启用默认常驻运行，再按会话单独关闭。

素材库页负责管理，正常创作在会话内完成。新安装只有示例素材，不附送私人卡片、模型服务、账号或 API Key。

## 模型与生成

当前写作通道使用 DSH `dsh-llm-pi-ai` 配置，要求 `api=openai-completions`、明确的 `baseURL` / `models` 和 `apiKeyEnv` 凭证引用。所选模型必须在连接列表中。

输入框上方显示实际写作模型。宿主原生模型选择器代表宿主路由，可能不同；诊断中的 `writingRoute` 是实际写作路由。插件不修改全局默认模型。

每个会话可覆盖输出上限、上下文窗口和作者注。输出上限为 0 时沿用全局写作设置，再无设置时默认 4096；最终仍受模型容量限制。预算与发送的输出上限一致。请求等待上限 180 秒，不自动重试；截断、失败和取消不会作为成功正文或变量状态提交。

## 素材与普通宏

- 预设支持 Prompt Manager 条目顺序、启停、role、深度与后置指令。
- 世界书支持关键词、次级关键词逻辑、正则、常驻、概率、有限递归和预算。
- 角色卡支持 JSON v1/v2/v3 文本字段，以及 PNG `tEXt` 中的 `chara` / `ccv3`。内置书导入为独立可编辑世界书，导出使用当前关联书。
- 正常写作会话中，`setvar/getvar/addvar/incvar/decvar/hasvar/deletevar` 及 `varexists/flushvar` 共用持久聊天变量。与助手 chat、EJS local 使用同一张会话表，跨轮和重启可恢复。
- 预算重建使用同一事务快照，失败/取消/并发冲突不提交，预览不写回。明确的 `setvar` 仍每次覆盖，含 `random` 的赋值下一轮仍重新抽取；不会自动把初始化代码变成只执行一次。
- 消息级 MVU 变量、聊天变量和全局变量是不同作用域；不宣称所有同名变量自动互通。

## 正则与写作阅读

正则按全局 → 当前预设 → 当前角色卡执行，来源、条目开关分别生效。发送与显示是不同路径：`promptOnly` 处理发送副本，`markdownOnly` 在“写作阅读”显示；不改原始历史。

写作阅读支持 Markdown、允许的 HTML/CSS、`details` 折叠以及空白替换隐藏。可随时打开“显示原文”。HTML 在无脚本 iframe 中展示，不能执行脚本或读取宿主页面；外部资源不会自动加载。当前在回复完成后刷新，不是逐 token 渲染。

扩展页提供正则名称、表达式、替换内容、位置和用途表单，高级 JSON 可展开编辑。世界书、预设、角色卡和旧版作品提供名称搜索。

## 酒馆助手与模板

常驻运行器使用本机 Chrome/Edge 的独立无界面实例，不读取用户浏览器资料或 Cookie。可用 `DSH_WRITING_BROWSER` 指定可执行文件。

已支持模块加载、部分事件、MVU、聊天/脚本变量、世界书接口、按钮和异步 EJS。成功生成后提交状态，失败/取消丢弃本轮事务；变量或素材外部更新会使旧实例失效。

会话输入框上方可操作脚本按钮。**写作阅读 → 脚本界面**可查看独立浏览器画面，点击、输入、发送常用键和滚动；图鉴、状态栏等是否可运行仍取决于脚本所需 API。需要修改原聊天历史的操作会明确拒绝。

最多保留 4 个常驻会话，空闲 5 分钟释放。脚本网络被阻断；只有模块构建器可下载白名单公开依赖并校验缓存哈希。完整生命周期与尚不支持的接口见问题清单。

## SPreset

按公开源码独立实现，保留未知字段。支持以下执行路径：

| 功能 | 当前实现 |
|---|---|
| RegexBinding | 绑定正则优先，补入不同 id 的原生规则；编辑时同步，避免重复执行 |
| ChatSquash | 前后缀、条件标签、历史区分组、分隔符、合并后函数与按前缀重新拆分 |
| MacroNest | 受支持数据宏的有界嵌套 |
| MessageInjections | OpenAI 兼容工具调用与返回示例历史 |
| ToolBindings | 启用条目的纯函数工具、参数校验、隔离执行和有限模型往返 |
| OutputPreprocessing | 整段输出函数，支持字符串或 output/hold 返回 |
| FinalRequestProcessing | 处理请求副本，保持原模型、凭证边界和输出上限 |
| FixedPresetName | 导入使用固定名称，保留本地 id |
| ForcedPostProcessing | 文本 merge/semi/strict/single 及保留工具变体 |

预设编辑页提供常用 SPreset 控件；完整配置可随预设 JSON 导入。处理函数运行于 QuickJS 隔离解释器，只有传入的 JSON 数据，不获得 DSH 凭证、网络、文件或 DOM。更多模式差异及明确拒绝的选项见 [问题清单](KNOWN_ISSUES.md#d-spreset)。

## 数据与迁移

默认数据根：`~/.dsh/writing-guide/`；自定义 `dataDir` 时以配置为准。

| 路径 | 内容 |
|---|---|
| `presets/`、`worlds/`、`cards/` | 预设、世界书、角色卡 |
| `settings.json`、`bindings.json` | 全局组装设置、默认及单会话绑定 |
| `extensions.json` | 扩展开关、普通宏/脚本/模板变量、常驻状态 |
| `runtime-modules/` | 白名单模块与完整性清单 |
| `works/` | 旧版作品数据 |

迁移前正常退出 DSH 并备份目标目录。新机器需要重新配置模型，旧 Session ID 不能直接对应新会话。DSH 正常聊天历史由宿主保存，独立于本插件素材库。

不要提交私人素材、缓存中的第三方脚本、聊天正文、API Key、`.credentials.yaml` 或整个宿主 profile。

## 验证

```sh
npm test
```

36 个合成测试文件无需模型凭证。覆盖请求角色顺序、预算、普通宏持久化、状态冲突、正则、阅读渲染隔离、SPreset、角色书往返及浏览器脚本交互。

本地固定套装核心验收：

```sh
node scripts/verify-resident-suite.mjs <本地validation-suite.json> <报告.json>
```

只输出元数据，检查 `corePassed`、`fullCompatibility` 和 `inputsAndStateUnchanged`。核心通过不等于所有附带脚本都正常。普通 UI 验收在独立 DSH home 与本地合成端点进行；真实生成、宿主重启及界面测试证据与残余问题见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 参考

- SillyTavern `06bde939fb1e9c4c8d8641d810f0a916b5bce127`
- JS-Slash-Runner `91a706cfcc884baae3c9da47e5d672901a5d65a6`
- SPreset `starowo/starowo.github.io` 的 `regex_bind/inject.js`，提交 `53bd585da14248ba10baaede7fc7ed0cebe1eeeb`

依赖与许可说明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目非 SillyTavern 或 DeepSeek 官方插件，仓库未附私人素材，也未指定对外开源许可证。
