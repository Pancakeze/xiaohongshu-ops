# P0-5：`externally_connectable` 白名单（运营台 HTTPS）

Chrome 要求 **`chrome.runtime.sendMessage(extensionId, …)` 的发起页 origin** 出现在扩展 `manifest.json` 的 `externally_connectable.matches` 中（不支持任意通配域名）。

## 开发默认

仓库内 `extensions/xhs-publish-bridge/manifest.json` 已包含：

- `http://localhost:*/*`
- `http://127.0.0.1:*/*`
- `file:///*`（本地静态原型）

## 生产 / 预发（推荐：构建时注入）

在扩展目录执行 `npm run build` 前设置环境变量 **`XHS_BRIDGE_APP_ORIGINS`**（逗号分隔的 **origin**，不要带路径）：

```bash
export XHS_BRIDGE_APP_ORIGINS="https://ops.example.com,https://ops-staging.example.com"
cd extensions/xhs-publish-bridge
npm run build
```

构建脚本会将每个 origin 规范为 **`https://host/*`** 并写入 **`dist/manifest.json`**（与仓库根 `manifest.json` 合并去重）。

## 手工维护

若不走构建注入，可直接编辑 **`manifest.json`** 的 `externally_connectable.matches`，为每条运营台域名增加一行，例如：

`"https://your-ops-host.example.com/*"`

改后务必 **`npm run build`** 再加载 **`dist/`**，否则 Chrome 仍加载旧清单。

## 与 API CORS 对齐

后端 `apps/api` 的 `CORS_ORIGINS`（或 `.env` 中 `cors_origins`）应包含同一批浏览器访问运营台时使用的 **完整 origin**（含端口），否则浏览器会拦 API 请求而非扩展。
