import { create } from "zustand";

export interface VisualReference {
  documentId: string;
  pageNumber: number;
  regionIds: string[];
}

export interface PdfViewerState {
  currentDocumentId?: string;
  currentPage: number;
  scale: number;
  activeReference?: VisualReference;
  setActiveReference: (reference?: VisualReference) => void;
  setCurrentPage: (page: number) => void;
  setScale: (scale: number) => void;
}

export const usePdfViewerStore = create<PdfViewerState>((set) => ({
  currentDocumentId: undefined,
  currentPage: 1,
  scale: 1,
  activeReference: undefined,
  setActiveReference(reference) {
    set({ activeReference: reference });
  },
  setCurrentPage(page) {
    set({ currentPage: page });
  },
  setScale(scale) {
    set({ scale });
  },
}));

