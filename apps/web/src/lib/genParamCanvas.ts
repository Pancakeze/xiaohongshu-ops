export type TitleAlign = 'left' | 'center' | 'right'
export type ContentVAlign = 'top' | 'middle'

export type PlaceholderStyle = {
  bgColor: string
  titleAlign: TitleAlign
  contentVAlign: ContentVAlign
  fontFamily: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  textColor: string
}

export const DEFAULT_PLACEHOLDER_STYLE: PlaceholderStyle = {
  bgColor: 'gradient-default',
  titleAlign: 'left',
  contentVAlign: 'top',
  fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 36,
  fontWeight: 'normal',
  textColor: '#0f172a',
}

export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', label: '系统默认' },
  { value: '"PingFang SC", "Microsoft YaHei", sans-serif', label: '苹方 / 雅黑' },
  { value: 'SimHei, STHeiti, sans-serif', label: '黑体' },
  { value: 'SimSun, STSong, serif', label: '宋体' },
  { value: 'KaiTi, STKaiti, serif', label: '楷体' },
  { value: 'Georgia, "Times New Roman", serif', label: '衬线' },
]

export const FONT_SIZES = [28, 32, 36, 42, 48, 56, 64] as const

const CANVAS_SIZE = 1080
const CANVAS_PAD = 64

function isDarkHexColor(hex: string): boolean {
  const c = hex.replace('#', '')
  if (c.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(c)) return false
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b < 140
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function plainTextToGenParamHtml(text: string): string {
  if (!text.trim()) return '<p><br></p>'
  return text
    .split('\n')
    .map((line) => `<p>${line ? escapeHtml(line) : '<br>'}</p>`)
    .join('')
}

export function normalizeGenParamContent(stored: string): string {
  const trimmed = stored.trim()
  if (!trimmed) return '<p><br></p>'
  if (/<[a-z][\s\S]*>/i.test(trimmed)) return stored
  return plainTextToGenParamHtml(stored)
}

export function isGenParamHtmlEmpty(html: string): boolean {
  const stripped = html
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u200B/g, '')
    .trim()
  return !stripped
}

function sanitizeGenParamHtml(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  tpl.content.querySelectorAll('script, iframe, object, embed, img').forEach((el) => el.remove())
  return tpl.innerHTML
}

function htmlToPlainText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = sanitizeGenParamHtml(html)
  const text = (div.innerText || div.textContent || '').replace(/\u200B/g, '').trim()
  return text || '（无生图参数）'
}

function fillPlaceholderBackground(ctx: CanvasRenderingContext2D, bgColor: string, size: number) {
  if (bgColor === 'gradient-default') {
    const g = ctx.createLinearGradient(0, 0, size, size)
    g.addColorStop(0, '#fce7f3')
    g.addColorStop(0.45, '#fff7ed')
    g.addColorStop(1, '#e0f2fe')
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = bgColor
  }
  ctx.fillRect(0, 0, size, size)
}

function wrapCanvasLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const chars = [...text]
  if (!chars.length) return []
  const lines: string[] = []
  let line = ''
  for (const ch of chars) {
    const next = line + ch
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = ch
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawAlignedLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  yStart: number,
  lineHeight: number,
  align: TitleAlign,
  size: number,
) {
  const pad = (CANVAS_PAD * size) / CANVAS_SIZE
  const x = align === 'left' ? pad : align === 'right' ? size - pad : size / 2
  ctx.textAlign = align
  lines.forEach((line, i) => {
    ctx.fillText(line, x, yStart + i * lineHeight)
  })
}

