// Local plugin entry. Bundled to plugin/dist/server.mjs, which plugin/.mcp.json runs.
import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";
import { LocalFiles } from "./local-files.ts";

const html = await readFile(new URL("./app.html", import.meta.url), "utf8");
const icon = await readFile(new URL("../assets/icon.svg", import.meta.url), "utf8");
await createServer(html, icon, new LocalFiles()).connect(new StdioServerTransport());
