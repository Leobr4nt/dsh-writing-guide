# 交接：DSH 写作模式 / SillyTavern 兼容插件

更新时间：2026-11-12。当前版本：0.5.13（常驻运行器仍有兼容边界）。下文旧开发机记录按历史保留，最新进度见文末及 KNOWN_ISSUES.md。

> 接手先读本文，再看 README.md。不要把模块加载成功、无异常返回或单元测试通过，写成“完整酒馆兼容”。

## 用户要求，必须延续

1. 写作入口是 **DSH 正常会话中的“写作模式”**。插件页只管理预设、世界书、角色卡和扩展。
2. 功能语义按 SillyTavern、酒馆助手、提示词模板的公开源码实现；先核对实际函数，不凭印象自造接口。
3. 正则/助手区分全局、预设、角色卡，直接读写所属素材；来源、目录、单条启停分别判断。
4. 后续业务验收固定使用用户提供的完整套装：`文风11.2.json`、`v0.82_-_2.json`、`WuWa_Solaris-3_MVU_Edition1110.png`。
5. **禁止向 Codex 或 DSH 开发会话展示这些素材的正文、提示词、脚本内容、变量值或生成正文。** 程序可原样解析/执行/比较；工具输出只准结构、数量、哈希、布尔值和预定义错误类别。不要直接打印异常、日志、playwright页面内容或esbuild错误片段。
6. 不把素材、缓存中的第三方脚本、聊天记录、状态快照、API Key、凭证提交 GitHub。
7. 用户已授权协作开发、测试和同步此仓库，不要重复询问常规开发操作。不得改动 DSH 核心或全局模型配置。

## 在另一台 Windows 电脑继续

1. 登录有权限的 GitHub 账号，克隆本私有仓库，或下载并解压 ZIP 到固定目录。
2. 安装 Node.js 24.9+ 和 Chrome/Edge。运行 `npm ci --ignore-scripts`。
3. 在 DSH 创造模式让插件管理器执行 `install_bundle`，安装当前本地目录，启用后正常重启。
4. 在新电脑的 DSH 中自行配置可用写作端点。现有写作通道要求 pi-ai provider 的 `api=openai-completions`、明确的 baseURL/models 和 apiKeyEnv 凭证引用。仓库不附账号或API Key。
5. 迁移素材：用本机生成的**私有迁移包**，或单独携带上述3个原文件。私有迁移包只保存在原电脑，没有上传GitHub。
6. 若重新导入：先导入世界书和预设，再导入PNG卡。卡内569条世界书会自动加入列表并关联。新建写作模式会话，将外部世界书、预设、角色卡绑定到该会话。
7. 在“写作指导 → 扩展”选择这个会话；分别启用预设和角色卡的助手来源，按需启用正则来源；模板页勾选该预设；最后开启**本会话常驻运行**。
8. 更新本地 `~/.dsh/writing-guide/validation-suite.json` 的原文件路径和新会话ID；只修改元数据，不展开正文。旧电脑的DSH会话ID不能直接对应新建会话。

首次使用常驻运行器会下载白名单公开模块。建议连同本地 `runtime-modules/` 目录和manifest迁移，保持已验收依赖的哈希版本；它不属于Git仓库。

如果浏览器路径不在自动发现列表，设置当前启动环境的 `DSH_WRITING_BROWSER` 为 Chrome/Edge 可执行文件。未在 macOS/Linux 实测。

## 套装技术清单

- 外部世界书：11条。
- 预设：103个prompt，附带14条正则、1个助手脚本。
- 角色卡：内置569条世界书，22条正则、8个助手脚本。
- 稳定本地ID：`community-v082`、`suite-wuwa-solaris3-mvu-1110`、`suite-style-11-2`、`card-world-5396bed1bdfe321bf6c7`。
- 开发机独立验收会话：`session-e1ab225b-8f70-480e-a124-185f122956d3`。新机器需重新创建并更新ID。
- 原文件SHA256与路径在本机validation-suite.json，不在仓库。

## 初版常驻运行器的验证记录（历史）

- 正常DSH写作模式；预设/卡/世界书的组装与绑定；角色内置书独立保存、关联、去重及导出。
- 全局→预设→角色卡扩展来源读取与回写、目录gate、同名ID隔离、导入/导出基本语义。
- 独立Chrome/Edge无界面浏览器，真实ES模块和iframe脚本实例常驻；不使用用户浏览器profile、Cookie或凭证。
- 公开模块白名单获取、本地缓存、SHA256校验；运行中脚本网络请求被拦截，WebSocket也被关闭。
- 实际MVU模块从公开依赖加载，不是自行伪造的Mvu对象。
- 在固定套装的隔离副本中：9个脚本模块均加载；MVU初始化了两本书的状态；实际parseMessage/replaceMvuData以及MESSAGE_RECEIVED事件更新都验证通过，随后恢复副本。
- 该次实际组装的21条配置消息完成异步EJS渲染，残留EJS标记0。
- 正常生成hook已接入：生成前初始化和模板处理，回复后发消息事件并保存变量；失败/取消丢弃本轮运行器；并发版本冲突不覆盖。
- 29个测试文件通过，包括常驻闭包、事件隔离、async模板、网络阻断、错误保密、预算重建与事务回滚。

