import { createAppTransport } from "@openai/mcp-extensions/app/transport";

/** JSON-RPC link to the ChatGPT / Codex host that renders this app. */
export const host = createAppTransport();

/** The file the host passes when the user opens a .docx. */
export type HostFile = { name: string; resourceUri: string };

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

export function isHostFile(value: unknown): value is HostFile {
  const file = value as HostFile | undefined;
  return typeof file?.name === "string" && typeof file.resourceUri === "string";
}

export async function readFile(uri: string): Promise<FileSnapshot> {
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
  if (uri.startsWith("word-local://")) {
    return callServer("word_local_write", { uri, blob: bytesToBase64(bytes), ...(ifMatch ? { ifMatch } : {}) });
  }
  return host.request<WriteResult>(
    "openai/resources/write",
    { uri, blob: bytesToBase64(bytes), ...(ifMatch ? { ifMatch } : {}) },
    FILE_TIMEOUT_MS,
  );
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
