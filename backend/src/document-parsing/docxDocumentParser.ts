import mammoth from "mammoth";
import type { DocumentBlock, DocumentParser, ParsedDocument } from "./types.js";

function decodeText(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function blocksFromHtml(html: string): DocumentBlock[] {
  const entries: Array<{ text: string; headingLevel?: number }> = [];
  const tags = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    const text = decodeText(match[2]);
    if (!text) continue;
    const heading = /^h([1-6])$/i.exec(match[1]);
    entries.push({ text, ...(heading ? { headingLevel: Number(heading[1]) } : {}) });
  }

  const headingStack: Array<{ level: number; id: string; text: string }> = [];
  return entries.map((entry, paragraphIndex) => {
    if (entry.headingLevel !== undefined) {
      while (headingStack.at(-1)?.level! >= entry.headingLevel) headingStack.pop();
    }
    const id = `docx-block-${paragraphIndex}`;
    const parent = headingStack.at(-1);
    const sectionPath = headingStack.map((heading) => heading.text);
    const block: DocumentBlock = {
      id,
      kind: entry.headingLevel === undefined ? "paragraph" : "heading",
      text: entry.text,
      locator: { paragraphIndex, blockIndex: paragraphIndex, sectionPath },
      ...(entry.headingLevel === undefined ? {} : { headingLevel: entry.headingLevel }),
      ...(parent ? { parentBlockId: parent.id } : {}),
    };
    if (entry.headingLevel !== undefined) headingStack.push({ level: entry.headingLevel, id, text: entry.text });
    return block;
  });
}

export class DocxDocumentParser implements DocumentParser {
  readonly id = "docx";
  readonly mediaTypes = ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

  async parse({ filePath }: { filePath: string; documentId: string }): Promise<ParsedDocument> {
    const result = await mammoth.convertToHtml({ path: filePath });
    let blocks = blocksFromHtml(result.value);
    if (blocks.length === 0) {
      const raw = await mammoth.extractRawText({ path: filePath });
      const text = raw.value.trim();
      if (text) {
        blocks = [{
          id: "docx-block-0",
          kind: "paragraph",
          text,
          locator: { paragraphIndex: 0, blockIndex: 0, sectionPath: [] },
        }];
      }
    }
    if (blocks.length === 0) {
      throw new Error("document_parse_empty: docx has no usable HTML or raw text");
    }
    return {
      blocks,
      warnings: result.messages.filter((message) => message.type === "warning").map((message) => ({ code: "parser_warning", message: message.message })),
      artifacts: { html: result.value },
      metadata: { title: blocks.find((block) => block.headingLevel === 1)?.text ?? null, paragraphCount: blocks.length },
    };
  }
}
