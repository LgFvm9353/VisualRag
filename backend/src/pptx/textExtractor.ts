import JSZip from "jszip";
import { readFile } from "fs/promises";

export interface PptxSlideTextPage {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
}

function stripXml(value: string) {
  return value
    .replace(/<a:tab\/>/g, "\t")
    .replace(/<a:br\s*\/>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSlideText(xml: string) {
  const textNodes = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
    .map((match) => stripXml(match[1] ?? ""))
    .filter(Boolean);

  if (textNodes.length > 0) {
    return textNodes.join("\n");
  }

  return stripXml(xml);
}

function parseSlideOrder(path: string) {
  const match = path.match(/slide(\d+)\.xml$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export async function extractTextPagesFromPptx(filePath: string): Promise<{ pages: PptxSlideTextPage[] }> {
  const raw = await readFile(filePath);
  const zip = await JSZip.loadAsync(raw);

  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => parseSlideOrder(a) - parseSlideOrder(b));

  const pages: PptxSlideTextPage[] = [];

  for (let index = 0; index < slidePaths.length; index++) {
    const slidePath = slidePaths[index];
    const file = zip.file(slidePath);
    if (!file) continue;
    const xml = await file.async("string");
    const text = extractSlideText(xml);
    if (!text) continue;
    pages.push({
      pageNumber: index + 1,
      width: 1280,
      height: 720,
      text,
    });
  }

  return { pages };
}
