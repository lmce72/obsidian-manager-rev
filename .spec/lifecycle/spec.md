---
title: 插件生命周期
status: active
hue: 210
desc: 启动、自检、迁移、延迟启动、自动接管、卸载清理
code: src/self-check.ts
related:
  - src/migrations.ts
  - src/main.ts
---
# 插件生命周期

管辖 BPM 插件的启动、初始化、运行期检查和卸载阶段的整体行为。

## 保证

- **启动初始化**：`onload` 阶段负责加载设置、运行数据迁移、初始化翻译系统、初始化内置标签、初始化仓库解析器、注册侧边栏图标、注册设置页面、注册命令、启动延迟启动机制、注册 Obsidian 协议处理器。自检（`performSelfCheck`）在 Obsidian 布局就绪后延迟 2 秒执行。
- **数据迁移**：`runMigrations` 在 `onload` 早期执行，确保 `data.json` 格式与当前插件版本兼容。迁移可重复执行，不产生重复数据。迁移版本号记录在 `MIGRATION_VERSION` 设置中。
- **自检与自动接管**：延迟启动启用时，`performSelfCheck` 检查 `community-plugins.json` 中是否有未被 BPM 管理的插件。如果有，显示接管提示弹窗或（如果 `AUTO_TAKEOVER` 启用）自动接管。被 `bpm-ignore` 标签标记的插件不参与接管。
- **延迟启动**：启用延迟启动后，插件的启用/禁用状态由 BPM 的 `ManagerPlugin.enabled` 记录驱动，而非 `community-plugins.json`。BPM 自身始终在 Obsidian 原生启动列表中。插件按延迟配置在指定秒数后异步启用。
- **延时开关的不变量**：`community-plugins.json` 的内容 ⇔ 延时开关状态。开启 = 被接管插件移出该文件（`enableDelaysForAllPlugins` 用 `disablePluginAndSave` 移出后以运行时延迟启用）；关闭 = 交回 Obsidian 托管（`disableDelaysForAllPlugins` 用 `enablePluginAndSave` 写回）。**该交接只在用户切换延时开关时发生，`onunload` 绝不改动插件启用状态** —— 卸载无法区分「退出 App / 重载插件 / 用户停用 BPM」，一旦在此交接，每次重载 BPM 都会改写用户配置、使延时启动失效，并被自检报成「非 BPM 管理的插件」。
- **GitHub Token 管理**：支持通过 Obsidian 的 SecretStorage API 或旧版 `settings.GITHUB_TOKEN` 存储 GitHub 访问令牌。有 SecretStorage 时优先使用并迁移旧版令牌。
- **卸载清理**：`onunload` 阶段只停掉侧边栏运行时特性（全部延迟回调在卸载后不再动作），**不改动插件启用状态、不写 `community-plugins.json`**。

## 边界

- 数据迁移只操作 `data.json` 和旧版 Markdown 导出文件，不读取或修改用户笔记。
- 自检接管只修改 `community-plugins.json`，不修改插件自身文件。
