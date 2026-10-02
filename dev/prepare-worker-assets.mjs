import { copyFile, mkdir } from "node:fs/promises";

const output = new URL("../deploy/worker-assets/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(new URL("../plugin/dist/app.html", import.meta.url), new URL("app.html", output));
await copyFile(new URL("../plugin/assets/icon.svg", import.meta.url), new URL("icon.svg", output));
