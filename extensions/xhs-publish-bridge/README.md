# 小红书发布桥接（Chrome MV3 + TypeScript）

实施计划与优先级见仓库根目录 **[`docs/plan-workbench-publish-first.md`](../../docs/plan-workbench-publish-first.md)**。

运营台在**用户点击发布**时，通过 **`chrome.runtime.sendMessage(extensionId, …)`** 调用本扩展；扩展默认打开 **`https://creator.xiaohongshu.com/publish/publish?source=official&target=image`**。创作平台在「上传图文」下通常要求**先出现至少一张图**才会展示标题/正文编辑区（你看到的「上传图片 / 文字配图」页）。扩展会：切到「上传图文」→ 将 **`payload.firstImageUrl`**（HTTPS，或本机 **`http://127.0.0.1` / `http://localhost`** 上的图）经 Background 拉取后写入页面上的 **`input[type=file]`**，若无 URL 则写入内置 1×1 占位图再试 → 等待 SPA 进入编辑区后填写标题与正文。可用 `payload.path` 覆盖入口路径。

**重要：** 桥接只做「打开创作页 + 尽量填入」，**不会**也**不能**代替你在平台上点击最终「发布」；发布前仍需你在 `creator.xiaohongshu.com` 登录、过审与手动确认发布。若标题/正文未出现，多为创作页 DOM 改版，需更新 `content.ts` 里的选择器；运营台请用 **`http://127.0.0.1:5173`** 或 **`http://localhost:5173`**（`manifest` 已允许 `localhost` 任意端口外连）。

### 开发/加载扩展（笔记链接同步必读）

1. 修改 `src/` 后执行：`npm run build`（产物在 **`dist/`**）。
2. Chrome → `chrome://extensions` →「加载已解压的扩展程序」→ 选择本目录下的 **`dist`** 文件夹（不是仓库根目录、也不是 `src`）。
3. 每次改代码后：**重新 build + 在扩展页点「重新加载」**，否则运营台仍跑旧逻辑（会出现「更新 N 条但无链接」）。
4. 「补全笔记链接」依赖创作中心 **`/api/galaxy/v2/creator/note/user/posted`**：扩展会拦截页面自带请求（含 `x-s` 签名）并从中读取 `id` + `xsec_token` 拼接 explore 链接。

## 为什么必须扩展

只有跑在 `https://creator.xiaohongshu.com/*` 下的脚本才能稳定访问该域下的 DOM。运营台域名与小红书不同源，**不能直接**给创作页赋值。

## 消息约定（运营台 → 扩展）

```ts
type Msg = {
  channel: "XHS_PUBLISH_BRIDGE";
  version: 1;
  action: "FILL_IMG_NOTE";
  payload: { title: string; body: string; path?: string; firstImageUrl?: string; imageUrls?: string[] };
  // 运营台会将「话题」合并为 #xxx 追加进 body 再下发，扩展侧无需单独字段。
};
// 心跳
type Ping = { channel: "XHS_PUBLISH_BRIDGE"; version: 1; action: "PING" };
```

## 运营台侧示例（需 HTTPS 且 origin 在 manifest `externally_connectable` 白名单）

```js
const EXTENSION_ID = "从 chrome://extensions 复制";

chrome.runtime.sendMessage(
  EXTENSION_ID,
  {
    channel: "XHS_PUBLISH_BRIDGE",
    version: 1,
    action: "FILL_IMG_NOTE",
    payload: {
      title: document.getElementById("studio-title").value,
      body: document.getElementById("studio-body").value,
      firstImageUrl: "https://…" // 可选：首张图公开 HTTPS，便于进入标题/正文页
    }
  },
  (resp) => console.log(resp)
);
```

生产环境请把真实运营台域名加入 `manifest.json` → `externally_connectable.matches`（不支持通配任意域，需写清单）。

**P0-5（推荐）：** 构建时设置环境变量 **`XHS_BRIDGE_APP_ORIGINS`**（逗号分隔的 `https://` origin），`npm run build` 会写入 **`dist/manifest.json`**。详见仓库 **[`annex/p0-5-externally-connectable.md`](../../annex/p0-5-externally-connectable.md)**。

**P0-4：** 选择器校准记录与回归清单见 **[`annex/p0-4-selector-calibration.md`](../../annex/p0-4-selector-calibration.md)**。

**v0.1.1 扩展侧修复：** 复用创作标签 `update(url)` 时不再误把「旧页已 complete」当成新页已就绪；`FILL_DOM` 对「内容脚本尚未注入」类错误自动重试；标题/正文/文件框/「上传图文」在 **open ShadowRoot** 内也会查找（仍无法穿透 **closed** shadow）。

**v0.1.2 填表逻辑：** 标题/正文对 `input`/`textarea` 使用 **原生 `value` setter**（避免 React 受控组件只见 DOM、state 仍空，进而 `fe.xiaohongshu.com` `json-to-proto` **400**）；`contenteditable` 正文优先 `execCommand('insertText')`。

