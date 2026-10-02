import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIVE_TOOLS } from "../app/live-tools.ts";
import { editorSessions, type EditorSessions } from "./editor-sessions.ts";
import type { LocalFiles } from "./local-files.ts";

// The URI is the host's cache key for the UI: change it when the app changes
// in a way an already-open editor cannot load.
const EDITOR_URI = "ui://word-in-gpt/editor-v6";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

// What the host passes to a file entrypoint tool when the user opens a matching file.
const fileEntrypointInput = { file: z.object({ name: z.string(), resourceUri: z.string() }) };

/**
 * Serve the editor and relay model commands to its live document. Host-granted
 * files use the host's resource bridge. The stdio entry also supplies LocalFiles
 * so a model can directly launch an explicitly requested local document.
 */
export function createServer(editorHtml: string, iconSvg: string, localFiles?: LocalFiles, sessions: EditorSessions = editorSessions): McpServer {
  const icon = { src: "data:image/svg+xml," + encodeURIComponent(iconSvg), mimeType: "image/svg+xml", sizes: ["any"] };
  const server = new McpServer({ name: "word-in-gpt", title: "Word", version: "0.1.0", icons: [icon] });

  const sessionId = z.string().uuid().describe("editorSessionId supplied by the open Word editor in model context.");
  for (const tool of LIVE_TOOLS) {
    const schema = z.fromJSONSchema(tool.inputSchema) as z.ZodObject;
    server.registerTool(tool.name, {
      description: `${tool.description}\nRuns against the live Word editor. Use editorSessionId from the editor context.`,
      inputSchema: schema.extend({ editorSessionId: sessionId }),
      annotations: { readOnlyHint: !["word_document_edit", "word_document_patch"].includes(tool.name), destructiveHint: ["word_document_edit", "word_document_patch"].includes(tool.name), openWorldHint: false },
    }, async ({ editorSessionId, ...args }) => sessions.call(editorSessionId as string, tool.name, args));
  }

  const appOnly = { ui: { resourceUri: EDITOR_URI, visibility: ["app"] } };
  const result = (data: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data });
  server.registerTool("word_editor_connect", {
    description: "Connect the open editor to live document commands.", inputSchema: { editorSessionId: sessionId.optional() }, _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ editorSessionId }) => result({ editorSessionId: sessions.connect(editorSessionId) }));
  server.registerTool("word_editor_poll", {
    description: "Wait for the next command for this editor.", inputSchema: { editorSessionId: sessionId }, _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ editorSessionId }) => result({ command: await sessions.poll(editorSessionId) }));
  server.registerTool("word_editor_reply", {
    description: "Return a result from this editor.",
    inputSchema: { editorSessionId: sessionId, commandId: z.string(), result: z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() }) },
    _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ editorSessionId, commandId, result: reply }) => { sessions.reply(editorSessionId, commandId, reply); return result({}); });
  server.registerTool("word_editor_disconnect", {
    description: "Disconnect a closed editor.", inputSchema: { editorSessionId: sessionId }, _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ editorSessionId }) => { sessions.disconnect(editorSessionId); return result({}); });

  if (localFiles) {
    server.registerTool("word_local_read", {
      description: "Read one file previously opened by the local Word launcher.",
      inputSchema: { uri: z.string() }, _meta: appOnly,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async ({ uri }) => result(await localFiles.read(uri)));
    server.registerTool("word_local_write", {
      description: "Save the previously opened local file with a version check.",
      inputSchema: { uri: z.string(), blob: z.string(), ifMatch: z.string().optional() }, _meta: appOnly,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async ({ uri, blob, ifMatch }) => result(await localFiles.write(uri, blob, ifMatch)));
  }

  server.registerResource(
    "word-editor",
    EDITOR_URI,
    { title: "Word editor", mimeType: MCP_APP_MIME_TYPE },
    async () => ({
      contents: [{
        uri: EDITOR_URI,
        mimeType: MCP_APP_MIME_TYPE,
        text: editorHtml,
        _meta: {
          "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] },
          ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
        },
      }],
    }),
  );

  server.registerTool(
    "open_word_document",
    {
      title: "Open in Word editor",
      description: localFiles
        ? "Open a local .docx in the live Word editor. Set file.name to its filename and file.resourceUri to its absolute file:/// URL. Also accepts host-granted resource URIs."
        : "Opens a .docx file in the Word editor using the host-granted resource URI.",
      inputSchema: fileEntrypointInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: EDITOR_URI },
        "openai/ui": { entrypoints: [{ type: "file", extensions: [".docx"] }], preferredModelDisplayMode: "fullscreen" },
      },
    },
    async ({ file }) => {
      let editorSessionId: string | undefined;
      if (file.resourceUri.startsWith("file:")) {
        if (!localFiles) throw new Error("Local file URLs require the locally installed Word plugin.");
        file = await localFiles.open(file.resourceUri);
        editorSessionId = sessions.connect();
      }
      return {
      content: [{
        type: "text",
        text: `Opening ${file.name} in Word. ${editorSessionId ? `Use editorSessionId ${editorSessionId} with the word_document_* tools.` : "Use the editorSessionId from the editor's model context."} The panel shows Chat connected when ready.`,
      }],
      structuredContent: { file, ...(editorSessionId ? { editorSessionId } : {}) },
    }; },
  );

  return server;
}
