# 月灯群岛

2–4 人合作网页桌游。玩家从月灯港出发，运送木材和铁件、点亮信标，并在轮末共同抵挡风暴。团队只有一份胜负与总分，结算逐人展示交付、点灯和成功布防的贡献。

首页的「单人试玩」按所选总席位自动加入 1–3 名 AI 队友，并直接开局。AI 在自己的回合执行运输、点灯、布防等操作，使用与好友房相同的规则和计分。昵称留空时使用「船长」。单人局也可从原浏览器打开原链接续玩或重看结算。

## 本地运行

使用 Node.js 24。在此目录运行 `npm ci`、`npm run build` 和 `npm start`。打开 [本地游戏](http://127.0.0.1:18910/)，用独立浏览器会话加入同一航程。SQLite 默认写入当前目录的 `rooms.sqlite`。

- `npm test` 验证规则与 2、3、4 人的完整引擎流程。
- `npx playwright install chromium` 后运行 `npm run test:browser`。测试会启动独立的临时数据库，使用桌面浏览器和移动触屏模拟器玩完好友局，再玩完一局单人模式，覆盖 AI 回合重启与结果留存。
- 设置 `TEST_BASE_URL` 可对已运行的测试或正式入口执行同样的浏览器流程。测试会创建一局真实比赛。在已运行的环境中，测试通过刷新验证留存。
- 可同时设置 `TEST_ANDROID_SERIAL`，使用通过 ADB 连接的 Android 设备或模拟器上的 Chrome。Playwright 会重启该设备的 Chrome，使用专用测试设备运行。

## Moon 发布

1. 将源码与锁文件放入 `/opt/moon-isles/releases/<版本>`。使用 Moon 的 Node 24 运行 `npm ci`、`npm test` 和 `npm run build`，确认测试端口的 `/gamehub/moon-isles/health`，再用两个浏览器完成一局。
2. 将 `/opt/moon-isles/current` 指到已验收版本，安装并启动 `gamehub-moon-isles.service`。数据库位于 `/var/lib/gamehub-moon-isles/`，由 systemd 管理。
3. 在 GameHub 的静态文件路由前导入 Caddy 片段，验证配置后重载。通过 [正式入口](https://release.moonl.cloud/gamehub/moon-isles/) 验证资源、邀请、WSS 和结果页。按 GameHub 目录的发布流程（不在本仓库）更新大厅首页。
4. 需要回退时恢复上一版本的 `current` 链接和 GameHub 首页。首次发布可移除入口与 Caddy 导入并停用独立服务。保留数据库。

房间使用自己的入口与席位检查。服务仅提供构建后的静态资源、自有 API 和同源 Socket.IO。

`gamehub-moon-isles.service` 写死了 moon 的环境：Node 运行时路径（借用 `/opt/pokemon-showdown/runtime/current/bin/node`）、
发布目录 `/opt/moon-isles/current` 和公网来源 `https://release.moonl.cloud`。在别处部署时按实际环境修改。

## CI

GitHub Actions 在每次推送和 PR 时用 pnpm 安装依赖（`pnpm-lock.yaml`；`package-lock.json` 供 moon 上的 `npm ci` 使用，两份锁文件需同步更新），
运行 `test`（规则与引擎测试）和 `build`（`tsc --noEmit` + Vite 构建），并做密钥与依赖漏洞扫描。浏览器端到端测试 `test:browser` 需要 Playwright 浏览器，只在本地运行。

## 许可证

本仓库代码以 [MIT](LICENSE) 发布。游戏框架 [boardgame.io](https://github.com/boardgameio/boardgame.io) 为 MIT 授权，作为 npm 依赖安装，随依赖提供许可证。