**v0.1.3 发布体验：** 运营台下发 **`imageUrls`**（封面优先，最多 9 张），扩展尝试 **多文件 `DataTransfer`** 写入相册；并启动约 **48s** 的 **`MutationObserver`**，在用户稍后手动点图、编辑区才出现时仍持续补写标题/正文。

**v0.1.4 稳定性：** `MutationObserver` **不再**监听 `attributes`/`characterData`（会与创作页受控输入形成死循环，导致页面长期「加载中」）；仅在 **`childList`** 变化时防抖补写，且 **DOM 已与目标标题/正文一致时立即断开**，并限制补写次数。

**v0.1.6：** 构建脚本支持 **`XHS_BRIDGE_APP_ORIGINS`** 合并 `externally_connectable`（P0-5）；标题/正文增加 **`aria-label*`** 兜底选择器（P0-4）。

### 与控制台报错对照（排查用）

| 现象 | 常见含义 |
|------|----------|
| 扩展卡片里 **Service Worker（无效）** | 多为 MV3 **休眠**，不是坏了；运营台点发布后 Background 会再拉起。可点该链接打开 DevTools，若有无捕获异常再反馈。 |
| **`GET chrome-extension://invalid/`** | 多为 **创作站自身脚本** 拼出的探测地址，**不是**本扩展的 ID；本扩展 ID 形如 `chifkacjfcgkelffnmanodkaahpkjbnf`。 |
| **笔记管理页一直刷新、无新标签** | v0.4.0 已修：抓链超时不再 `tabs.update` 强刷笔记管理；`window.open` 不再被拦截，封面点击可正常新开 explore 标签。 |

### 如何确认「脚本点击是否被拦截」

**方法 A（最直接）**：在 [笔记管理](https://creator.xiaohongshu.com/new/note-manager) 页按 F12 → Console，粘贴执行：

```javascript
(() => {
  const card = document.querySelector(".note, motion-div.note");
  const img = card?.querySelector("motion-div.img, div.img, .img img, img");
  console.log("找到封面元素:", !!img, img?.getBoundingClientRect?.());
  img?.click();
})();
```

- **立刻出现** `xiaohongshu.com/explore/...` 新标签 → 脚本点击**未被拦**，问题更可能在扩展未匹配标题/未连上该 Tab。  
- **没有任何新标签** → 再**用鼠标点同一封面**；鼠标能开、脚本不能 → **站点要求真实用户手势**，自动化点封面不可靠。  
- 地址栏出现 **弹窗被拦截** 图标 → 对该站允许弹窗。

**方法 B（扩展诊断）**：`chrome://extensions` → 发布助手 → **Service Worker** → 控制台执行（把 `YOUR_EXT_ID` 换成扩展 ID）：

```javascript
chrome.runtime.sendMessage("YOUR_EXT_ID", {
  channel: "XHS_PUBLISH_BRIDGE",
  version: 1,
  action: "DEBUG_NOTE_MANAGER_PROBE"
}, (r) => console.log(r));
```

看返回的 `verdict`：`script_click_opens_tab` / `click_fired_but_no_new_tab` / `no_cover_element_found`。

**方法 C（补全过程中）**：同一 Service Worker 控制台过滤 `[xhs-publish-bridge]`，点「补全笔记链接」后应看到 `clickCover start`、`tryOnce`、`MAIN click` 等日志。
| **`POST ...fe.xiaohongshu.com/.../proxy 400`** | 多为站内 **草稿/上传协议** 与当前表单状态不一致（含受控输入未同步）。v0.1.2 已尽量按框架习惯写入；若仍 400，可在创作页 **手动点一下标题框再失焦** 或 **重新选图** 触发站内校验。 |

## 构建与加载

```bash
cd extensions/xhs-publish-bridge
npm install
npm run build
```

Chrome → **扩展程序** → **加载已解压的扩展程序** → 选本目录下的 **`dist/`**（不是 `src/`）。  
**注意：** 改 `manifest.json` 或 `src/` 后必须在本目录执行 **`npm run build`**，否则 **`dist/manifest.json` 仍是旧版本号**；再在 Chrome 里点扩展的 **「重新加载」**。

## 选择器维护

`src/content.ts` 内标题/正文选择器为**猜测占位**，小红书改版后会失效。请在真实 DOM 上用 DevTools 复制选择器，或维护 `annex/` 映射表并由构建脚本注入。

## 图片

当前已实现 **首张图**：`payload.firstImageUrl`（HTTPS）由 **Service Worker** `fetch`（`manifest` 已声明 `https://*/*`）再交给 content 写入 `input[type=file]`，用于进入标题/正文编辑区；无 URL 时使用内置占位 PNG 再试。**多图顺序上传**、复杂相册交互仍建议单独迭代；若官方改用 Shadow DOM 或切断 `files` 赋值，需在 `content.ts` 跟进。

## 安全

- 仅放行你们运营台 origin。
- 校验 `message.channel` / `version`，必要时加 **HMAC 或短时 JWT** 防伪造外部页调用扩展。