## 初版常驻运行器的限制记录（历史，现状以 KNOWN_ISSUES.md 为准）

- **附带脚本仍有部分界面/宿主API错误。9个模块加载≠9个业务功能全部正常。** 状态中保留错误类别，不能吞掉或用空对象伪装成功。
- 浏览器内的脚本UI、按钮、状态栏、图鉴等尚未映射到DSH可见聊天界面；正常正文的显示正则/美化仍不是完整酒馆效果。
- 世界书脚本的运行改动目前存于会话副本，未自动回写原始素材；与酒馆的全局世界书持久化仍有差异。
- 脚本运行数据在会话/来源内隔离，尚非酒馆所有跨聊天全局生命周期语义。
- 浏览器helper版本API表示目标接口合同版本，不代表安装了原版酒馆助手；支持范围以实测为准。
- 高级template include、全部变量选项、世界书装饰器/注入语义、所有slash命令、额外模型请求仍不完整。
- 模型选择器右下角仍可能显示宿主DeepSeek。真实写作端点看写作配置和diagnostics.writingRoute；不要向用户声称右下角已改好。
- 电脑控制工具在开发机拒绝操作DSH，重启由用户完成；本轮没有点击新页面的UI验收证据。无需为此改用不受控UI绕过方式。

## 源码入口

- `lib/tavern-browser.js`：独立浏览器、脚本iframe加载、EJS渲染、消息事件、元数据状态；safeRuntimeIssue禁止泄露错误正文。
- `lib/tavern-host.js`：变量/消息/世界书/事件宿主适配；真实script与message作用域映射。
- `lib/tavern-events.js`：emit顺序await，emitAndWait不等待；每个脚本的清理边界在host中处理。
- `lib/runtime-modules.js`：限定公开模块下载、缓存与hash；禁止Node模块获得宿主访问。
- `lib/resident-runtime.js`：按会话保留实例、成功后存状态、失败释放、最大4会话/空闲5分钟释放。
- `lib/session-hook.js`：真正的llm/stream接管点；普通模式和辅助标题/摘要不接管。
- `lib/scope-routes.js` / `lib/extension-scopes.js`：来源与启用范围；运行器开关。
- `lib/card-lore.js` / `lib/character-book.js`：内置世界书导入、字段转换、关联与去重。

## 验收方法

先运行 `npm test`。真实套装仅由下面工具按元数据方式处理：

```powershell
node scripts/verify-resident-suite.mjs "<数据目录>\validation-suite.json" "<本地输出目录>\resident-status.json"
```

工具不展示正文/变量值，不调用模型；会在隔离副本加载附带脚本和公开模块，检查MVU初始化、自动选取字段的事件更新与恢复、模板展开。返回0表示这些**核心项目**通过，错误列表仍可能提示助手界面功能不全。

旧 `scripts/verify-suite.mjs` 验证的是0.3.x的QuickJS单次运行器，该套装会失败；不要用旧结果否定或替代新运行器的验收，也不要删掉旧测试。

真实模型请求验收必须继续通过标准DSH会话进行，只读取完成原因、用量计数、diagnostics和状态结构，严禁把assistant正文传回开发聊天。

## 已查阅公开源码

- SillyTavern：06bde939fb1e9c4c8d8641d810f0a916b5bce127。
- JS-Slash-Runner：91a706cfcc884baae3c9da47e5d672901a5d65a6。
- ST-Prompt-Template：d6f520d149aba146305b0b781ddd691d449c28d2。
- MagVarUpdate：d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc；实际加载artifact的URL/hash由本地模块缓存记录。

依赖与许可说明见 THIRD_PARTY_NOTICES.md。受AGPL/非商业许可项目只用于查阅接口行为，未将其源码复制进本仓库。

## 与 DSH 继续协作

本机已有独立Codex↔DSH桥，但未包含在这个插件仓库中。新电脑需要单独配置桥；若暂时没有桥，可在DSH创造模式中开发并由Codex审查本地文件。桥的.runtime.json含本机认证信息，绝不能上传或照搬到另一台电脑。

DSH的“accepted”只表示收到消息，idle也不自动表示成功，要看turn/end与诊断。不要反复remove/install_bundle热重载：开发机发生过Windows文件占用导致部分卸载；使用正常退出重启。

## 接手后的优先顺序

