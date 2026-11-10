import { createAppTransport } from "@openai/mcp-extensions/app/transport";

/** JSON-RPC link to the ChatGPT / Codex host that renders this app. */
export const host = createAppTransport();

/** The editor opened as a page of its own (/edit), with no chat host around it. */
export const standalone = typeof window !== "undefined" && window.parent === window;

// A page of its own talks to the server it came from. Inside a chat host the
// page has no origin of its own, and its CSP allows only this server.
const SERVER = standalone ? location.origin : "https://word-in-gpt-mcp.callerinfo.workers.dev";

/** The file waits for the user to choose it, or for an agent to upload it. */
export class NeedsFile extends Error {}

/** The file the host passes when the user opens a .docx. */
export type HostFile = { name: string; resourceUri: string };

const uploadedFiles = new Map<string, FileSnapshot>();
const uploadUrls = new Map<string, string>();
// word-session:// is a file for open_word_editor: uploaded by an agent, or chosen by the user.
export const isUploadedFile = (uri: string): boolean => uri.startsWith("word-upload://") || uri.startsWith("word-session://");

/** Hold a file the user chose for this editor session. */
export function provideFile(uri: string, bytes: Uint8Array): void {
  uploadedFiles.set(uri, { bytes, etag: "0", writable: true });
}

export function receiveUpload(file: HostFile, blob?: string, downloadUrl?: string): void {
  if (blob) uploadedFiles.set(file.resourceUri, { bytes: base64ToBytes(blob), etag: "0", writable: true });
  if (downloadUrl) uploadUrls.set(file.resourceUri, downloadUrl);
}

export type FileSnapshot = { bytes: Uint8Array; etag: string | null; writable: boolean; name?: string };

export type WriteResult =
  | { outcome: "saved"; etag: string }
  | { outcome: "conflict"; etag: string }
  | { outcome: "too-large"; maxBytes: number };

type ReadResult = {
  contents: Array<{
    uri: string;
    blob?: string;
    _meta?: { "openai/resource"?: { etag?: string; writable?: boolean } };
  }>;
};

const FILE_TIMEOUT_MS = 60_000;

type UploadToolResult = {
  structuredContent?: { file?: HostFile };
  _meta?: { fileBlob?: string; fileDownloadUrl?: string };
  isError?: boolean;
  content?: Array<{ text: string }>;
};

async function requestAttachment(downloadUrl: string): Promise<UploadToolResult> {
  const result = await host.request<UploadToolResult>("tools/call", {
    name: "word_attachment_read", arguments: { downloadUrl },
  }, FILE_TIMEOUT_MS);
  if (result.isError) throw new Error(result.content![0].text);
  return result;
}

export function isHostFile(value: unknown): value is HostFile {
  const file = value as HostFile | undefined;
  return typeof file?.name === "string" && typeof file.resourceUri === "string";
}

