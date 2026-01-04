'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import io, { type Socket } from "socket.io-client";
import { PdfViewer, type PdfPageMetadata } from "@/components/PdfViewer";
import type { VisualRegion as ViewerRegion } from "@/components/HighlightOverlay";
import { usePdfViewerStore } from "@/store/pdfViewerStore";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";

interface IngestionProgressEvent {
  taskId: string;
  stage:
    | "queued"
    | "extracting_text"
    | "layout_analysis"
    | "generating_text_embeddings"
    | "generating_image_embeddings"
    | "writing_database"
    | "completed"
    | "failed";
  progress: number;
  message?: string;
}

interface UploadResponse {
  taskId: string;
}

interface LayoutRegion {
  id: string;
  pageNumber: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
}

interface LayoutPage {
  pageNumber: number;
  width: number;
  height: number;
  regions: LayoutRegion[];
}

interface LayoutResponse {
  taskId: string;
  pages: LayoutPage[];
}

interface DocumentRegionsPage {
  pageNumber: number;
  width: number;
  height: number;
  regions: {
    id: string;
    pageNumber: number;
    type: string;
    bbox: {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    };
  }[];
}

interface DocumentRegionsResponse {
  documentId: string;
  pages: DocumentRegionsPage[];
}

interface SearchResultItem {
  documentId: string;
  pageNumber: number;
  snippet: string;
  regionIds: string[];
}

interface SearchResponse {
  documentId: string;
  query: string;
  results: SearchResultItem[];
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: {
    pageNumber: number;
    regionIds: string[];
  }[];
}

interface ChatEventPayload {
  type: "token" | "done" | "error";
  token?: string;
  citations?: {
    pageNumber: number;
    regionIds: string[];
  }[];
  message?: string;
}

interface UploadInitResponseFast {
  fast: true;
  taskId: string;
}

interface UploadInitResponseNormal {
  fast: false;
  uploadId: string;
  uploadedChunks: number[];
  chunkSize: number;
  totalChunks: number;
}

type UploadInitResponse = UploadInitResponseFast | UploadInitResponseNormal;

const backendUrl =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

async function computeFileHash(file: File): Promise<string | null> {
  const w = globalThis as any;
  const subtle = w.crypto?.subtle;
  if (!subtle) {
    return null;
  }
  const buffer = await file.arrayBuffer();
  const digest = await subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

async function uploadFileLegacy(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${backendUrl}/upload`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    throw new Error("upload_failed");
  }
  const data = (await res.json()) as UploadResponse;
  return data.taskId;
}

async function uploadFileWithResume(file: File): Promise<string> {
  const hash = await computeFileHash(file);
  if (!hash) {
    return uploadFileLegacy(file);
  }
  const storageKey = `visualrag_upload_${hash}`;
  let existingUploadId: string | undefined;
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored) as { uploadId?: string };
      if (parsed.uploadId) {
        existingUploadId = parsed.uploadId;
      }
    }
  } catch {
  }
  const defaultChunkSize = 5 * 1024 * 1024;
  const initRes = await fetch(`${backendUrl}/upload/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      hash,
      chunkSize: defaultChunkSize,
      existingUploadId,
    }),
  });
  if (!initRes.ok) {
    return uploadFileLegacy(file);
  }
  const initData = (await initRes.json()) as UploadInitResponse;
  if (initData.fast) {
    return initData.taskId;
  }
  const uploadId = initData.uploadId;
  try {
    globalThis.localStorage?.setItem(
      storageKey,
      JSON.stringify({ uploadId })
    );
  } catch {
  }
  const uploadedSet = new Set(initData.uploadedChunks);
  const totalChunks = initData.totalChunks;
  const chunkSize = initData.chunkSize || defaultChunkSize;
  for (let index = 0; index < totalChunks; index++) {
    if (uploadedSet.has(index)) {
      continue;
    }
    const start = index * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const chunk = file.slice(start, end);
    const res = await fetch(
      `${backendUrl}/upload/chunk?uploadId=${encodeURIComponent(
        uploadId
      )}&index=${index}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        body: chunk,
      }
    );
    if (!res.ok) {
      throw new Error("upload_chunk_failed");
    }
  }
  const completeRes = await fetch(`${backendUrl}/upload/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uploadId }),
  });
  if (!completeRes.ok) {
    throw new Error("upload_complete_failed");
  }
  const completeData = (await completeRes.json()) as UploadResponse;
  try {
    globalThis.localStorage?.removeItem(storageKey);
  } catch {
  }
  return completeData.taskId;
}

