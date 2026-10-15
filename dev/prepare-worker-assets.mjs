import { copyFile, mkdir, writeFile } from "node:fs/promises";

const output = new URL("../deploy/worker-assets/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(new URL("../plugin/dist/app.html", import.meta.url), new URL("app.html", output));
await copyFile(new URL("../plugin/assets/icon.svg", import.meta.url), new URL("icon.svg", output));
await copyFile(new URL("../publication/fixtures/review.docx", import.meta.url), new URL("review.docx", output));
// The Worker answers Codex's frequent tools/list requests from this file.
const { toolsListResult } = await import("../src/server/tools-list.ts");
await writeFile(new URL("tools-list.json", output), await toolsListResult());