1. 复现本套装核心验收，确认依赖缓存与新电脑模型配置。
2. 对剩余助手错误按公开API名称定位，不读取用户具体脚本内容；补真实接口，不做空实现。
3. 将浏览器UI/显示正则接入DSH正式slot，并明确模型显示；不要通过DOM强改或覆盖原始历史伪装渲染。
4. 补全世界书变更持久化、全局脚本生命周期与完整模板规则，再验收跨轮状态和重启恢复。

真实模型请求的最终结果将在本文末尾追加，不要根据“已部署”自行推断成功。

## 最终停止点（用户要求回家继续）

- 核心隔离验收通过：9个脚本模块加载、MVU真实初始化、自动选取字段的解析/写回与MESSAGE_RECEIVED事件更新、21条配置消息模板展开，无EJS残留。附带脚本仍有界面API错误，不算整套通过。
- 最后真实DSH模型请求结束为 error / WRITING_GUIDE_FAILED；原因类别为输出长度上限（finish=length），当时maxTokens=4096。助手正文0条，resident状态未提交，变量版本仍0。原始正文/错误未展示。
- 已请求DSH把仅此验收会话上限改为12288；交接时磁盘读数为 12288。回家先核对，不能假定已修改成功。没有发第二次生成请求。
- 用户明确要求“上传git吧，我回家改”，因此停止重试并提交当前稳定代码与文档。已跑29个测试文件，全部通过；真实模型端到端验收仍未通过。
- 私有迁移包已在原电脑生成，约13MB：DSH写作套装-私有迁移包-20261111.zip。必须自行带走，它不在GitHub。另有本地交接文档副本。
- 已安装的0.4.0源码与待上传仓库runtime文件比对一致；用户已完成重启。

## 0.4.1 家用电脑继续开发记录

DSH 已从 0.2.1-rc.2 升级至官方 0.2.2-rc.1。安装器返回成功后遗漏 runtime 目录内容，导致 office SKILL.md 缺失；已从同一个签名有效的官方安装包提取并补齐资源，用户确认能进入主界面。程序及用户数据升级前已备份；安装目录中的自用 work/tmp 等文件已恢复。未移植旧版核心补丁。

本机模型连接实际名称为 `catecli`，模型 ID 为 `vtx-gemini-4-argon`，不同于旧开发机的 `catiecli`。插件默认绑定已配置此路由，未改宿主默认模型。

用户随后明确要求把三份素材导入正式插件并设为默认套装。已保留示例素材及已有会话绑定，选择对应预设、角色卡、外部世界书及角色关联书；默认输出 12288，启用这两类素材的 helper/regex 来源及该预设的模板，并启用可单独关闭的常驻运行默认开关。原始文件和正式数据仍只保存在本机。

已完成：

- 修复会话 maxTokens/contextWindow 被忽略的问题。此前仅改绑定的 12288 不保证请求采用该值；现在绑定正数覆盖全局写作设置，并受模型容量约束。
- 真实验收使用独立 profile 和私有素材副本，通过正式 Agent 创建、writer preset、followup、Session 持久化执行。首轮保存 1 条助手消息、6238 字符、常驻变量版本 1；退出验收进程并恢复原 Session 后，第二轮保存 1 条助手消息、8602 字符、变量版本 2。两轮 turn/end 都是 completed。输出长度只作为计数，不代表内容质量；没有展示正文。此结果更新了旧“真实生成尚未通过”的停止点。
- 固定套装核心隔离验收继续通过：9 模块、2 本初始化书、21 条模板且无残留标记，MVU 事件更新及恢复通过。
- 补齐 loadWorldInfo、UUID、脚本元数据/按钮更新与 jQuery UI；当前只剩 1 条网络阻断和 1 条没有公开 API 名称的引用错误。不要为消除提示而开放脚本网络、提供空实现或打印私有错误文本。
- 正式 composer dock 显示写作模型及可用脚本按钮。独立浏览器的合成界面验证已覆盖模型标签、按钮派发、按钮状态刷新；DSH 原生界面仍需用户确认。源码通过 residentManager 传入路由，关闭常驻开关也会释放实例。
- 修复外部变量编辑被旧浏览器覆盖、素材更新未失效、重建后恢复旧 vars 的问题，补充按钮事务与世界书字段往返测试。
- 修复 Windows CRLF 测试误报；常驻验收基础设施异常不再返回退出码 0，并核对素材/状态哈希。

下一阶段仍需处理：任意脚本 DOM/图鉴/状态栏的可见交互、正文显示正则、世界书共享素材的事务写回、跨聊天全局作用域和高级模板/slash API。不得把原生助手按钮接入表述成所有脚本界面均已支持。

私有素材、测试 profile、运行器缓存、验收驱动、凭证和真实生成记录均未放入 Git 仓库。30 个测试文件通过后才部署；真实素材内容继续遵守前文保密限制。

## 0.4.2 实际界面反馈修复

