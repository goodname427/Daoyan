# 参与开发

## 环境

- Node.js 20（版本见 [`.nvmrc`](./.nvmrc)）
- npm
- Playwright Chromium：`npx playwright install chromium`

首次克隆后运行：

```bash
npm ci
npm run hooks
npm run verify
```

## 开发方式

1. 从 `master` 创建短期分支：`feat/<name>`、`fix/<name>`、`docs/<name>`；Codex 创建的分支使用 `codex/<name>`。
2. 较大功能先从 [`docs/specs/template.md`](./docs/specs/template.md) 建立规格。
3. 小步实现并持续运行相关测试。
4. 提交前运行 `npm run verify`，推送前运行 `npm run verify:full`。
5. 使用 Conventional Commits，例如 `feat(app): 增加法术搜索`。
6. Pull Request 必须说明验收结果、测试、体验路径和文档影响。

完整流程见 [`docs/workflow.md`](./docs/workflow.md)，项目约束见 [`AGENTS.md`](./AGENTS.md)。
