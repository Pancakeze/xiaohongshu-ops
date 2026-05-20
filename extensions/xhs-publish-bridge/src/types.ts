/** 运营台 → 扩展 外部消息（需与前端约定一致） */
export type ExternalFillPayload = {
  title: string;
  body: string;
  /** 可选：相对路径（含 query），默认含 `target=image` 进入图文编辑 */
  path?: string;
  /**
   * 首张配图 HTTPS URL（运营台图稿公开地址）。创作平台「上传图文」需先有图才出现标题/正文区；
   * 扩展会尝试程序化写入 file input；失败则用内置占位图再试。
   */
  firstImageUrl?: string;
  /**
   * 参与发布的全部配图 URL（顺序：封面优先，其余按运营台顺序），与 firstImageUrl 同为 https 或本机 http。
   * 若提供则优先用于多图一次性写入；未提供时仍仅用 firstImageUrl。
   */
  imageUrls?: string[];
};

export type ExternalMessage =
  | {
      channel: "XHS_PUBLISH_BRIDGE";
      version: 1;
      action: "FILL_IMG_NOTE";
      payload: ExternalFillPayload;
    }
  | {
      channel: "XHS_PUBLISH_BRIDGE";
      version: 1;
      action: "PING";
    }
  | {
      channel: "XHS_PUBLISH_BRIDGE";
      version: 1;
      action: "SCRAPE_TOP_NOTES";
      payload: { keyword: string; limit?: number };
    }
  | {
      channel: "XHS_PUBLISH_BRIDGE";
      version: 1;
      action: "SCRAPE_PROFILE_NOTES";
      payload: { profileUrl: string; limit?: number };
    }
  | {
      channel: "XHS_PUBLISH_BRIDGE";
      version: 1;
      action: "SCRAPE_NOTE_RELATED";
      payload: { noteUrl: string; limit?: number };
    }
  | {
      channel: "XHS_PUBLISH_BRIDGE";
      version: 1;
      action: "SCRAPE_CREATOR_PUBLISHED";
      payload?: { limit?: number };
    }
  | {
      channel: "XHS_PUBLISH_BRIDGE";
      version: 1;
      action: "SCRAPE_CREATOR_PUBLISHED_POLL";
      payload: { jobId: string };
    }
  | {
      channel: "XHS_PUBLISH_BRIDGE";
      version: 1;
      action: "SCRAPE_CREATOR_NOTE_LINKS";
      payload?: { limit?: number; matchTitles?: string[] };
    };

export type FillResult = {
  ok: boolean;
  /** 已写入的字段 */
  filled?: { title?: boolean; body?: boolean; image_upload?: boolean };
  /** 调试信息 */
  detail?: string;
};

export type ScrapeNoteCard = {
  url: string;
  title: string;
  author?: string;
  excerpt?: string;
  like_text?: string;
};

export type ScrapeTopNotesResult =
  | { ok: true; keyword: string; items: ScrapeNoteCard[]; tabId?: number }
  | { ok: false; error: string; detail?: string; tabId?: number };

/** 创作服务平台 · 笔记数据（statistics/data-analysis）表格行 */
export type CreatorPublishedNoteRow = {
  title: string;
  published_at?: string;
  publish_status?: string;
  cover_url?: string;
  official_url?: string;
  impressions?: number;
  watch_count?: number;
  click_rate_pct?: number;
  likes?: number;
  comments?: number;
  favorites?: number;
  follower_gain?: number;
  shares?: number;
  avg_watch_seconds?: number;
};

export type ScrapeCreatorPublishedResult =
  | { ok: true; items: CreatorPublishedNoteRow[]; tabId?: number; linksFound?: number }
  | { ok: false; error: string; detail?: string; tabId?: number };

/** 异步抓取任务立即返回 */
export type ScrapeCreatorPublishedJobStart = {
  ok: true;
  pending: true;
  jobId: string;
};

export type ScrapeCreatorPublishedJobPoll =
  | { status: "running"; startedAt?: number }
  | { status: "done"; result: ScrapeCreatorPublishedResult }
  | { status: "error"; error: string; detail?: string }
  | { status: "unknown" };

/** 运营台 → 扩展：在已登录的 Gemini 页生图并回传 base64（与 `apps/web` / API `via-extension` 一致） */
export type GeminiRunTurnExternalPayload = {
  prompt: string;
  sessionId: string;
  apiBaseUrl: string;
  bearerToken: string;
  writeToDraftPool?: boolean;
  entryId?: string | null;
  sourceCopyVersionId?: string | null;
  /** 透存到 API turn.params（不含密钥） */
  params?: Record<string, unknown>;
};

export type GeminiExternalMessage =
  | {
      channel: "GEMINI_IMAGE_BRIDGE";
      version: 1;
      action: "PING";
    }
  | {
      channel: "GEMINI_IMAGE_BRIDGE";
      version: 1;
      action: "GEMINI_RUN_TURN";
      payload: GeminiRunTurnExternalPayload;
    };

export type GeminiDomImage = { mime: string; content_base64: string };

export type GeminiDomResult =
  | { ok: true; images: GeminiDomImage[]; detail?: string }
  | { ok: false; error: string; detail?: string };
