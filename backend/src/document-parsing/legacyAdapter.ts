import type { LayoutPage } from "../pipeline/types.js";
import type { DocxParagraph } from "../docx/textExtractor.js";
import type { ParsedDocument } from "./types.js";

export function toLegacyTextPages(document: ParsedDocument) {
  const pageDimensions = new Map(
    (document.artifacts.layout ?? []).map((page) => [page.pageNumber, page]),
  );
  return document.blocks.map((block, index) => {
    const pageNumber = block.locator.pageNumber;
    const dimensions = pageNumber === undefined ? undefined : pageDimensions.get(pageNumber);
    return {
      pageNumber: pageNumber ?? index + 1,
      width: dimensions?.width ?? 0,
      height: dimensions?.height ?? 0,
      text: block.text,
    };
  });
}

export function toLegacyLayoutPages(document: ParsedDocument, documentId: string): LayoutPage[] {
  return (document.artifacts.layout ?? []).map((page) => ({
    ...page,
    regions: page.regions.map((region) => ({ ...region, documentId })),
  }));
}

export function toLegacyDocxParagraphs(document: ParsedDocument): DocxParagraph[] {
  const indexById = new Map(document.blocks.map((block, index) => [block.id, index]));
  return document.blocks.map((block, index) => ({
    index,
    content: block.text,
    headingLevel: block.headingLevel ?? null,
    title: block.headingLevel === undefined ? null : block.text,
    parentIndex: block.parentBlockId === undefined ? null : indexById.get(block.parentBlockId) ?? null,
  }));
}
