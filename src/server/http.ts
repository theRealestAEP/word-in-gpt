// Hosted entry for public submission, which requires a remote HTTPS MCP endpoint.
// Run behind TLS (or an HTTPS tunnel while testing): node src/server/http.ts
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.ts";

const html = await readFile(new URL("../../plugin/dist/app.html", import.meta.url), "utf8");
const icon = await readFile(new URL("../../plugin/assets/icon.svg", import.meta.url), "utf8");
const port = Number(process.env.PORT ?? 8787);

createHttpServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
    return;
  }
  if (path !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  // Each request has its own transport; editor sessions share this process.
  const server = createServer(html, icon);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}).listen(port, () => console.log(`MCP server on http://localhost:${port}/mcp`));
