import "dotenv/config";
import { randomUUID } from "crypto";

async function main() {
  const port = Number(process.env.PORT) || 4000;
  const origin = "http://localhost:3000";
  const documentId = randomUUID();
  const url = new URL(`http://localhost:${port}/chat/stream`);
  url.searchParams.set("documentId", documentId);
  url.searchParams.set("q", "test");
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Origin: origin,
      },
    });
    const cors = res.headers.get("access-control-allow-origin");
    if (!cors) {
      console.error("chat_stream_cors_missing", { cors });
      if (res.body) {
        await res.body.cancel();
      }
      process.exit(1);
    }
    console.log("chat_stream_cors_ok", cors);
    if (res.body) {
      await res.body.cancel();
    }
    process.exit(0);
  } catch (err) {
    console.error("chat_stream_test_error", err);
    process.exit(1);
  }
}

void main();

