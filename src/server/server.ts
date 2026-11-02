import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIVE_TOOLS } from "../app/live-tools.ts";
import { editorSessions, type EditorSessions } from "./editor-sessions.ts";
import type { LocalFiles } from "./local-files.ts";
import { EDIT_TOOLS } from "./edit-tools.ts";

// The URI is the host's cache key for the UI: change it when the app changes
// in a way an already-open editor cannot load.
// Increment for each deployed UI change: hosts cache templates by their URI.
const EDITOR_VERSION = 22;
const EDITOR_URI = `ui://word-in-gpt/editor-v${EDITOR_VERSION}`;
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

// What the host passes to a file entrypoint tool when the user opens a matching file.
const fileEntrypointInput = { file: z.object({ name: z.string(), resourceUri: z.string() }) };
const uploadedFileInput = { file: z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}) };

// ChatGPT serves uploads from OpenAI file storage. The attachment fallback
// fetches only these hosts; any other URL would make this public, unauthenticated
// server an open proxy.
export function isOpenAIFileUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "https:" &&
    (/^oaisdm[a-z0-9]*\.blob\.core\.windows\.net$/.test(url.hostname) || url.hostname.endsWith(".oaiusercontent.com"));
}

/** Fetch an OpenAI file URL, following redirects only to other OpenAI file hosts. */
export async function fetchOpenAIFile(downloadUrl: string): Promise<Response> {
  let url = downloadUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isOpenAIFileUrl(url)) throw new Error("Use the download URL supplied by ChatGPT.");
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("Location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    url = new URL(location, url).href;
  }
  throw new Error("The attachment download redirected too many times.");
}

// Tool schemas stay the same across requests; build them once per runtime.
const sessionId = z.string().uuid().describe("editorSessionId returned by the document opening tool.");
const liveTools = LIVE_TOOLS.filter(tool => tool.name !== "word_document_edit").map(tool => ({
  ...tool,
  inputSchema: (z.fromJSONSchema(tool.inputSchema) as z.ZodObject).extend({ editorSessionId: sessionId }),
}));
const editTools = EDIT_TOOLS.map(tool => ({
  ...tool,
  inputSchema: tool.inputSchema.extend({ editorSessionId: sessionId }),
}));

/**
 * Serve the editor and relay model commands to its live document. Host-granted
 * files use the host's resource bridge. The stdio entry also supplies LocalFiles
 * so a model can directly launch an explicitly requested local document.
 */
