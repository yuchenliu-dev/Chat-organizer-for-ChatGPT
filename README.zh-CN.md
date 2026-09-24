# ChatGPT Sidebar Organizer

[English](README.md) | **简体中文**

ChatGPT Sidebar Organizer 是一个非官方 userscript，在 ChatGPT 页面中提供可移动的会话整理窗口。它支持自定义分区、独立状态标签、搜索、筛选、拖动排序和本地备份。除非你主动使用重命名或删除功能，否则脚本不会修改会话内容或账号中的会话数据。

版本：**2.2.0**

## 主要功能

- 自行创建带颜色的分区，不附带预设分区。
- 为会话设置可选状态：`Active`、`Reference`、`Backlog` 或不设置状态。
- 在同一分区内拖动会话，保存自定义顺序。
- 直接拖动调整分区顺序。
- 按分区、状态和会话类型搜索或筛选。
- 只对当前未分区的会话进行批量整理。
- 直接从某个分区创建新的 ChatGPT 会话。
- 在 Organizer 中重命名或删除普通 ChatGPT 会话。
- 自动隐藏位于专案中的会话，同时保留它们原来的分区记忆。
- 导出和导入本地 JSON 备份。
- 将 Organizer 窗口拖动到页面内任意位置。

## 安装

1. 在 Chrome 或 Edge 中安装 [Tampermonkey](https://www.tampermonkey.net/)，Firefox 可使用 Tampermonkey 或 Violentmonkey。
2. 打开 userscript 管理器的控制面板并新建脚本。
3. 删除编辑器中的示例代码。
4. 选择一种语言，将对应 userscript 的完整内容复制到编辑器：
   - English：`chatgpt-sidebar-organizer.user.js`
   - 简体中文：`chatgpt-sidebar-organizer.zh-CN.user.js`
5. 保存脚本，然后刷新 `https://chatgpt.com/`。

页面中会出现 `Organizer` 窗口。拖动标题栏可以移动它，点击 `×` 可将其收起为一个小型启动按钮。

## 快速开始

1. 点击顶部的 **分区**，创建一个或多个分区。
2. 点击底部的 **重新索引**，收集 ChatGPT 原生历史列表已经加载的会话。
3. 打开一个会话后点击顶部的“当前聊天”卡片，或点击任意会话右侧的 `•••`，设置分区和状态。
4. 使用 `⠿` 拖动手柄调整会话或分区顺序。
5. 清理浏览器数据或更换浏览器前，使用 **⚙ → 导出 JSON 备份**。

完整说明参见 [manual.zh-CN.md](manual.zh-CN.md)，性能与稳定性审计参见 [AUDIT_REPORT.md](AUDIT_REPORT.md)。

## 双语支持

项目分别提供英文和简体中文的 userscript、README 与使用手册。两种脚本具有完全相同的 v2.2.0 功能、性能优化、数据格式和安全检查，并且都会识别多种语言的 ChatGPT 原生按钮与错误提示。

两个版本使用相同的本地存储键，因此从一种语言切换到另一种语言时，已有的分区、状态、自定义顺序和会话索引都会保留。启用另一个语言版本前，请先禁用或删除原来的版本。不要同时运行两个 userscript。

文档入口：

- English：[README.md](README.md) 和 [manual.md](manual.md)
- 简体中文：[README.zh-CN.md](README.zh-CN.md) 和 [manual.zh-CN.md](manual.zh-CN.md)

## 数据与隐私

Organizer 的整理数据保存在当前 ChatGPT 域名的浏览器 `localStorage` 中，包括会话标题、URL、分区、状态、自定义顺序和窗口设置。脚本不会保存聊天正文。

脚本不会把 Organizer 数据发送到单独的服务器。只有重命名和删除功能会主动修改 ChatGPT 账号中的数据；这些操作使用 ChatGPT 网页自身的接口，并要求浏览器处于登录状态。

## 兼容性与限制

- ChatGPT 网页会频繁更新。脚本尽量依赖会话 URL 格式而不是容易变化的 CSS class，但未来仍可能需要适配。
- 重新索引只能收集 ChatGPT 原生历史界面实际加载出来的会话。
- 搜索范围仅限已索引的会话标题，不搜索聊天正文。
- 重命名和删除依赖 ChatGPT 的内部网页接口，而不是公开 API。
- Work/Codex 的 URL 格式可能变化。直接重命名和删除目前只支持普通 ChatGPT 会话。

## Fork、自定义与 Issue 处理原则

任何人都可以 fork 本项目，并根据自己的使用习惯修改或优化脚本。

Issue 的处理范围会比较严格。除非 issue 描述了可复现的错误、功能回归、安全或隐私问题，或者有实质性的重大改进，否则很可能不会被处理。小型偏好调整和高度个人化的工作流需求，更适合在个人 fork 中自行实现。

## 项目文件

- `chatgpt-sidebar-organizer.user.js` — 英文 userscript 与源码
- `chatgpt-sidebar-organizer.zh-CN.user.js` — 简体中文 userscript 与源码
- `README.md` — 英文项目说明
- `README.zh-CN.md` — 简体中文项目说明
- `manual.md` — 英文完整使用手册
- `manual.zh-CN.md` — 简体中文完整使用手册
- `AUDIT_REPORT.md` — 性能、监听器、内存与 robustness 审计报告
- `tests/robustness.test.cjs` — 不依赖第三方包的 Node.js 测试
- `tests/bilingual-parity.test.cjs` — 两种语言脚本的结构一致性测试

## 卸载

在 userscript 管理器中禁用或删除脚本即可。若还想删除 Organizer 的本地数据，请先在 **⚙ → 清空 Organizer 数据** 中重置，或者清除浏览器中的 ChatGPT 网站数据。

## 免责声明

这是一个非官方社区项目，与 OpenAI 不存在隶属或官方认可关系。
