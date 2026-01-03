import "dotenv/config";

async function main() {
  const port = Number(process.env.PORT) || 4000;
  const url = `http://localhost:${port}/health`;
  try {
    const res = await fetch(url);
    const body = await res.json();
    if (res.ok && body.status === "ok") {
      console.log("health_ok");
      process.exit(0);
    }
    console.error("health_unhealthy", res.status, body);
    process.exit(1);
  } catch (err) {
    console.error("health_request_failed", err);
    process.exit(1);
  }
}

void main();