export default function HomePage() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<IngestionProgressEvent | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pages, setPages] = useState<PdfPageMetadata[]>([]);
  const [regionsByPage, setRegionsByPage] = useState<Record<number, ViewerRegion[]>>({});
  const [viewerDocumentId, setViewerDocumentId] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const recognitionRef = useRef<any | null>(null);
  const mainUploadInputRef = useRef<HTMLInputElement | null>(null);
  const renderTasksRef = useRef<Record<number, any>>({});
  const pageRenderQueueRef = useRef<Record<number, Promise<void>>>({});

  const renderPdfPage = useCallback(
    (page: PdfPageMetadata, canvasRef: { current: HTMLCanvasElement | null }) => {
      const run = async () => {
        const pdfDoc = pdfDocRef.current;
        const canvas = canvasRef.current;
        if (!pdfDoc || !canvas) return;

        let pageObj: any;
        try {
          pageObj = await pdfDoc.getPage(page.pageNumber);
        } catch (err: any) {
          const msg = String(err?.message || "");
          if (msg.includes("RenderingCancelledException")) {
            return;
          }
          throw err;
        }

        const baseViewport = pageObj.getViewport({ scale: 1 });
        const scale = page.width / baseViewport.width;
        const viewport = pageObj.getViewport({ scale });
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        ctx.clearRect(0, 0, viewport.width, viewport.height);

        let renderTask: any;
        try {
          renderTask = pageObj.render({
            canvasContext: ctx,
            viewport,
          } as any);
        } catch (err: any) {
          const msg = String(err?.message || "");
          if (msg.includes("Cannot use the same canvas during multiple render() operations")) {
            return;
          }
          throw err;
        }

        renderTasksRef.current[page.pageNumber] = renderTask;

        try {
          await renderTask.promise;
        } catch (err: any) {
          const msg = String(err?.message || "");
          if (
            msg.includes("RenderingCancelledException") ||
            msg.includes("Cannot use the same canvas during multiple render() operations")
          ) {
            return;
          }
          throw err;
        }
      };

      const prev = pageRenderQueueRef.current[page.pageNumber] || Promise.resolve();

      const next = prev
        .catch((err: any) => {
          const msg = String(err?.message || "");
          if (
            msg.includes("RenderingCancelledException") ||
            msg.includes("Cannot use the same canvas during multiple render() operations")
          ) {
            return;
          }
          throw err;
        })
        .then(run);

      pageRenderQueueRef.current[page.pageNumber] = next;
      return next;
    },
    []
  );

  const setActiveReference = usePdfViewerStore((s) => s.setActiveReference);

  useEffect(() => {
    const s = io(backendUrl);
    setSocket(s);
    return () => {
      s.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const handler = (event: IngestionProgressEvent) => {
      setProgress(event);
    };
    socket.on("ingestion:progress", handler);
    return () => {
      socket.off("ingestion:progress", handler);
    };
  }, [socket]);

  useEffect(() => {
    const w = globalThis as any;
    const Rec = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Rec) {
      setSpeechSupported(false);
      return;
    }
    const instance = new Rec();
    instance.lang = "zh-CN";
    instance.interimResults = false;
    instance.maxAlternatives = 1;
    instance.onresult = (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) {
        return;
      }
      const firstResult = results[0];
      if (!firstResult || firstResult.length === 0) {
        return;
      }
      const transcript = String(firstResult[0].transcript || "");
      if (!transcript.trim()) {
        return;
      }
      setChatInput((prev) =>
        prev && prev.trim().length > 0
          ? `${prev.trim()}\n${transcript}`
          : transcript
      );
    };
    instance.onerror = () => {
      setRecognizing(false);
    };
    instance.onend = () => {
      setRecognizing(false);
    };
    recognitionRef.current = instance;
    setSpeechSupported(true);
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
        }
      }
      recognitionRef.current = null;
    };
  }, []);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setProgress(null);
    setUploadError(null);
    try {
      const taskId = await uploadFileWithResume(file);
      setCurrentTaskId(taskId);
      setViewerDocumentId(taskId);
      setPdfUrl(`${backendUrl}/files/${taskId}`);
      setSearchResults([]);
      if (socket) {
        socket.emit("join-task", taskId);
      }
    } catch (error) {
      console.error("Upload error", error);
      const message =
        error instanceof Error && error.message
          ? error.message
          : "上传失败，请检查网络或后端服务。";
      setUploadError(message);
    } finally {
      setUploading(false);
    }
  };

  const handleChatSubmit = () => {
    if (!viewerDocumentId) return;
    setChatError(null);
    const q = chatInput.trim();
    if (!q) return;
    if (chatStreaming) return;
    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      role: "user",
      content: q,
    };
    const assistantId = `${Date.now()}-assistant`;
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
    };
    setChatMessages((prev) => [...prev, userMessage, assistantMessage]);
    setChatInput("");
    setChatStreaming(true);
    const url = new URL(`${backendUrl}/chat/stream`);
    url.searchParams.set("documentId", viewerDocumentId);
    url.searchParams.set("q", q);
    const es = new EventSource(url.toString());
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ChatEventPayload;
        if (data.type === "token" && data.token) {
          setChatMessages((prev) => {
            const next = [...prev];
            const index = next.findIndex((m) => m.id === assistantId);
            if (index === -1) {
              return prev;
            }
            next[index] = {
              ...next[index],
              content: next[index].content + data.token,
            };
            return next;
          });
        }
        if (data.type === "done") {
          if (data.citations && data.citations.length > 0 && viewerDocumentId) {
            const first = data.citations[0];
            setActiveReference({
              documentId: viewerDocumentId,
              pageNumber: first.pageNumber,
              regionIds: first.regionIds,
            });
          }
          if (data.citations && data.citations.length > 0) {
            setChatMessages((prev) => {
              const next = [...prev];
              const index = next.findIndex((m) => m.id === assistantId);
              if (index === -1) {
                return prev;
              }
              next[index] = {
                ...next[index],
                citations: data.citations,
              };
              return next;
            });
          }
          setChatStreaming(false);
          es.close();
          return;
        }
        if (data.type === "error") {
          setChatMessages((prev) => {
            const next = [...prev];
            const index = next.findIndex((m) => m.id === assistantId);
            if (index === -1) {
              return prev;
            }
            if (next[index].content.trim().length === 0) {
              next[index] = {
                ...next[index],
                content:
                  data.message && data.message.trim().length > 0
                    ? `对话生成失败：${data.message}`
                    : "对话生成失败，请稍后重试或检查后端服务配置。",
              };
            }
            return next;
          });
          if (data.message && data.message.trim().length > 0) {
            setChatError(data.message);
          }
          setChatStreaming(false);
          es.close();
        }
      } catch {
        setChatMessages((prev) => {
          const next = [...prev];
          const index = next.findIndex((m) => m.id === assistantId);
          if (index === -1) {
            return prev;
          }
          if (next[index].content.trim().length === 0) {
            next[index] = {
              ...next[index],
              content: "对话流解析失败，请稍后重试。",
            };
          }
          return next;
        });
        setChatStreaming(false);
        es.close();
      }
    };
    es.onerror = () => {
      setChatMessages((prev) => {
        const next = [...prev];
        const index = next.findIndex((m) => m.id === assistantId);
        if (index === -1) {
          return prev;
        }
        if (next[index].content.trim().length === 0) {
          next[index] = {
            ...next[index],
            content: "对话连接中断，请检查网络或后端服务。",
          };
        }
        return next;
      });
      setChatStreaming(false);
      es.close();
    };
  };

  const handleResetChat = () => {
    setChatMessages([]);
    setChatInput("");
    setChatError(null);
  };

  const handleToggleVoiceInput = () => {
    if (!speechSupported) return;
    const rec = recognitionRef.current;
    if (!rec) return;
    if (recognizing) {
      try {
        rec.stop();
      } catch {
      }
      setRecognizing(false);
      return;
    }
    try {
      rec.start();
      setRecognizing(true);
    } catch {
    }
  };

  useEffect(() => {
    const el = chatListRef.current;
    if (!el) return;
    if (chatMessages.length === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages.length]);

  const handleSearch = async () => {
    if (!viewerDocumentId) return;
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const params = new URLSearchParams({ q: searchQuery.trim() });
      const res = await fetch(
        `${backendUrl}/documents/${viewerDocumentId}/search/semantic?${params.toString()}`
      );
      if (!res.ok) {
        const message =
          res.status === 404
            ? "未找到搜索结果，请确认文档是否已完成处理。"
            : "搜索失败，请稍后重试或检查后端服务。";
        setSearchResults([]);
        setSearchError(message);
        return;
      }
      const data = (await res.json()) as SearchResponse;
      setSearchResults(data.results);
      const first = data.results[0];
      if (first) {
        setActiveReference({
          documentId: first.documentId,
          pageNumber: first.pageNumber,
          regionIds: first.regionIds,
        });
      }
    } catch (error) {
      console.error("Search error", error);
      setSearchResults([]);
      setSearchError("搜索请求异常，请检查网络连接或后端服务。");
    } finally {
      setSearching(false);
    }
  };


  useEffect(() => {
    const loadLayout = async (taskId: string) => {
      const res = await fetch(`${backendUrl}/documents/${taskId}/regions`);
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as DocumentRegionsResponse;
      const nextPages: PdfPageMetadata[] = data.pages.map((p) => ({
        pageNumber: p.pageNumber,
        width: p.width,
        height: p.height,
      }));
      const nextRegionsByPage: Record<number, ViewerRegion[]> = {};
      data.pages.forEach((p) => {
        nextRegionsByPage[p.pageNumber] = p.regions.map((r) => ({
          id: r.id,
          type: r.type,
          bbox: r.bbox,
        }));
      });
      setPages(nextPages);
      setRegionsByPage(nextRegionsByPage);
    };
    if (!currentTaskId) return;
    if (!progress) return;
    const stage = progress.stage;
    const stageAfterLayout =
      stage === "layout_analysis" ||
      stage === "generating_text_embeddings" ||
      stage === "generating_image_embeddings" ||
      stage === "writing_database" ||
      stage === "completed";
    if (!stageAfterLayout) return;
    if (stage === "completed") {
      void loadLayout(currentTaskId);
      return;
    }
    if (pages.length === 0) {
      void loadLayout(currentTaskId);
    }
  }, [currentTaskId, progress, pages.length]);

  useEffect(() => {
    if (!pdfUrl) return;
    GlobalWorkerOptions.workerSrc =
      GlobalWorkerOptions.workerSrc ||
      "https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
    let cancelled = false;
    const load = async () => {
      const loadingTask = getDocument(pdfUrl);
      const doc = (await loadingTask.promise) as PDFDocumentProxy;
      if (cancelled) {
        await doc.destroy();
        return;
      }
      pdfDocRef.current = doc;
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  return (
    <main className="flex h-screen w-full flex-col overflow-hidden bg-slate-50 font-sans text-slate-900 lg:flex-row">
      <input
        ref={mainUploadInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void handleUpload(f);
          }
        }}
        disabled={uploading}
      />
      <section className="relative z-20 flex w-full flex-shrink-0 flex-col gap-5 border-r border-slate-200 bg-white p-6 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.05)] lg:w-[420px] xl:w-[460px]">
        <div className="flex items-center justify-between pb-2">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            VisualRAG <span className="text-indigo-600">Insight</span>
          </h1>
          <div className="flex items-center gap-2">
             <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500"></span>
            </span>
            <span className="text-xs font-medium text-slate-500">Active</span>
          </div>
        </div>

        <div className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/50 p-1 transition-all hover:border-indigo-200 hover:bg-slate-50 hover:shadow-md">
           <div
            className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white py-8 text-center transition-colors group-hover:border-indigo-300"
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file && file.type === "application/pdf") {
                void handleUpload(file);
              }
            }}
            onClick={() => {
              if (uploading) return;
              mainUploadInputRef.current?.click();
            }}
          >
            <div className="mb-3 rounded-full bg-indigo-50 p-3 text-indigo-600">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <button
              type="button"
              className="mb-1 text-sm font-semibold text-slate-900 hover:text-indigo-600"
              onClick={(e) => {
                e.stopPropagation();
                if (uploading) return;
                mainUploadInputRef.current?.click();
              }}
            >
              点击上传
            </button>
            <p className="text-xs text-slate-500">或将 PDF 文件拖拽至此处</p>
          </div>
          {uploadError && (
            <div className="mt-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">
              {uploadError}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">处理队列</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 font-mono">
              {currentTaskId ? currentTaskId.slice(0, 8) : "IDLE"}
            </span>
          </div>
          {progress ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium uppercase tracking-wider text-slate-500">
                  {progress.stage.replace(/_/g, " ")}
                </span>
                <span className="font-bold text-indigo-600">
                  {Math.round(progress.progress)}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-indigo-600 shadow-[0_0_10px_rgba(79,70,229,0.3)] transition-all duration-500 ease-out"
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
              {progress.message && (
                <p className="text-xs text-slate-400">{progress.message}</p>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center py-2 text-xs text-slate-400">
              Waiting for task...
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-900">
            语义检索
          </div>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索关键词..."
              className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition-all"
            />
            <button
              type="button"
              onClick={() => {
                void handleSearch();
              }}
              disabled={!viewerDocumentId || searching || !searchQuery.trim()}
              className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-indigo-200 transition-all hover:bg-indigo-700 hover:shadow-indigo-300 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
            >
              {searching ? (
                 <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : (
                "Search"
              )}
            </button>
          </div>
          {searchError && (
            <div className="mb-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">
              {searchError}
            </div>
          )}
          <div className="max-h-48 space-y-2 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-200">
            {searchResults.length === 0 ? (
              <p className="py-2 text-center text-xs text-slate-400">
                暂无搜索结果
              </p>
            ) : (
              searchResults.map((r, idx) => (
                <button
                  key={`${r.pageNumber}-${idx}`}
                  type="button"
                  onClick={() => {
                    setActiveReference({
                      documentId: r.documentId,
                      pageNumber: r.pageNumber,
                      regionIds: r.regionIds,
                    });
                  }}
                  className="group block w-full rounded-xl border border-transparent bg-slate-50 px-3 py-2.5 text-left transition-all hover:border-indigo-100 hover:bg-indigo-50/50 hover:shadow-sm"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-500 group-hover:text-indigo-600">
                      Page {r.pageNumber}
                    </span>
                    <span className="rounded-md bg-slate-200/50 px-1.5 py-0.5 text-[10px] text-slate-500">
                      {r.regionIds.length} Regions
                    </span>
                  </div>
                  <p className="line-clamp-2 text-xs text-slate-600 group-hover:text-slate-900">
                    {r.snippet}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
             <div className="text-sm font-semibold text-slate-900">
              AI 助手
            </div>
             {chatError && (
              <div className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] text-red-600">
                {chatError}
              </div>
            )}
          </div>
          
          <div className="overflow-hidden rounded-xl bg-slate-50/50 border border-slate-100 mb-4 relative">
             {chatMessages.length === 0 ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-slate-400">
                  <svg className="mb-3 h-10 w-10 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <p className="text-sm">Ready to chat about your document.</p>
                </div>
              ) : (
                <div
                  ref={chatListRef}
                  className="h-64 w-full overflow-y-auto scrollbar-thin scrollbar-thumb-slate-200 px-4 py-2"
                >
                  {chatMessages.map((m) => {
                    const hasCitations = m.citations && m.citations.length > 0;
                    const isUser = m.role === "user";
                    return (
                      <div key={m.id} className="mb-2">
                        <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
                          <div
                            className={`mb-1 text-[10px] font-medium uppercase tracking-wider ${
                              isUser ? "text-slate-400" : "text-indigo-500"
                            }`}
                          >
                            {isUser ? "You" : "Assistant"}
                          </div>
                          <div
                            className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                              isUser
                                ? "bg-indigo-600 text-white rounded-tr-sm"
                                : "bg-white border border-slate-100 text-slate-700 rounded-tl-sm"
                            }`}
                          >
                            <div className="whitespace-pre-wrap leading-relaxed">
                              {m.content}
                            </div>
                            {!isUser && hasCitations && viewerDocumentId && (
                              <div className="mt-3 flex flex-wrap gap-1.5 pt-2 border-t border-slate-100">
                                {m.citations!.map((c, idx) => (
                                  <button
                                    key={`${m.id}-c-${idx}`}
                                    type="button"
                                    onClick={() => {
                                      setActiveReference({
                                        documentId: viewerDocumentId,
                                        pageNumber: c.pageNumber,
                                        regionIds: c.regionIds,
                                      });
                                    }}
                                    className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-1 text-[10px] font-medium text-indigo-700 hover:bg-indigo-100 hover:text-indigo-800 transition-colors"
                                  >
                                    <span className="opacity-50">P.{c.pageNumber}</span>
                                    <span>Area {c.regionIds.length}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
               <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask something..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition-all pr-10"
              />
               <button
                  type="button"
                  onClick={handleToggleVoiceInput}
                  disabled={!speechSupported || chatStreaming}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 transition-colors ${
                    recognizing 
                    ? "bg-red-100 text-red-600 animate-pulse" 
                    : "text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                  }`}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </button>
            </div>
           
            <button
              type="button"
              onClick={handleChatSubmit}
              disabled={!viewerDocumentId || chatStreaming || !chatInput.trim()}
              className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-indigo-200 transition-all hover:bg-indigo-700 hover:shadow-indigo-300 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
            >
               {chatStreaming ? (
                  <span className="flex items-center gap-1">
                     <span className="h-1.5 w-1.5 rounded-full bg-white animate-bounce"></span>
                     <span className="h-1.5 w-1.5 rounded-full bg-white animate-bounce delay-75"></span>
                     <span className="h-1.5 w-1.5 rounded-full bg-white animate-bounce delay-150"></span>
                  </span>
               ) : (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
               )}
            </button>
             <button
              type="button"
              onClick={handleResetChat}
              disabled={chatMessages.length === 0 && !chatError}
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-all disabled:opacity-50"
            >
               <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
            </button>
          </div>
        </div>
      </section>

      <section className="relative flex flex-1 flex-col overflow-hidden bg-slate-50/50">
        <div className="absolute inset-0 z-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(#6366f1 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>
        <div className="relative z-10 flex h-full flex-col p-4 lg:p-8">
           <div className="h-full w-full overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_8px_40px_-12px_rgba(0,0,0,0.1)] ring-1 ring-slate-900/5">
             {pages.length === 0 ? (
               <div
                 className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed border-slate-200 bg-slate-50/70 px-8 text-center transition-colors hover:border-indigo-300 hover:bg-indigo-50/40"
                 onDragOver={(e) => {
                   e.preventDefault();
                 }}
                 onDrop={(e) => {
                   e.preventDefault();
                   if (uploading) return;
                   const file = e.dataTransfer.files?.[0];
                   if (file && file.type === "application/pdf") {
                     void handleUpload(file);
                   }
                 }}
                 onClick={() => {
                   if (uploading) return;
                   mainUploadInputRef.current?.click();
                 }}
               >
                 <div className="mb-2 rounded-full bg-indigo-50 p-4 text-indigo-600">
                   <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                   </svg>
                 </div>
                 <div className="text-sm font-semibold text-slate-900">
                   点击或拖拽 PDF 到此区域上传
                 </div>
                 <div className="text-xs text-slate-500">
                   支持单个 PDF 文件上传，处理中可在左侧查看进度
                 </div>
               </div>
             ) : (
               <PdfViewer
                 documentId={viewerDocumentId ?? "demo-doc"}
                 pages={pages}
                 regionsByPage={regionsByPage}
                 renderPage={renderPdfPage}
               />
             )}
           </div>
        </div>
      </section>
    </main>
  );
}