用户重启后的截图显示新会话欢迎页仍无写作状态行。根因已从已安装 0.2.2-rc.1 的正式客户端源码确认：composer.dock 仅在 variant=composer 时渲染，hero 新会话不渲染。改为 conversation.input.dock 后，在官方完整运行时的隔离配置中验证了新会话、合成首轮回复、重新加载和 480px 窄屏，均正常且只出现一个面板，页面异常 0。此前独立组件测试没有覆盖宿主条件，不应当作实际宿主界面证据。此次仅修复注册位置，不改私人素材或模型绑定。

## 0.4.3 状态栏对齐和当前模式读取

根据正式桌面截图反馈，状态栏外层采用宿主 --dsh-composer-side-clearance，内层采用 --dsh-composer-card-max-width，与输入框居中且同宽。界面使用当前 Session 的 agentPreset 投影，在切换模式后立即刷新；后端优先通过已附加 Session 的 preset 读取状态，避免依赖全部会话列表的更新。配置读取失败不再静默隐藏。

官方完整 DSH 0.2.2-rc.1 隔离宿主回归覆盖：标准模式切换写作模式、新会话、首轮合成回复后、重新加载，以及480px窄窗口；状态栏与输入卡片的左边缘和宽度误差小于2px，页面异常0。此回归不使用私人素材或真实模型。正式桌面效果仍需用户重启确认。

## 0.4.4 世界书多选修复

用户指出酒馆世界书可多选。已核对当前 release（仍为06bde939）：multiple 控件、selected_world_info 数组、多书加载与角色关联书去重。后端 worldIds 已支持数组，问题在 ConfigPanel 使用 worldIds[0] 和单元素覆盖。已替换为可搜索复选框多选，保留显式保存语义；既有数据不自动改写。新增 world-multiselect 回归，完整 DSH 合成页面也验证保存后刷新仍保留两本、搜索不丢选择、逐项取消和清空。

## 0.4.5 写作配置布局

写作配置页按“写作素材”和“生成设置”分组，宽面板双栏、窄面板单栏；输出上限保留在常用区，上下文、作者注、兼容说明与使用帮助默认折叠。配置目标置于页首，保存状态和操作固定在页底，滚动长内容时仍可见。表单标签与输入控件关联，世界书继续保留可搜索多选和明确保存语义。

完整官方 DSH 隔离界面检查覆盖1440、1135、800和480px窗口；未出现横向溢出，保存按钮保持可见，深浅主题及多选/高级参数保存后刷新均通过。此版本只调整界面，不自动修改用户素材、绑定或模型。

## 0.4.6 普通宏持久化

用户要求修复普通宏每次组装清空的问题。已核对 SillyTavern 06bde939 的 variables.js、variable-macros.js 与 MacroEngine.normalizeMacroResult。普通本地宏现在基于 extensions.json 中 sessions[sessionId].vars 创建事务副本，并与 EJS local / 助手 chat 变量共享存储；常驻路径以脚本初始化和 generation 事件后的快照为基线。最终计划才提交，预算重建不会累加副作用，读写采用版本检查，取消在写入队列和原子替换前检查。预览及两个元数据验收脚本使用只读变量入口。

增加addvar/incvar/decvar/hasvar/deletevar及varexists/flushvar；普通全局宏、索引宏、新式变量简写仍不支持。不能把对聊天变量的共享表述成MVU消息变量与普通宏自动同名互通。显式setvar及random赋值仍按每次执行处理，不自动消除预设自身的重置逻辑。真实聊天历史不执行宏赋值。

测试文件34个；新增普通宏与真实浏览器常驻集成测试。完整官方DSH隔离Web会话中连续两轮计数1、2，关闭Host再启动并恢复同一Session后计数3；不调用真实模型。用户固定套装核心MVU/模板隔离验收仍通过，素材及业务状态哈希不变，原有2项兼容诊断不隐藏。无需清空或迁移用户变量表；升级前备份现有状态，既有值保留。

## 0.5.0 阅读、SPreset 与六页优化

用户明确选择同一会话新增“写作阅读”视图，保留原聊天输入框及原始对话。已通过正式 conversation.view 插槽实现显示正则、无脚本iframe的Markdown/HTML美化和原文开关；不修改聊天历史。常驻脚本界面通过图像与受限输入代理在阅读视图中呈现，合成按钮点击后变量保存通过。不要把该入口表述成全部酒馆UI API已经支持。

SPreset按公开源码补齐主要配置的执行路径及预设编辑控件；纯函数脚本在QuickJS Worker中运行。工具调用有限轮次、验证JSON Schema并累计用量；最终请求保留模型和输出上限。更多约束与仍未解决的脚本错误列在KNOWN_ISSUES.md。用户允许剩余问题审计后与代码一并上传GitHub；不得隐瞒未完整兼容的部分。