function layoutPlainText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  style: PlaceholderStyle,
  scale: number,
): { lines: string[]; fontSize: number; lineHeight: number } {
  const minFont = 18 * scale
  let fontSize = style.fontSize * scale

  while (fontSize >= minFont) {
    ctx.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`
    const lineHeight = fontSize * 1.45
    const lines: string[] = []
    for (const paragraph of text.split('\n')) {
      if (!paragraph) {
        lines.push('')
        continue
      }
      lines.push(...wrapCanvasLines(ctx, paragraph, maxWidth))
    }
    if (!lines.length) lines.push('')
    if (lines.length * lineHeight <= maxHeight) {
      return { lines, fontSize, lineHeight }
    }
    fontSize -= 2 * scale
  }

  ctx.font = `${style.fontWeight} ${minFont}px ${style.fontFamily}`
  const lineHeight = minFont * 1.45
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    lines.push(...wrapCanvasLines(ctx, paragraph, maxWidth))
  }
  if (!lines.length) lines.push('')
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight))
  return { lines: lines.slice(0, maxLines), fontSize: minFont, lineHeight }
}

function renderPlainTextFallback(
  ctx: CanvasRenderingContext2D,
  size: number,
  html: string,
  style: PlaceholderStyle,
) {
  const scale = size / CANVAS_SIZE
  const pad = CANVAS_PAD * scale
  const maxTextWidth = size - pad * 2
  const maxTextHeight = size - pad * 2
  const darkBg = style.bgColor !== 'gradient-default' && isDarkHexColor(style.bgColor)
  const textColor = style.textColor || (darkBg ? '#f8fafc' : '#0f172a')
  const content = htmlToPlainText(html)

  fillPlaceholderBackground(ctx, style.bgColor, size)

  ctx.fillStyle = textColor
  const { lines, fontSize, lineHeight } = layoutPlainText(
    ctx,
    content,
    maxTextWidth,
    maxTextHeight,
    style,
    scale,
  )
  ctx.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`
  const totalHeight = lines.length * lineHeight
  const yStart =
    style.contentVAlign === 'middle'
      ? (size - totalHeight) / 2 + fontSize * 0.85
      : pad + fontSize * 0.85
  drawAlignedLines(ctx, lines, yStart, lineHeight, style.titleAlign, size)
}

function svgBackground(style: PlaceholderStyle, size: number): string {
  if (style.bgColor === 'gradient-default') {
    return `<defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fce7f3"/>
        <stop offset="45%" stop-color="#fff7ed"/>
        <stop offset="100%" stop-color="#e0f2fe"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bgGrad)"/>`
  }
  return `<rect width="${size}" height="${size}" fill="${escapeHtml(style.bgColor)}"/>`
}

function buildForeignObjectNode(html: string, style: PlaceholderStyle, size: number): string {
  const scale = size / CANVAS_SIZE
  const pad = CANVAS_PAD * scale
  const darkBg = style.bgColor !== 'gradient-default' && isDarkHexColor(style.bgColor)
  const defaultColor = style.textColor || (darkBg ? '#f8fafc' : '#0f172a')
  const fontSize = style.fontSize * scale
  const justifyContent = style.contentVAlign === 'middle' ? 'center' : 'flex-start'
  const content = isGenParamHtmlEmpty(html) ? '<p>（无生图参数）</p>' : sanitizeGenParamHtml(html)

  const root = document.createElement('div')
  root.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  root.setAttribute(
    'style',
    [
      `width:${size}px`,
      `height:${size}px`,
      'display:flex',
      'flex-direction:column',
      `justify-content:${justifyContent}`,
      `padding:${pad}px`,
      'box-sizing:border-box',
      `font-family:${style.fontFamily}`,
      `font-size:${fontSize}px`,
      `font-weight:${style.fontWeight}`,
      `color:${defaultColor}`,
      `text-align:${style.titleAlign}`,
      'word-break:break-word',
      'overflow:hidden',
      'line-height:1.45',
    ].join(';'),
  )

  const inner = document.createElement('div')
  inner.setAttribute('style', 'width:100%;')
  inner.innerHTML = content
  root.appendChild(inner)

  return new XMLSerializer().serializeToString(root)
}

function buildRichTextSvg(html: string, style: PlaceholderStyle, size: number): string {
  const body = buildForeignObjectNode(html, style, size)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    ${svgBackground(style, size)}
    <foreignObject x="0" y="0" width="${size}" height="${size}">${body}</foreignObject>
  </svg>`
}

function drawSvgToCanvas(
  ctx: CanvasRenderingContext2D,
  svg: string,
  size: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      ctx.clearRect(0, 0, size, size)
      ctx.drawImage(img, 0, 0, size, size)
      resolve()
    }
    img.onerror = () => reject(new Error('svg_render_failed'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

export async function renderGenParamCanvas(
  ctx: CanvasRenderingContext2D,
  size: number,
  html: string,
  style: PlaceholderStyle,
): Promise<void> {
  try {
    const svg = buildRichTextSvg(html, style, size)
    await drawSvgToCanvas(ctx, svg, size)
  } catch {
    renderPlainTextFallback(ctx, size, html, style)
  }
}

export async function genParamPreviewDataUrl(
  html: string,
  style: PlaceholderStyle,
  previewSize = 240,
): Promise<string> {
  const c = document.createElement('canvas')
  c.width = previewSize
  c.height = previewSize
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('canvas unsupported')
  await renderGenParamCanvas(ctx, previewSize, html, style)
  return c.toDataURL('image/png')
}

export async function genParamPngFile(html: string, style: PlaceholderStyle): Promise<File> {
  const c = document.createElement('canvas')
  c.width = CANVAS_SIZE
  c.height = CANVAS_SIZE
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('canvas unsupported')
  await renderGenParamCanvas(ctx, CANVAS_SIZE, html, style)
  const blob = await new Promise<Blob>((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new File([blob], `xhs-gen-${Date.now()}.png`, { type: 'image/png' })
}

export function mergePlaceholderStyle(raw: Partial<PlaceholderStyle> | null | undefined): PlaceholderStyle {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLACEHOLDER_STYLE }
  return {
    bgColor: typeof raw.bgColor === 'string' ? raw.bgColor : DEFAULT_PLACEHOLDER_STYLE.bgColor,
    titleAlign:
      raw.titleAlign === 'center' || raw.titleAlign === 'right' || raw.titleAlign === 'left'
        ? raw.titleAlign
        : DEFAULT_PLACEHOLDER_STYLE.titleAlign,
    contentVAlign:
      raw.contentVAlign === 'middle' || raw.contentVAlign === 'top'
        ? raw.contentVAlign
        : DEFAULT_PLACEHOLDER_STYLE.contentVAlign,
    fontFamily: typeof raw.fontFamily === 'string' ? raw.fontFamily : DEFAULT_PLACEHOLDER_STYLE.fontFamily,
    fontSize: typeof raw.fontSize === 'number' && raw.fontSize > 0 ? raw.fontSize : DEFAULT_PLACEHOLDER_STYLE.fontSize,
    fontWeight: raw.fontWeight === 'bold' ? 'bold' : DEFAULT_PLACEHOLDER_STYLE.fontWeight,
    textColor: typeof raw.textColor === 'string' ? raw.textColor : DEFAULT_PLACEHOLDER_STYLE.textColor,
  }
}
