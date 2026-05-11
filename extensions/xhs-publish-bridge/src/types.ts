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
    };

export type FillResult = {
  ok: boolean;
  /** 已写入的字段 */
  filled?: { title?: boolean; body?: boolean; image_upload?: boolean };
  /** 调试信息 */
  detail?: string;
};