六个页面统一标题、内容宽度和留白，世界书/预设/角色卡/旧版作品提供搜索，正则增加表单、JSON默认折叠，常驻说明更新。修复作者注从会话绑定进入真实请求。官方DSH隔离端点验收已通过阅读效果与原文切换、SPreset工具往返及输出处理、脚本画面点击保存、六页宽窄布局及搜索/编辑保存。固定套装核心MVU/模板验收仍通过，仍有NETWORK_BLOCKED和未定位公开名称的MISSING_API各1条。所有素材/状态哈希核验通过，无私人内容上传。

## 0.5.1 截图反馈修复（2026-11-12）

用户反馈写作阅读控件散成纯文字、插图破损。定位到完整HTML误用marked、清理删除ID和控件/脚本、图片源被移除；实际回复还混合多文档及反引号，旧解析破坏脚本。已区分静态片段和完整美化，保护script/style再解析Markdown，完整文档在独立Chrome上下文执行，网络/WS/外部导航全部拦截。通过画面及受限输入代理与DSH交互；不把不可信脚本放入DSH主文档。公开图片单独下载、地址与大小/格式检查、缓存内联；TUN fake-IP通过DoH获取真实公开地址再固定连接。

真实素材只做元数据检查：开场5图、实际回复4图加载，原来被Markdown损坏的脚本异常消失。实际套装内容没有显示或上传。合成页面证明点击更新、偏好保存恢复及原文开关。剩余边界见KNOWN_ISSUES.md。

## 0.5.2 第二轮截图反馈修复（2026-11-12）

实际回复的浅字白底由透明根背景与 light 色系共同导致。新增 surface-theme.js 的画布兜底，在每次截图前检查实际样式，只补未设置的背景；独立脚本宿主增加深色控件、公共布局类及折叠区域。后台执行帧不再暴露空白框，MutationObserver 会恢复稍后挂载的可视内容，脚本实例和事件保持常驻。

错误改为各来源最多 64 组的安全诊断，按类别/公开接口合并；errorCount 单调递增，避免重复错误归类后让交互错误漏检。UI 同时显示类型数和累计次数，溢出记录保留总数提示。私有原始错误不会保留到诊断队列或接口输出。fixed suite 仍有 NETWORK_BLOCKED 和 MISSING_API 各1次，未声称根治这些兼容问题。

39个测试通过；固定套装9模块、MVU事件更新、21模板及素材/状态哈希通过。实际回复仅检查结构/样式/数量：深色背景、4张静态图、脚本异常0。官方DSH隔离宿主阅读与脚本交互回归通过，但正式桌面验收未通过，见下方最新反馈。

### 当前停点（2026-11-12）

用户反馈“还是有问题，不过先这样吧。提交git，我要睡觉了”。0.5.2 代码已提交并推送至 main（6365198），正式插件已部署该版本；本次仅补记未解决状态，不继续修改运行代码或要求用户验收。尚未取得剩余问题的具体表现，不得把已有测试通过表述为用户界面问题已解决。等待用户明确继续后，再结合实际界面定位剩余问题。

## 0.5.3 正文应是文本（2026-11-12）

用户明确指出“完整美化”是截图，要求按酒馆源码实现。核查ST messageFormatting写入mes_text以及助手render/Iframe.vue后，修复ReadingRuntime/ReadingFrame：完整美化返回净化后的DOM文档，前端用无源脚本的iframe呈现，文字可选中复制；控制节点事件传回独立运行器，保留样式与表单状态。移除正文整页PNG与10000像素裁剪，补真实组件交互和长文/隔离测试。

注意这仍是DSH宿主适配：源脚本执行留在隔离浏览器，DOM同步并非酒馆完全同源iframe，拖拽/动画/连续异步渲染与全部UI API仍未实现。不要把此修复写成整个酒馆体验已完成。固定套装仍禁止展示正文/脚本/变量值；本轮只输出文本节点、控件和图片计数。旧的“脚本界面”画面代理没有作为正文修复的一部分改写。

## 0.5.4 真实结构回归（2026-11-12）

0.5.3只解决整页PNG，但未覆盖混合HTML前端文档与外部CSS依赖。用户再次截图反馈控制面板铺开。新增splitReadingDocuments按实际完整文档边界在Markdown之前分离，message.parts提供独立ReadingFrame和对应document/action定位；保留源头stylesheet并通过公开HTTPS安全下载器内联缓存；snapshotReadingDom补CSSOM和根color-scheme。不要恢复“混成一个div再截图”的旧方案。

新增reading-fragments及实际React多片段回归。真实素材仍只输出结构数量与CSS比较结果：截图对应消息样式恢复、默认面板折叠、无围栏/标签泄漏，原文未显示。源码边界依据酒馆助手render/Iframe.vue与isFrontend判定，不表示完整宿主生命周期已移植。其它开放问题保持。

## 0.5.5 摘要折叠修复（2026-11-12）