export function createServer(editorHtml: string, iconSvg: string, localFiles?: LocalFiles, sessions: EditorSessions = editorSessions, attachmentDownloadUrl?: (url: string) => string, editorSocketUrl?: (id: string) => string): McpServer {
  const icon = { src: "data:image/svg+xml," + encodeURIComponent(iconSvg), mimeType: "image/svg+xml", sizes: ["any"] };
  const server = new McpServer({ name: "word-in-gpt", title: "Word in Chat", version: "0.1.4", icons: [icon] });

  for (const tool of liveTools) {
    server.registerTool(tool.name, {
      description: `${tool.description}\nRuns against the live Word editor. Use editorSessionId returned by the document opening tool.`,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.name !== "word_document_patch", destructiveHint: tool.name === "word_document_patch", openWorldHint: false },
    }, async ({ editorSessionId, ...args }) => sessions.call(editorSessionId as string, tool.name, args));
  }

  for (const tool of editTools) {
    server.registerTool(tool.name, {
      description: `${tool.description}\nApply to the open document using its observed revision and editorSessionId.`,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async ({ editorSessionId, revision, ...args }) => sessions.call(editorSessionId as string, "word_document_edit", {
      revision, operations: [tool.operation(args)],
    }));
  }

  const appOnly = { ui: { resourceUri: EDITOR_URI, visibility: ["app"] } };
  const result = (data: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data });
  server.registerTool("word_editor_connect", {
    description: "Connect the open editor to live document commands.", inputSchema: { editorSessionId: sessionId.optional() }, _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ editorSessionId }) => {
    const id = sessions.connect(editorSessionId);
    return result({ editorSessionId: id, ...(editorSocketUrl ? { webSocketUrl: editorSocketUrl(id) } : {}) });
  });
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

  // Saved connections can still request a previously published template URI.
  for (let version = 5; version <= EDITOR_VERSION; version++) {
    const uri = `ui://word-in-gpt/editor-v${version}`;
    server.registerResource(
      `word-editor-v${version}`,
      uri,
      { title: "Word in Chat editor", mimeType: MCP_APP_MIME_TYPE },
      async () => ({
        contents: [{
          uri,
          mimeType: MCP_APP_MIME_TYPE,
          text: editorHtml,
          _meta: {
            "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] },
            ui: { prefersBorder: false, csp: { connectDomains: ["https://word-in-gpt-mcp.callerinfo.workers.dev", "wss://word-in-gpt-mcp.callerinfo.workers.dev"], resourceDomains: [] } },
          },
        }],
      }),
    );
  }

  server.registerTool(
    localFiles ? "open_word_document" : "open_word_resource",
    {
      title: localFiles ? "Open local DOCX in Word in Chat" : "Open host DOCX in Word in Chat",
      description: localFiles
        ? "Open a local .docx in the live Word editor. Set file.name to its filename and file.resourceUri to its absolute file:/// URL. Also accepts host-granted resource URIs."
        : "Open a DOCX supplied by a desktop host using its granted resource URI. For a local .docx path, call open_word_document with the absolute path as file. For ChatGPT uploaded attachments, including reopening one, use open_word_document with the original attachment's file parameters.",
      inputSchema: fileEntrypointInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: EDITOR_URI },
        "openai/ui": { entrypoints: [{ type: "file", extensions: [".docx"] }], preferredModelDisplayMode: "fullscreen" },
      },
    },
    async ({ file }) => {
      if (file.resourceUri.startsWith("word-upload://")) throw new Error("Reopen the uploaded attachment with open_word_document and its original ChatGPT file parameters.");
      if (file.resourceUri.startsWith("file:")) {
        if (!localFiles) throw new Error(`This tool does not accept file URLs. Call open_word_document with {"file":${JSON.stringify(decodeURIComponent(new URL(file.resourceUri).pathname))}}. The host uploads a copy of the file.`);
        file = await localFiles.open(file.resourceUri);
      }
      const editorSessionId = sessions.connect();
      return {
      content: [{
        type: "text",
        text: `Opening ${file.name} in Word in Chat. Editor loading is pending. Use editorSessionId ${editorSessionId} with the word_document_* tools. Confirm opening only after word_document_inspect returns the document content. The panel shows Chat connected when ready.`,
      }],
      structuredContent: { file, editorSessionId },
    }; },
  );

  if (!localFiles) {
    server.registerTool("word_attachment_read", {
      description: "Provide an authorized attachment download for the editor when its direct browser download fails. Returns the download in private metadata.",
      inputSchema: { downloadUrl: z.string().url() }, _meta: appOnly,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async ({ downloadUrl }) => {
      if (!isOpenAIFileUrl(downloadUrl)) throw new Error("Use the download URL supplied by ChatGPT.");
      if (attachmentDownloadUrl) return { ...result({}), _meta: { fileDownloadUrl: attachmentDownloadUrl(downloadUrl) } };
      const response = await fetchOpenAIFile(downloadUrl);
      if (!response.ok) throw new Error("The uploaded file could not be read. Attach the DOCX again and retry.");
      const blob = Buffer.from(await response.arrayBuffer()).toString("base64");
      return { ...result({}), _meta: { fileBlob: blob } };
    });
    server.registerTool("open_word_document", {
      title: "Open uploaded DOCX in Word in Chat",
      description: "Open an uploaded DOCX in Word in Chat. Pass the file supplied by ChatGPT. In Codex, pass a local .docx as its absolute path, for example {\"file\":\"/Users/me/report.docx\"}. Use the editorSessionId returned by this tool for document tools. Confirm opening by inspecting the document. Edits stay in the editor; choose Download DOCX to export an edited copy.",
      inputSchema: uploadedFileInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: EDITOR_URI }, "openai/fileParams": ["file"],
        "openai/ui": { preferredModelDisplayMode: "fullscreen" } },
    }, async ({ file }) => {
      if (new URL(file.download_url).protocol !== "https:") throw new Error("Use the HTTPS download URL supplied by ChatGPT.");
      const opened = { name: file.file_name ?? "document.docx", resourceUri: `word-upload://${file.file_id}` };
      const editorSessionId = sessions.connect();
      return {
        ...result({ file: opened, editorSessionId }),
        _meta: { fileDownloadUrl: file.download_url },
        content: [{ type: "text" as const, text: `Opening ${opened.name}. Editor loading is pending. Use editorSessionId ${editorSessionId} with the word_document_* tools. Confirm opening only after word_document_inspect returns the document content. Download DOCX exports the edited copy.` }],
      };
    });
  }

  return server;
}
