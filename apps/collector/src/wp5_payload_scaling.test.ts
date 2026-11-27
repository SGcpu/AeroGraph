import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import http from "node:http";
import { createApp } from "./server.js";

describe("WP-5: Collector >2 MB gzip payload scaling", () => {
  it("ingests 50 large RAG retriever chunks (>2 MB uncompressed) via gzip without error", async () => {
    const app = createApp({ dbPath: ":memory:", enableOrchestrator: false });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const largeContent = "A".repeat(48 * 1024); // ~48 KB per event -> 50 * 48 KB > 2.4 MB
      const events = Array.from({ length: 50 }, (_, i) => ({
        schemaVersion: "1.1.0",
        traceId: "t_wp5_large_rag",
        spanId: `sp_ret_${i}`,
        parentSpanId: null,
        occurredAt: new Date(Date.now() + i).toISOString(),
        actor: { kind: "tool", id: "chroma" },
        kind: "retriever",
        status: "ok",
        payload: {
          query: `chunk query ${i}`,
          documents: [{ pageContent: largeContent, metadata: { chunk: i } }]
        },
        links: []
      }));

      const rawJson = JSON.stringify({ events });
      expect(Buffer.byteLength(rawJson, "utf-8")).toBeGreaterThan(2 * 1024 * 1024);

      const gz = gzipSync(Buffer.from(rawJson, "utf-8"));
      const res = await fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip"
        },
        body: gz
      });

      expect(res.status).toBe(201);

      const traceRes = await fetch(`${baseUrl}/v1/traces/t_wp5_large_rag`);
      expect(traceRes.status).toBe(200);
      const traceJson = (await traceRes.json()) as any;
      expect(traceJson.events).toHaveLength(50);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
