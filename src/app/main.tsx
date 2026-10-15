// Metric-compatible substitutes for Calibri and Cambria, so line breaks match Word.
import "@fontsource/carlito/400.css";
import "@fontsource/carlito/400-italic.css";
import "@fontsource/carlito/700.css";
import "@fontsource/carlito/700-italic.css";
import "@fontsource/caladea/400.css";
import "@fontsource/caladea/400-italic.css";
import "@fontsource/caladea/700.css";
import "@fontsource/caladea/700-italic.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { EditorController } from "./controller.ts";
import { host, isHostFile, receiveUpload } from "./host.ts";
import { LIVE_TOOLS } from "./live-tools.ts";
import { connectServerTools } from "./server-tools.ts";

const controller = new EditorController();
createRoot(document.getElementById("root")!).render(<App controller={controller} />);

let disconnect: (() => Promise<void>) | undefined;
let connecting: Promise<void> | undefined;
let openingSessionId: string | undefined;
function openFile(file: unknown, editorSessionId?: string) {
  if (!isHostFile(file) || connecting) return;
  if (controller.state.doc && controller.state.file?.resourceUri === file.resourceUri &&
      (!editorSessionId || editorSessionId === openingSessionId)) return;
  // A local launcher resolves file:/// input to a granted word-local:// handle
  // in its tool result. Wait for that result before asking for the file bytes.
  if (file.resourceUri.startsWith("file:")) return;
  connecting = (async () => {
    await controller.flush();
    await disconnect?.();
    disconnect = undefined;
    // Join the chat session even when loading fails, so the model gets the reason at once.
    await controller.open(file).catch(controller.report);
    try {
      disconnect = await connectServerTools(controller, editorSessionId);
      openingSessionId = editorSessionId;
    }
    catch (error) { controller.setConnection(`Chat connection failed: ${error instanceof Error ? error.message : String(error)}`); }
  })().catch(controller.report).finally(() => { connecting = undefined; });
}

host.on("ui/notifications/tool-result", (params) => {
  const result = params.structuredContent as { file?: unknown; editorSessionId?: string } | undefined;
  const metadata = params._meta as { fileBlob?: string; fileDownloadUrl?: string } | undefined;
  if (isHostFile(result?.file) &&
      !(controller.state.doc && controller.state.file?.resourceUri === result.file.resourceUri)) {
    receiveUpload(result.file, metadata?.fileBlob, metadata?.fileDownloadUrl);
  }
  openFile(result?.file, result?.editorSessionId);
});
host.on("notifications/resources/updated", (params) => {
  controller.onFileChanged(String(params.uri)).catch(controller.report);
});

// The model calls these while the document is open.
host.handle("tools/list", () => ({ tools: LIVE_TOOLS }));
host.handle("tools/call", async (params) => {
  try {
    const result = await controller.callTool(String(params.name), (params.arguments as Record<string, unknown>) ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
});
host.handle("ui/resource-teardown", async () => {
  await controller.flush();
  await disconnect?.();
  return {};
});
host.handle("ping", () => ({}));

if (window.parent !== window) {
  host
    .request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "word-in-gpt", version: "0.1.4" },
      appCapabilities: { tools: {}, availableDisplayModes: ["inline", "fullscreen"] },
    })
    .then(() => {
      host.notify("ui/notifications/initialized");
    })
    .catch(controller.report);
}