用户报告摘要标签像文本显示。只读结构定位到HTML前端围栏与doctype之间的注释被splitReadingDocuments漏判，尾部```独立出来吞掉后置摘要。允许围栏内前导注释/空行并保留其内容，unwrapReading同样忽略前导注释判定文档。新增reading-summary合成测试覆盖CRLF、两种围栏、注释保真、原生展开/收起和有意代码不误解释；真实消息仅检查标签计数、非空与点击状态，未显示正文或修改聊天历史。

## 0.5.6 素材扩展可发现性（2026-11-12）

固定套装数据未丢：卡22正则/8脚本；预设有效正则17（原生14与SPreset绑定16按id合并）、脚本1。扩展页原来默认读取旧示例绑定，所以截图角色卡列表看不到入口。materialExtensionCounts复用来源读取逻辑并只返回元数据；App保存只读extensionTarget，CardsPanel/PresetsPanel按钮直达ExtensionsPanel的inspect与type/section，不改scopeSession、绑定或启停。顶栏扩展恢复默认上下文。用完整客户端React模块和真实临时路由做合成UI回归，不只字符串断言。禁止把此修复称作自动启用或迁移到全局。

## 0.5.7 统一写作配置与清理旧入口（2026-11-12）

- 移除“注入”页；仍生效的开关、扫描/递归、显式世界书 token 预算、全局输出/上下文、备用温度与人设补充迁入 ConfigPanel 的全局高级设置。它有独立保存按钮，作用范围明确，不写会话绑定。清空温度保存为未设置；保留旧数据字段，不执行用户数据迁移。
- 移除素材列表的旧模式 chips、“注入中”标识和对应编辑控制。修正角色字段、chatHistory、@D 的过时说明；写作配置显式显示角色关联书开关与绑定接管开关。旧版作品页只读查看/导出；撤下 writing_chat 工具，writing_work 限制为 list/get/export。旧 HTTP 作品写入/生成接口仍为兼容保留，不能说后端全部只读。
- 新 /diagnostics 使用具体 sessionId，返回本次启动以来的请求元数据；默认配置没有请求历史。lib/diagnostics.js 是页面与模型工具共同的白名单序列化，禁止重新输出原始 sessionDiagnostics 或作者注。hook 先记录 preparing；只有 postChatCompletion 的 onRequest 边界才标记请求发起，并使用最终 HTTP 消息角色统计；模型/凭证/端点验证失败仍是未发送。
- writer 不再使用旧 prompt section，防止停用会话 hook 后回落到隐藏的旧预设。其他旧目标模式的兼容 section 保留。session-panel 区分写作停用、非 writer 与读取失败，停用时不检查运行器也不显示其按钮。
- 显示正则预览改为与 buildReading 相同的通用→显示两阶段。旧扩展“不支持”列表、中英文插件说明、文档当前版本及过时暂停状态同步整理。
- 本轮核对本地公开 SillyTavern world-info.js / PromptManager.js；世界书百分比预算算法尚未接入正常写作路径，不能仅因旧界面有此项就宣称已实现。显式 token 预算仍保留；maxChars 只是旧报告阈值，未作为硬截断暴露。
- 验证使用合成 React 全客户端+真实临时 API、实际本机 HTTP 捕获、section 回退测试和正则阅读对照。固定套装仅复核来源结构计数（卡22/8、预设17/1），未展开素材/脚本/正文，未发起收费模型请求。完整酒馆兼容和正式用户业务效果仍不因此自动验收通过。

安装必须正常退出再替换插件目录，不能混用新前端与缓存的旧 Host。更新前后比较素材、绑定、扩展状态文件哈希；无须重新导入套装或切换用户现有默认绑定。

0.5.7 最终 `node scripts/test.mjs`：47 个测试文件、0 失败。`request-diagnostics.mjs` 通过真实插件 apply/transport 与本机 HTTP 捕获验证发送边界和最终消息角色，工具与 API 使用相同脱敏结果。桌面菜单点击工具返回 coordinate input geometry is unavailable，故需要用户正常退出后部署；不以整页截图绕过正文隐私约束。

## 0.5.8 getMessageVar 未定义（2026-11-12）

报错来自非驻留 QuickJS EJS，原先只注册 getvar/setvar，缺少 scoped getter 和 `_`。参考公开 ST-Prompt-Template `src/function/ejs.ts` 与 `variables.ts`：getMessageVar 没有 withMsg 时读 STATE.cacheVars，并非只读消息表；缓存顶层 global/local/message 后者覆盖前者。新增 template-readers.js 显式注入两条隔离运行器，QuickJS 加载可信依赖 lodash.min.js；代码从不在 Node 中执行用户模板。

QuickJS 提供三个读取别名与 local/message setter 薄别名，Lodash random/sample 绑定已有种子。session-hook 把 residentState.variables.global 作为只读输入；未启用驻留也能读保存过的全局快照。Browser 去掉深合并读取，在渲染前直接从原始消息表继承当前楼，variables.templateInitialized 保留初始化状态（当前单 swipe 模型）。不要通过 hydrateChat 或 helper.getVariables 检查缺表，它们会把缺表表现为 {}。withMsg/initial 明确报不支持；未伪造跨聊天 global。

新增 template-variable-readers 合成回归：QuickJS/真实无界面浏览器一致、默认值/null/路径/clone/index/noCache、旧表继承及空表停止回溯、不恢复主动删除的数据、隔离与随机稳定、实际 hook 的失败/取消回滚和成功持久化。固定套装只检查结构和结果计数；空/已有变量各 23 条配置消息完成模板渲染且残留 EJS 为 0，素材和状态哈希不变，模型请求为 0。

完整测试 48 文件、0 失败；最终缓存隔离修正后复跑 7 个相关测试仍全部通过。固定套装常驻路径复测：9 个模块加载、2 本书初始化、MVU 更新及恢复、23 条模板通过，corePassed=true，inputsAndStateUnchanged=true。原有 NETWORK_BLOCKED 和 MISSING_API 各 1 条仍在；fullCompatibility=false，不据此宣称整套脚本已兼容。版本待正常退出 DSH 后部署，避免热替换。

## 0.5.9 酒馆助手编辑入口（2026-11-12）

旧 ExtensionsPanel 点击编辑仅 setEditor/setText，details.open 只对 import 为 true；正则有独立表单，helper 没有，造成用户看到“没有反应”。核对 JS-Slash-Runner ScriptItem/ScriptEditor/FolderEditor 后，增加 HelperScriptForm（名称、content、info，文件夹只改 name），保留原 JSON 中 data/button/export_with/id/enabled 和未知字段。编辑区自动 scrollIntoView/focus；取消清空草稿但不保存。保存继续使用原 source/path/revision，保存构造不再原地改 editor.items。

新增完整 React+真实临时路由 helper-editor 回归。旧 client.js 在“点击编辑必须显示代码输入框”断言失败；新版本覆盖全局、预设、嵌套角色卡、文件夹、新建、取消、非法 JSON、导入取消、正则表单、480px，确保不改绑定、不启用/执行脚本。本轮不查看私人脚本和变量，也不运行套装脚本；生产后端和写作流水线未改。

本轮按前端变更范围运行 helper-editor、material-extension-links、writing-config、client-api，四项通过；client.js 语法检查和 git diff --check 通过，480px 合成页面截图已核对。未重跑全量模型/常驻运行测试。部署后需重新加载 DSH 前端才能使用新编辑表单。

## 0.5.10 请求超时设置（2026-11-12）

用户希望慢模型超过原180秒仍能等待。新增 binding.requestTimeoutSeconds，DEFAULT_REQUEST_TIMEOUT_SECONDS=600，normalizeRequestTimeoutSeconds 负责缺省及1–3600秒边界。高级参数编辑默认/会话配置，非法输入前端阻止保存；持久化无需迁移旧 bindings.json。hook读取后转换timeoutMs，经index.chatTransport传入postChatCompletion；诊断/模型工具白名单带该值及timeout错误类别。已开始的请求使用开始时的快照，后续修改不追溯。

新增undici依赖只使用官方getGlobalDispatcher；每请求dispatcher包装将headersTimeout/bodyTimeout设0并委托原dispatcher，防止底层默认300秒先截断更长配置，不调用setGlobalDispatcher、不改代理或TLS。总响应计时器覆盖等待头和读完整正文，原AbortSignal仍可随时取消；每次SPreset工具模型往返各自计时，没有自动重试。升级部署需要npm ci --ignore-scripts安装新依赖后再启动DSH。

最终完整测试50文件、0失败（其中request-timeout含10个用例）；真实apply→hook→本机HTTP验证计时器传递、头/正文分别超时与取消、无自动重试、失败无变量提交、dispatcher0/0和默认/会话隔离。UI验证保存、重开、恢复默认及非法值；旧helper-editor测试需等待页面rAF自动聚焦完成再输入，已补等待以消除合成输入竞争。npm audit --omit=dev为0项；未请求真实模型、未读取私人正文。部署前备份27个素材/绑定/状态文件哈希，不修改其内容。

## 0.5.11 Persona 名字替换（2026-11-12）

用户指出 `<user>` 应替换为酒馆玩家名字。核对 SillyTavern macros.js preEnvMacros、MacroEngine legacy-markers、MacroEnvBuilder names.user、personas.selectCurrentPersona 与 PromptManager.preparePrompt，确认旧/新引擎都支持，先前只验证 rencheng 赋值/引用而未检查值内占位符的结论不完整。

新增 binding.userName（trim，缺失/空回退“用户”）与配置页输入；name-macros.js 统一 user/char/bot名字替换。renderStoryString 必须先把 legacy 标记转 curly 宏，再从内到外展开，不能直接把angle和curly放同一regex：外层setvar会吞掉内部angle标记。正常hook、card helpers、regex、SPreset、scope阅读/预览/手动脚本、resident启动及模板user/userName上下文传递同一名字。常驻host的替换函数显式序列化注入，避免闭包引用Node；名字变化使resident key和阅读cache失效。

固定套装只做程序内结构验证，使用临时合成名字覆盖绑定副本，不保存：23条模板、最终发送边界出现正确人称指令、名字出现23次、遗留user标记0、素材及状态哈希不变、真实模型请求0。不要在未设置真实名字时擅自从私人正文猜名字；默认仍“用户”。完整Persona管理和群聊不在本轮范围，旧正文不会回写。

最终完整测试51文件、0失败；新增user-name含7项，覆盖真实本机HTTP与常驻浏览器、A/B/A会话/重命名隔离、默认回退、特殊字符、scope与模板预览、SPreset和源数据保留。固定套装常驻验收corePassed=true，9模块/2书/MVU更新/23模板通过；原有NETWORK_BLOCKED与MISSING_API各1仍保留，不宣称全部脚本兼容。安装须正常退出DSH后替换，并提醒用户在写作配置中填写实际名字再生成。

## 0.5.12 折叠区应在最终界面可点击（2026-11-12）

用户要求fold draft/writing_covenant，已向本机预设添加仅markdownOnly规则；但规则生成的details被实际美化脚本二次重排为p，之前静态DOM验证不足。reading-folds.js仅抽取明确带data-writing-fold且由Parser确认显式闭合的顶层details；占位token不执行原脚本中的内容，snapshotReadingDom只在投影克隆中恢复已净化HTML，源DOM保持token供再次渲染。只删除实际参与token匹配的字符，不用跨节点Range删除无关内容；split可匹配、duplicate只恢复一次、missing/hidden将内容保存在尾部fold，fallback覆盖源CSS隐藏样式。

ReadingFrame不转发本地fold的click/key事件，native toggle调整高度并保存当前组件map；刷新/resize保持，同会话不同message/part或内容变更重置。保护子树均为静态阅读，普通未保护details/控件继续原桥接。合成reading-folds-client运行真正React组件和ReadingRuntime，包含原文textContent重排、鼠标/键盘、刷新、重新排版、窄屏、消息隔离、未闭合外层、split中间pre保留、脚本净化及fallback可见性。

真实回复仅检查结构/状态：美化段4个fold在最终iframe仍为4个；连同外部静态段共6个fold均默认关闭、点击打开、再次点击收起，uiErrors=0。未输出正文/私有脚本/变量，无模型请求。本机预设的两条规则与备份属于私人数据，不提交；程序版本升级需退出DSH后安装。

完整测试52文件、0失败；最后的跨节点保留与fallback可见性修正后再次运行reading-folds-client并复核真实最终组件，均通过。不要再以readingHtml静态节点数量代替最终美化脚本后的交互验证。

## 0.5.13 阅读滚动位置（2026-11-12）

用户反馈草稿和角色心声能展开但跳到顶部，要求排查所有类似操作。合成真实组件稳定复现旧版resize高度1px使nested scroller从5833跳到14499（回顶/跳底均可能）。生产修改仅ReadingFrame的同步测量段：收集父级scroll元素与owner/contentDocument.scrollingElement，记录top/left；临时height1测量后恢复真实高度，offsetHeight强制布局，再scrollTo({behavior:'instant'})恢复。无旧请求时刻的长期scroll快照，不把用户主动滚动拉回。

reading-scroll测试真实React及ReadingRuntime，长文5000/7000px，外层document和nested两种布局，覆盖普通/保护折叠、setting/input/select/refresh、延迟布局、窄屏、pending期间继续滚动、相同poll、smooth样式及多iframe。真实已有回复仅检查各可见summary两次toggle坐标，10次操作delta=0，未输出正文。未修改预设或历史；需更新client并重启DSH。

扩大审查发现running变化setData(null)和同row内容变化setSurface(null)也会卸载iframe回顶：现在仅session/mode/row身份变化清空，原页保留到新结果到达。captureView在回包时读取内部scroll与焦点，ready恢复panel滚动，焦点仍在外层iframe时才恢复，避免抢外部输入框。旧runtime容量4导致过期token时读新surface并提示再次操作，不自动重复原动作。错误提示新增高度会触发浏览器合理锚定，测试同时检查可见summary坐标，不能机械要求外层scrollTop绝对不变。

完整测试54文件、0失败；reading-refresh-state新增13项异步/内层状态验证，reading-scroll覆盖32项零偏移操作并检查过期恢复。最终过期提示成功条件修正后该恢复测试再次通过。源数据只做哈希保护；未发送模型生成、未展开私人正文。部署前备份27个素材/绑定/状态文件，加载前端修复需退出再启动。