export async function readFile(uri: string): Promise<FileSnapshot> {
  if (isUploadedFile(uri)) {
    const snapshot = uploadedFiles.get(uri);
    if (snapshot) return snapshot;
    if (uri.startsWith("word-session://")) {
      const response = await fetch(`${SERVER}/uploads/${uri.slice("word-session://".length)}`);
      if (response.status === 404) throw new NeedsFile("Choose a .docx file, or start a blank document.");
      if (!response.ok) throw new Error(`The uploaded file could not be read (${response.status}).`);
      const name = response.headers.get("X-File-Name");
      const uploaded = { bytes: new Uint8Array(await response.arrayBuffer()), etag: "0", writable: true, ...(name ? { name: decodeURIComponent(name) } : {}) };
      uploadedFiles.set(uri, uploaded);
      return uploaded;
    }
    const openai = (window as unknown as { openai?: {
      toolResponseMetadata?: { mcp_tool_result?: UploadToolResult; call_tool_result?: UploadToolResult };
      getFileDownloadUrl?: (input: { fileId: string }) => Promise<{ downloadUrl: string }>;
    } }).openai;
    const metadata = openai?.toolResponseMetadata;
    for (const result of [metadata?.mcp_tool_result, metadata?.call_tool_result]) {
      if (result?.structuredContent?.file?.resourceUri === uri) {
        receiveUpload(result.structuredContent.file, result._meta?.fileBlob, result._meta?.fileDownloadUrl);
        const restored = uploadedFiles.get(uri);
        if (restored) return restored;
      }
    }
    const fileId = uri.slice("word-upload://".length);
    let downloadUrl = uploadUrls.get(uri);
    if (!downloadUrl) {
      if (!openai?.getFileDownloadUrl) throw new Error("Attach the DOCX again to reopen it.");
      ({ downloadUrl } = await openai.getFileDownloadUrl({ fileId }));
    }
    try {
      let response = await fetch(downloadUrl);
      if ((response.status === 401 || response.status === 403) && openai?.getFileDownloadUrl) {
        ({ downloadUrl } = await openai.getFileDownloadUrl({ fileId }));
        response = await fetch(downloadUrl);
      }
      if (!response.ok) throw new Error("The attachment download failed.");
      const direct = { bytes: new Uint8Array(await response.arrayBuffer()), etag: "0", writable: true };
      uploadedFiles.set(uri, direct);
      return direct;
    } catch {
      // Some hosts restrict browser downloads. Fetch through the server only then.
    }
    // The editor's CSP allows only its own server, so in ChatGPT every attachment
    // arrives here, and an expired link shows up as the relayed 401 or 403.
    let result = await requestAttachment(downloadUrl);
    if (result._meta?.fileDownloadUrl) {
      let response = await fetch(result._meta.fileDownloadUrl);
      if ((response.status === 401 || response.status === 403) && openai?.getFileDownloadUrl) {
        ({ downloadUrl } = await openai.getFileDownloadUrl({ fileId }));
        result = await requestAttachment(downloadUrl);
        response = await fetch(result._meta!.fileDownloadUrl!);
      }
      if (!response.ok) throw new Error("The attachment could not be restored. Attach the DOCX again.");
      const snapshot = { bytes: new Uint8Array(await response.arrayBuffer()), etag: "0", writable: true };
      uploadedFiles.set(uri, snapshot);
      return snapshot;
    }
    if (!result._meta?.fileBlob) throw new Error("The attachment could not be restored. Attach the DOCX again.");
    uploadedFiles.set(uri, { bytes: base64ToBytes(result._meta.fileBlob), etag: "0", writable: true });
    return uploadedFiles.get(uri)!;
  }
  if (uri.startsWith("word-local://")) {
    const snapshot = await callServer<{ blob: string; etag: string; writable: boolean }>("word_local_read", { uri });
    return { bytes: base64ToBytes(snapshot.blob), etag: snapshot.etag, writable: snapshot.writable };
  }
  const result = await host.request<ReadResult>(
    "resources/read",
    { uri, _meta: { "openai/resource": { representation: "blob" } } },
    FILE_TIMEOUT_MS,
  );
  const content = result.contents.find((item) => item.uri === uri) ?? result.contents[0];
  if (!content?.blob) throw new Error("The host returned no file contents.");
  const meta = content._meta?.["openai/resource"];
  return { bytes: base64ToBytes(content.blob), etag: meta?.etag ?? null, writable: meta?.writable === true };
}

