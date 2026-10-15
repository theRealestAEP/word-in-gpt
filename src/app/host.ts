import { createAppTransport } from "@openai/mcp-extensions/app/transport";

/** JSON-RPC link to the ChatGPT / Codex host that renders this app. */
export const host = createAppTransport();

/** The file the host passes when the user opens a .docx. */
export type HostFile = { name: string; resourceUri: string };

const uploadedFiles = new Map<string, FileSnapshot>();
const uploadUrls = new Map<string, string>();
export const isUploadedFile = (uri: string): boolean => uri.startsWith("word-upload://");

export function receiveUpload(file: HostFile, blob?: string, downloadUrl?: string): void {
  if (blob) uploadedFiles.set(file.resourceUri, { bytes: base64ToBytes(blob), etag: "0", writable: true });
  if (downloadUrl) uploadUrls.set(file.resourceUri, downloadUrl);
}

export type FileSnapshot = { bytes: Uint8Array; etag: string | null; writable: boolean };

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

/** Export the edited copy; uploaded files cannot overwrite their source attachment. */
export async function downloadDocx(file: HostFile, bytes: Uint8Array): Promise<void> {
  const copy = new File([new Uint8Array(bytes)], file.name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const openai = (window as unknown as { openai?: {
    uploadFile?: (file: File) => Promise<{ fileId: string }>;
    getFileDownloadUrl?: (input: { fileId: string }) => Promise<{ downloadUrl: string }>;
    openExternal?: (input: { href: string }) => void;
  } }).openai;
  if (openai?.uploadFile && openai.getFileDownloadUrl && openai.openExternal) {
    const { fileId } = await openai.uploadFile(copy);
    const { downloadUrl } = await openai.getFileDownloadUrl({ fileId });
    openai.openExternal({ href: downloadUrl });
    return;
  }
  const url = URL.createObjectURL(copy);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function callServer<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await host.request<{ content: Array<{ text: string }>; structuredContent?: T; isError?: boolean }>(
    "tools/call", { name, arguments: args }, FILE_TIMEOUT_MS,
  );
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
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
