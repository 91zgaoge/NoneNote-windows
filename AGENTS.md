# AGENTS.md — NoneNote Windows（移植端）

本项目是 NoneNote 多端套件中的 **Windows 移植端**。根本目录 / 唯一事实来源是相邻的 Android 仓库：

```
../NoneNote            # Android（Kotlin/Compose）—— 根本目录，先在这里实现和验证
../NoneNote-iOS        # iOS（Swift Package + SwiftUI）
../NoneNote-macOS      # macOS（Swift + AppKit/SwiftUI）
../NoneNote-windows    # 本目录（Tauri 2 + React/TS）
```

永久规则：

- Android 版本的每次功能更新或 bug 修复，都要评估并同步到本端；行为、prompt 预算、阈值、错误文案等常量与 Android 保持一致。
- 平台差异（API、UI 框架、存储、加密）按本端惯用写法适配，但用户可见行为必须一致。
- 本端尚无对应功能时，明确记为"该端无此功能，暂不适用"，不要凭空造功能。
- 验证诚实：跑过的测试写清命令与结果；跑不了的标注"未验证"。
- 若在本端直接改动，完成后回到 Android 根目录核对是否需要反向同步，并在汇报中逐端列出结果。
