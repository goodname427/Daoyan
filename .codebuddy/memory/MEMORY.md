# 长期记忆

## 环境事实
- **Git 外网代理**：全局 git 配置的 `socks5://127.0.0.1:7890` 已失效（端口无监听），直连 GitHub 会被 reset。
  本机实际可用的代理端口是 **7897**（HTTP 混合端口）。
  需要联网的 git 操作用临时覆盖：
  `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 <cmd>`
  （未改全局 git config，按安全约定不做修改）

## 项目：道衍（Daoyan）
- 远端仓库：https://github.com/goodname427/Daoyan （分支 `master`）
- 技术栈：TypeScript + Vite + React + Electron；AST 为唯一 IR；暂禁递归（DAG）
- 命令约定：`npm start`（vite 浏览器体验）/ `npm run desktop`（Electron）/ `npm run dist`（打包）/ `npm run verify`（门禁）/ `npm run sandbox`（无头 CLI）/
- 详细开发日志见 `docs/dev/`，架构决策见 `docs/adr/`
