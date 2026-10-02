// Local integration harness: the real MCP server plus a host-managed test file.
import { createServer as http } from "node:http";
import { readFile, writeFile, copyFile, constants } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/server/server.ts";
import { LocalFiles } from "../src/server/local-files.ts";

const root = new URL("../", import.meta.url);
const document = new URL("dev/integration-live.docx", root);
try { await copyFile(new URL("dev/sample.docx", root), document, constants.COPYFILE_EXCL); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
const html = await readFile(new URL("plugin/dist/app.html", root), "utf8");
const icon = await readFile(new URL("plugin/assets/icon.svg", root), "utf8");
const localFiles = new LocalFiles();
const routes = new Map([
  ["/dev/mock-host.html", ["dev/mock-host.html", "text/html"]],
  ["/plugin/dist/app.html", ["plugin/dist/app.html", "text/html"]],
  ["/dev/sample.docx", ["dev/sample.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
  ["/dev/review.docx", ["publication/fixtures/review.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
  ["/dev/selection-review.docx", ["dev/selection-review.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
]);
const etag = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
http(async (req, res) => {
  try {
    const path = new URL(req.url!, "http://localhost").pathname;
    if (path === "/mcp") {
      const server = createServer(html, icon, localFiles);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    if (path === "/local-file") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: "integration-live.docx", resourceUri: document.href }));
      return;
    }
    if (path === "/document") {
      let bytes = await readFile(document);
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (req.headers["if-match"] && req.headers["if-match"] !== etag(bytes)) {
          res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ etag: etag(bytes) }));
          return;
        }
        bytes = Buffer.concat(chunks);
        await writeFile(document, bytes);
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ blob: bytes.toString("base64"), etag: etag(bytes) }));
      return;
    }
    const asset = routes.get(path);
    if (!asset) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" }).end(await readFile(new URL(asset[0], root)));
  } catch (error) { res.writeHead(500).end(String(error)); }
}).listen(8766, "127.0.0.1", () => console.log("Live integration test: http://127.0.0.1:8766/dev/mock-host.html?save=1"));
