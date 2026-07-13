export interface PlainTextPage {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
}

export async function extractTextPagesFromPlainText(filePath: string): Promise<{ pages: PlainTextPage[] }> {
  const { readFile } = await import("fs/promises");
  const raw = await readFile(filePath, "utf8");
  const blocks = raw
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const pages = (blocks.length ? blocks : [raw.trim()]).filter(Boolean).map((text, index) => ({
    pageNumber: index + 1,
    width: 612,
    height: 792,
    text,
  }));

  return { pages };
}

export async function extractTextPagesFromHtml(filePath: string): Promise<{ pages: PlainTextPage[] }> {
  const { readFile } = await import("fs/promises");
  const raw = await readFile(filePath, "utf8");
  const normalized = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r\n/g, "\n");

  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

  const pages = (blocks.length ? blocks : [normalized.trim()]).filter(Boolean).map((text, index) => ({
    pageNumber: index + 1,
    width: 612,
    height: 792,
    text,
  }));

  return { pages };
}
