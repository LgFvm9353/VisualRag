import { sha256 } from "js-sha256";

type HashRequest = {
  type: "hash";
  requestId: string;
  file: File;
  chunkSize: number;
};

type HashResponse =
  | {
      type: "done";
      requestId: string;
      hash: string;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
    };

function toErrorMessage(err: unknown) {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

self.onmessage = async (event: MessageEvent<HashRequest>) => {
  const data = event.data;
  if (!data || data.type !== "hash") return;
  const { requestId, file, chunkSize } = data;
  try {
    const hasher = sha256.create();
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + chunkSize, file.size);
      const chunkBuffer = await file.slice(offset, end).arrayBuffer();
      hasher.update(new Uint8Array(chunkBuffer));
      offset = end;
    }
    const response: HashResponse = {
      type: "done",
      requestId,
      hash: hasher.hex(),
    };
    self.postMessage(response);
  } catch (err) {
    const response: HashResponse = {
      type: "error",
      requestId,
      message: toErrorMessage(err),
    };
    self.postMessage(response);
  }
};

