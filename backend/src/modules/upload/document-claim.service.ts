import type { PrismaClient } from "@prisma/client";

export interface ClaimDocumentInput {
  id: string;
  contentHash: string;
  fileName: string;
  fileType: string;
}

type ClaimedDocument = {
  id: string;
  contentHash: string;
  status: string;
};

export type ClaimDocumentResult = {
  document: ClaimedDocument;
  action: "created" | "ready" | "processing" | "retry";
};

function actionForStatus(status: string): ClaimDocumentResult["action"] {
  if (status === "ready") return "ready";
  if (status === "failed") return "retry";
  return "processing";
}

export async function claimDocument(
  prisma: PrismaClient,
  input: ClaimDocumentInput,
): Promise<ClaimDocumentResult> {
  const existing = await prisma.document.findUnique({
    where: { contentHash: input.contentHash },
    select: { id: true, contentHash: true, status: true },
  });
  if (existing) {
    if (existing.status === "failed") {
      const document = await prisma.$transaction(async (tx) => {
        await tx.chunkEmbedding.deleteMany({ where: { documentId: existing.id } });
        await tx.chunkContext.deleteMany({ where: { documentId: existing.id } });
        await tx.chunk.deleteMany({ where: { documentId: existing.id } });
        await tx.documentSection.deleteMany({ where: { documentId: existing.id } });
        return tx.document.update({
          where: { id: existing.id },
          data: {
            fileName: input.fileName,
            fileType: input.fileType,
            status: "processing",
          },
          select: { id: true, contentHash: true, status: true },
        });
      });
      return { document, action: "retry" };
    }
    return { document: existing, action: actionForStatus(existing.status) };
  }

  try {
    const document = await prisma.document.create({
      data: {
        id: input.id,
        contentHash: input.contentHash,
        fileName: input.fileName,
        fileType: input.fileType,
        status: "processing",
      },
      select: { id: true, contentHash: true, status: true },
    });
    return { document, action: "created" };
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") {
      throw error;
    }
    const document = await prisma.document.findUnique({
      where: { contentHash: input.contentHash },
      select: { id: true, contentHash: true, status: true },
    });
    if (!document) throw error;
    return { document, action: actionForStatus(document.status) };
  }
}
