# P0-4：创作页「上传图文」标题 / 正文选择器校准

**目标页（冻结验收 URL）**  
[https://creator.xiaohongshu.com/publish/publish?source=official&target=image](https://creator.xiaohongshu.com/publish/publish?source=official&target=image)

**代码位置**  
`extensions/xhs-publish-bridge/src/content.ts`：`TITLE_SELECTORS`、`BODY_SELECTORS`；填值逻辑见 `fillDom` / `setNativeInputValue` / `setContentEditable`。

## 当前选择器清单（按优先级自上而下）

### 标题

- `input[placeholder*="填写标题"]`
- `input[placeholder*="标题"]`
- `textarea[placeholder*="标题"]`
- `[data-placeholder*="标题"]`
- `.title-input input`
- `.note-editor input[type=text]`
- `input[aria-label*="标题"]`（无障碍文案改版时的常见兜底）

### 正文

- `textarea[placeholder*="输入正文"]`
- `textarea[placeholder*="正文"]`
- `textarea[placeholder*="添加"]`
- `.note-editor textarea`
- `[contenteditable="true"]`
- `textarea[aria-label*="正文"]`

## 校准流程（回归清单）

1. 使用已登录小红书的 Chrome 配置文件，打开上述 URL；必要时先进入「上传图文」并上传至少一张图，直到出现标题与正文区域。
2. DevTools → Elements：对标题框、正文框分别 **Copy → Copy selector**，与上表比对；若唯一命中且稳定，将新选择器**插入到数组靠前位置**（优先匹配更稳的）。
3. 确认受控组件：仅用 `el.value = x` 往往无效，须保留 `setNativeInputValue`（原生 setter + `input`/`change`）。
4. 若字段在 **open ShadowRoot** 内：本扩展已 `allRootsBfs()` 全树查找；**closed** shadow 无法穿透，需产品侧接受降级（剪贴板）。
5. 在本目录或扩展 README 记录 **校准日期** 与 **Chrome / 扩展版本**，便于与小红书改版对齐。

## 已知失效信号

- `fillDom` 返回 `no_matching_fields_update_selectors`
- 控制台出现 `fe.xiaohongshu.com` 草稿相关 **400**（常与受控输入未同步有关，见扩展 README 对照表）