/** Without `ifMatch` the write replaces whatever is on disk. */
export function writeFile(uri: string, bytes: Uint8Array, ifMatch: string | null): Promise<WriteResult> {
  if (isUploadedFile(uri)) {
    const etag = String(Number(uploadedFiles.get(uri)!.etag) + 1);
    uploadedFiles.set(uri, { bytes, etag, writable: true });
    return Promise.resolve({ outcome: "saved", etag });
  }
  if (uri.startsWith("word-local://")) {
    return callServer("word_local_write", { uri, blob: bytesToBase64(bytes), ...(ifMatch ? { ifMatch } : {}) });
  }
  return host.request<WriteResult>(
    "openai/resources/write",
    { uri, blob: bytesToBase64(bytes), ...(ifMatch ? { ifMatch } : {}) },
    FILE_TIMEOUT_MS,
  );
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const EXPORT_URL = `${SERVER}/exports`;
const TIMING_URL = `${SERVER}/timing`;

/** Report how long one editor load took. Numbers and a flag only; a lost report changes nothing. */
export function reportTiming(timing: { page: number; read: number; show: number; connect: number; bytes: number; hidden: boolean }): void {
  fetch(TIMING_URL, { method: "POST", body: JSON.stringify(timing) }).catch(() => {});
}

/**
 * Export the edited copy; uploaded files cannot overwrite their source attachment.
 * The Codex app cancels every download that starts inside the app, and ignores the
 * MCP Apps `ui/download-file` request, so the first path hands the host a link to
 * open in the user's browser. Each path that fails hands over to the next one. The
 * browser download cannot report whether the host cancelled it, so reaching it after
 * other paths failed returns a warning for the status bar.
 */
export async function downloadDocx(file: HostFile, bytes: Uint8Array): Promise<string | null> {
  // A page of its own has no host to ask, and its browser downloads work.
  if (standalone) { exportThroughBrowser(file, bytes); return null; }
  const failures: string[] = [];
  for (const exportCopy of [exportThroughLink, exportThroughChatGpt, exportThroughBrowser]) {
    try {
      await exportCopy(file, bytes);
      return exportCopy === exportThroughBrowser && failures.length ? `Download may not have started: ${failures.join("; ")}` : null;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Export failed: ${failures.join("; ")}. Keep this editor open to keep your edits.`);
}

/** Put a copy on the server for one download within 90 seconds, and return its link. */
export async function exportLink(file: HostFile, bytes: Uint8Array): Promise<string> {
  const response = await fetch(`${EXPORT_URL}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: new Uint8Array(bytes) });
  if (!response.ok) throw new Error(`the server refused the copy (${response.status})`);
  return (await response.json() as { url: string }).url;
}

async function exportThroughLink(file: HostFile, bytes: Uint8Array): Promise<void> {
  const url = await exportLink(file, bytes);
  const opened = await host.request<{ isError?: boolean }>("ui/open-link", { url }, FILE_TIMEOUT_MS);
  if (opened?.isError) throw new Error("the host would not open the download link");
}

async function exportThroughChatGpt(file: HostFile, bytes: Uint8Array): Promise<void> {
  const openai = (window as unknown as { openai?: {
    uploadFile?: (file: File) => Promise<{ fileId: string }>;
    getFileDownloadUrl?: (input: { fileId: string }) => Promise<{ downloadUrl: string }>;
    openExternal?: (input: { href: string }) => void;
  } }).openai;
  if (!openai?.uploadFile || !openai.getFileDownloadUrl || !openai.openExternal) throw new Error("the host has no file API");
  const { fileId } = await openai.uploadFile(new File([new Uint8Array(bytes)], file.name, { type: DOCX_MIME }));
  const { downloadUrl } = await openai.getFileDownloadUrl({ fileId });
  openai.openExternal({ href: downloadUrl });
}

function exportThroughBrowser(file: HostFile, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new File([new Uint8Array(bytes)], file.name, { type: DOCX_MIME }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function callServer<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (standalone) return callServerDirectly<T>(name, args);
  const result = await host.request<{ content: Array<{ text: string }>; structuredContent?: T; isError?: boolean }>(
    "tools/call", { name, arguments: args }, FILE_TIMEOUT_MS,
  );
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

/** A page of its own calls the server's MCP endpoint itself. */
async function callServerDirectly<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SERVER}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  const text = await response.text();
  // The answer is JSON, or one server-sent event that holds the JSON.
  const json = text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data: "))!.slice(6);
  const { result, error } = JSON.parse(json) as { result?: { content: Array<{ text: string }>; structuredContent?: T; isError?: boolean }; error?: { message: string } };
  if (error) throw new Error(error.message);
  if (result!.isError) throw new Error(result!.content[0].text);
  return result!.structuredContent ?? JSON.parse(result!.content[0].text);
}

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode with one argument per byte overflows the stack on large files.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
