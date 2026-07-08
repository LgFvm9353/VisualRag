import mammoth from "mammoth";
import { randomUUID } from "crypto";

// ---- 输出类型 ----

export interface DocxParagraph {
  /** 段落序号（0-based） */
  index: number;
  /** 段落纯文本 */
  content: string;
  /** 标题级别 (1-6)，正文为 null */
  headingLevel: number | null;
  /** 标题文本，正文为 null */
  title: string | null;
  /** 父级标题段落的序号（最近祖先标题），正文为 null */
  parentIndex: number | null;
}

export interface DocxExtractionResult {
  paragraphs: DocxParagraph[];
  /** 供前端查看器渲染的完整 HTML */
  html: string;
  metadata: {
    title: string | null;
    paragraphCount: number;
  };
}

/** 兼容管道的 textPages 格式 */
export interface DocxTextPage {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
}

// ---- 内部辅助 ----

/**
 * 从 mammoth HTML 输出中解析标题层级。
 *
 * mammoth 将 Word 标题映射为标准 HTML 标签（h1-h6），
 * 正文段落为 <p>。我们通过正则提取标签名来确定 headingLevel。
 */
function parseParagraphsFromHtml(html: string): {
  paragraphs: Array<{
    index: number;
    content: string;
    tag: string;
    headingLevel: number | null;
  }>;
  title: string | null;
} {
  const paragraphs: Array<{
    index: number;
    content: string;
    tag: string;
    headingLevel: number | null;
  }> = [];

  let title: string | null = null;

  // 匹配 <h1>-<h6> 和 <p> 标签的内容
  // 使用 [\s\S] 匹配包括换行的所有字符
  const tagRegex =
    /<(h[1-6]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  let match: RegExpExecArray | null;
  let index = 0;
  const headingRegex = /^h([1-6])$/i;

  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const innerHtml = match[2];

    // 提取纯文本（去除内嵌标签）
    const content = stripHtmlTags(innerHtml).trim();
    if (!content) continue;

    const headingMatch = headingRegex.exec(tag);
    const headingLevel = headingMatch ? parseInt(headingMatch[1], 10) : null;

    paragraphs.push({
      index,
      content,
      tag,
      headingLevel,
    });

    // 第一个 h1 作为文档标题
    if (title === null && headingLevel === 1) {
      title = content;
    }

    index++;
  }

  return { paragraphs, title };
}

/** 去除 HTML 标签，保留纯文本 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 计算每个段落的 parentIndex（最近祖先标题的序号）。
 *
 * 规则：遍历段落时维护一个标题栈。
 * 当遇到标题时，弹出栈中所有 >= 当前层级的标题，然后将当前标题入栈。
 * 后续段落的 parentIndex 指向栈顶标题。
 */
function computeParentIndices(
  paragraphs: Array<{
    index: number;
    headingLevel: number | null;
  }>,
): (number | null)[] {
  // 标题栈：栈顶是当前作用域内最近的标题
  const stack: Array<{ index: number; level: number }> = [];
  const result: (number | null)[] = [];

  for (const p of paragraphs) {
    result.push(stack.length > 0 ? stack[stack.length - 1].index : null);

    if (p.headingLevel !== null) {
      // 弹出所有 >= 当前层级的标题
      while (
        stack.length > 0 &&
        stack[stack.length - 1].level >= p.headingLevel
      ) {
        stack.pop();
      }
      // 当前标题入栈
      stack.push({ index: p.index, level: p.headingLevel });
    }
  }

  return result;
}

// ---- 公开 API ----

/**
 * 解析 .docx 文件，提取结构化文本和 HTML。
 *
 * @param filePath - .docx 文件的磁盘路径
 * @returns DocxExtractionResult 包含段落列表、HTML 和元数据
 */
export async function extractTextFromDocx(
  filePath: string,
): Promise<DocxExtractionResult> {
  // 并行：纯文本 + HTML
  const [rawResult, htmlResult] = await Promise.all([
    mammoth.extractRawText({ path: filePath }),
    mammoth.convertToHtml({ path: filePath }),
  ]);

  // 打印 mammoth 警告/信息消息（非致命）
  for (const msg of rawResult.messages) {
    if (msg.type === "warning") {
      console.warn(`[docx] mammoth rawText warning:`, msg.message);
    }
  }
  for (const msg of htmlResult.messages) {
    if (msg.type === "warning") {
      console.warn(`[docx] mammoth html warning:`, msg.message);
    }
  }

  const html = htmlResult.value;
  const { paragraphs: parsedParagraphs, title } =
    parseParagraphsFromHtml(html);

  // 如果 HTML 解析没有得到段落，回退到纯文本按行分割
  if (parsedParagraphs.length === 0) {
    const lines = rawResult.value
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);

    const fallbackParagraphs: DocxParagraph[] = lines.map(
      (content, index) => ({
        index,
        content,
        headingLevel: null,
        title: null,
        parentIndex: null,
      }),
    );

    return {
      paragraphs: fallbackParagraphs,
      html,
      metadata: {
        title: null,
        paragraphCount: fallbackParagraphs.length,
      },
    };
  }

  // 计算 parentIndex
  const parentIndices = computeParentIndices(parsedParagraphs);

  const paragraphs: DocxParagraph[] = parsedParagraphs.map((p, i) => ({
    index: p.index,
    content: p.content,
    headingLevel: p.headingLevel,
    title: p.headingLevel !== null ? p.content : null,
    parentIndex: parentIndices[i],
  }));

  return {
    paragraphs,
    html,
    metadata: {
      title,
      paragraphCount: paragraphs.length,
    },
  };
}

/**
 * 将 DocxParagraph[] 转换为管道兼容的 textPages 格式。
 * 每个段落映射为一个 "page" 条目。
 */
export function toTextPages(paragraphs: DocxParagraph[]): DocxTextPage[] {
  return paragraphs.map((p) => ({
    pageNumber: p.index + 1, // 1-based，与 PDF 页码保持一致
    width: 0,
    height: 0,
    text: p.content,
  }));
}
