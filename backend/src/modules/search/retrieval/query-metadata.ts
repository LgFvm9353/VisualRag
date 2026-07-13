export type KnowledgeBaseFileType = "pdf" | "docx" | "pptx" | "text" | "html";

export interface QueryMetadataFilters {
  publishedYear: number | null;
  fileTypes: KnowledgeBaseFileType[];
  tags: string[];
  residualQuery: string;
}

const FILE_TYPE_KEYWORDS: ReadonlyArray<readonly [string, KnowledgeBaseFileType]> = [
  ["pdf", "pdf"],
  ["word", "docx"],
  ["docx", "docx"],
  ["pptx", "pptx"],
  ["ppt", "pptx"],
  ["markdown", "text"],
  ["md", "text"],
  ["txt", "text"],
  ["html", "html"],
];

export function extractQueryMetadata(query: string): QueryMetadataFilters {
  const yearMatch = query.match(/(20\d{2})\s*年/);
  const lowerQuery = query.toLowerCase();
  const fileTypes = FILE_TYPE_KEYWORDS.flatMap(([keyword, type]) =>
    lowerQuery.includes(keyword) ? [type] : [],
  );
  const residualQuery = query
    .replace(/20\d{2}\s*年/g, "")
    .replace(/pdf|word|docx|pptx|ppt|markdown|md|txt|html/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    publishedYear: yearMatch ? Number(yearMatch[1]) : null,
    fileTypes: [...new Set(fileTypes)],
    tags: [],
    residualQuery,
  };
}
