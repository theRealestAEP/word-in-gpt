import { readFile } from "node:fs/promises";
import { AgentDocument } from "@wordinweb/agent";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("@openai/mcp-extensions/app/transport", () => ({ createAppTransport: () => ({ request }) }));
import { EditorController } from "./controller.ts";
import { receiveUpload, readFile as readUploadedFile } from "./host.ts";

afterEach(() => { vi.unstubAllGlobals(); request.mockClear(); });

async function openFixture(id: string) {
  const original = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const file = { name: "review.docx", resourceUri: `word-upload://${id}` };
  receiveUpload(file, original.toString("base64"));
  const controller = new EditorController();
  await controller.open(file);
  await controller.connectChat("00000000-0000-4000-8000-000000000001");
  return { controller, file, original };
}

it("restores attachment bytes from ChatGPT's persisted tool metadata after a reload", async () => {
  const original = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const file = { name: "review.docx", resourceUri: "word-upload://review-metadata-reload" };
  vi.stubGlobal("window", { openai: { toolResponseMetadata: { mcp_tool_result: {
    structuredContent: { file }, _meta: { fileBlob: original.toString("base64") },
  } } } });
  const controller = new EditorController();
  await controller.open(file);
  const context: any = await controller.callTool("word_document_inspect", { kind: "context" });
  expect(context.contents[0].blocks.map((block: any) => block.text)).toEqual(["Quarterly review", "Revenue increased this quarter."]);
  expect(request).not.toHaveBeenCalled();
});

it("reopens an authorized attachment through ChatGPT's file API when private metadata is absent", async () => {
  const original = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const file = { name: "review.docx", resourceUri: "word-upload://review-file-api-reload" };
  const getFileDownloadUrl = vi.fn().mockResolvedValue({ downloadUrl: "https://files.example/review.docx" });
  vi.stubGlobal("window", { openai: { getFileDownloadUrl } });
  const fetchFile = vi.fn().mockResolvedValue(new Response(original));
  vi.stubGlobal("fetch", fetchFile);
  const controller = new EditorController();
  await controller.open(file);
  expect(getFileDownloadUrl).toHaveBeenCalledWith({ fileId: "review-file-api-reload" });
  expect(fetchFile).toHaveBeenCalledWith("https://files.example/review.docx");
  expect(request).not.toHaveBeenCalled();
  const context: any = await controller.callTool("word_document_inspect", { kind: "context" });
  expect(context.contents[0].blocks.map((block: any) => block.text)).toEqual(["Quarterly review", "Revenue increased this quarter."]);
});

it("loads the opener's private URL directly even when the Work file ID is unavailable to the file API", async () => {
  const original = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const file = { name: "review.docx", resourceUri: "word-upload://review-direct-initial" };
  const getFileDownloadUrl = vi.fn().mockRejectedValue(new Error("Invalid file id"));
  vi.stubGlobal("window", { openai: { getFileDownloadUrl, toolResponseMetadata: { call_tool_result: {
    structuredContent: { file }, _meta: { fileDownloadUrl: "https://files.example/initial.docx" },
  } } } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(original)));
  const controller = new EditorController();
  await controller.open(file);
  expect((await readUploadedFile(file.resourceUri)).bytes).toEqual(new Uint8Array(original));
  expect(getFileDownloadUrl).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("refreshes an expired private URL through the host file API", async () => {
  const original = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const file = { name: "review.docx", resourceUri: "word-upload://review-expired-link" };
  receiveUpload(file, undefined, "https://files.example/expired.docx");
  const getFileDownloadUrl = vi.fn().mockResolvedValue({ downloadUrl: "https://files.example/fresh.docx" });
  vi.stubGlobal("window", { openai: { getFileDownloadUrl } });
  const fetchFile = vi.fn().mockResolvedValueOnce(new Response("expired", { status: 403 })).mockResolvedValueOnce(new Response(original));
  vi.stubGlobal("fetch", fetchFile);
  const controller = new EditorController();
  await controller.open(file);
  expect(fetchFile).toHaveBeenNthCalledWith(1, "https://files.example/expired.docx");
  expect(fetchFile).toHaveBeenNthCalledWith(2, "https://files.example/fresh.docx");
  expect(request).not.toHaveBeenCalled();
  expect((await readUploadedFile(file.resourceUri)).bytes).toEqual(new Uint8Array(original));
});

it.each(["browser restriction", "HTTP error"])("uses the attachment fallback after a %s", async (failure) => {
  const original = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const file = { name: "review.docx", resourceUri: `word-upload://review-fallback-${failure}` };
  const getFileDownloadUrl = vi.fn().mockResolvedValue({ downloadUrl: "https://files.example/fallback.docx" });
  vi.stubGlobal("window", { openai: { getFileDownloadUrl } });
  vi.stubGlobal("fetch", failure === "browser restriction"
    ? vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    : vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
  request.mockResolvedValueOnce({ _meta: { fileBlob: original.toString("base64") } });
  const controller = new EditorController();
  await controller.open(file);
  expect(request).toHaveBeenCalledWith("tools/call", {
    name: "word_attachment_read", arguments: { downloadUrl: "https://files.example/fallback.docx" },
  }, 60_000);
  expect((await readUploadedFile(file.resourceUri)).bytes).toEqual(new Uint8Array(original));
});

it("loads a streamed fallback link without receiving DOCX bytes through MCP", async () => {
  const original = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const file = { name: "review.docx", resourceUri: "word-upload://review-stream-fallback" };
  receiveUpload(file, undefined, "https://files.example/restricted.docx");
  vi.stubGlobal("window", {});
  const fetchFile = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(new Response(original));
  vi.stubGlobal("fetch", fetchFile);
  request.mockResolvedValueOnce({ _meta: { fileDownloadUrl: "https://worker.example/attachments/token" } });
  const controller = new EditorController();
  await controller.open(file);
  expect(fetchFile).toHaveBeenNthCalledWith(2, "https://worker.example/attachments/token");
  expect((await readUploadedFile(file.resourceUri)).bytes).toEqual(new Uint8Array(original));
});

it("allows a failed file opening to retry after its attachment bytes arrive", async () => {
  const original = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const file = { name: "review.docx", resourceUri: "word-upload://review-retry" };
  vi.stubGlobal("window", {});
  const controller = new EditorController();
  await expect(controller.open(file)).rejects.toThrow("Attach the DOCX again");
  expect(controller.state.connection).toBe("Document unavailable");
  receiveUpload(file, original.toString("base64"));
  await controller.open(file);
  const context: any = await controller.callTool("word_document_inspect", { kind: "context" });
  expect(context.contents[0].blocks[0].text).toBe("Quarterly review");
});

it("runs submitted read, search, and wording cases on an uploaded copy and exports preserved styles", async () => {
  const { controller, file, original } = await openFixture("review-text");
  expect(controller.state.connection).toBe("Chat connected");
  expect(request.mock.calls.some(([method]) => method === "resources/subscribe")).toBe(false);
  const context: any = await controller.callTool("word_document_inspect", { kind: "context" });
  expect(context.contents[0].blocks.map((block: any) => block.text)).toEqual(["Quarterly review", "Revenue increased this quarter."]);
  const search: any = await controller.callTool("word_document_inspect", { kind: "search", query: "Revenue" });
  expect(search.matches).toHaveLength(1);
  expect(search.matches[0].excerpt).toBe("Revenue increased this quarter.");
  const before: any = await controller.callTool("word_document_inspect", { kind: "read", story: "body" });
  const projection: any = await controller.callTool("word_document_project", { story: "body", mode: "text" });
  await controller.callTool("word_document_patch", {
    revision: projection.revision, story: projection.story, mode: "text", cursor: projection.window.cursor,
    edits: [{ startLine: 2, endLine: 2, newText: "Revenue grew this quarter." }],
  });
  await controller.flush();
  expect(controller.state.status).toBe("Edited copy ready to download");
  const saved = await readUploadedFile(file.resourceUri);
  const reopened: any = await AgentDocument.load(saved.bytes).inspect({ kind: "read", story: "body" });
  const blocks: any[] = reopened.blocks;
  expect(blocks.map(block => block.text)).toEqual(["Quarterly review", "Revenue grew this quarter."]);
  expect(blocks[0].styleId).toBe("Heading1");
  expect(blocks[0].runs[0].formatting).toEqual(before.blocks[0].runs[0].formatting);
  expect(blocks[1].runs[0].formatting).toEqual(before.blocks[1].runs[0].formatting);
  expect(await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url))).toEqual(original);

  const uploadFile = vi.fn(async (file: File) => {
    const exported = AgentDocument.load(new Uint8Array(await file.arrayBuffer()));
    const context: any = await exported.inspect({ kind: "context" });
    expect(context.contents[0].blocks[1].text).toBe("Revenue grew this quarter.");
    return { fileId: "file_edited" };
  });
  const getFileDownloadUrl = vi.fn().mockResolvedValue({ downloadUrl: "https://files.example/edited.docx" });
  const openExternal = vi.fn();
  vi.stubGlobal("window", { openai: { uploadFile, getFileDownloadUrl, openExternal } });
  await controller.download();
  expect(getFileDownloadUrl).toHaveBeenCalledWith({ fileId: "file_edited" });
  expect(openExternal).toHaveBeenCalledWith({ href: "https://files.example/edited.docx" });
});

it("runs the submitted heading-centering case and preserves text in the exported DOCX", async () => {
  const { controller, file } = await openFixture("review-format");
  const context: any = await controller.callTool("word_document_inspect", { kind: "context" });
  const capabilities: any = await controller.callTool("word_document_capabilities", { kind: "formatParagraph" });
  expect(capabilities[0].kind).toBe("formatParagraph");
  await controller.callTool("word_document_edit", { revision: context.revision, operations: [{
    kind: "formatParagraph", blockRef: context.contents[0].blocks[0].ref, align: "center",
  }] });
  await controller.flush();
  const saved = await readUploadedFile(file.resourceUri);
  const reopened: any = await AgentDocument.load(saved.bytes).inspect({ kind: "read", story: "body" });
  expect(reopened.blocks[0].alignment).toBe("center");
  expect(reopened.blocks.map((block: any) => block.text)).toEqual(["Quarterly review", "Revenue increased this quarter."]);
  expect(reopened.blocks[0].styleId).toBe("Heading1");
});

it("answers the model at once with the reason when an attachment cannot load", async () => {
  const file = { name: "review.docx", resourceUri: "word-upload://review-dead-link" };
  receiveUpload(file, undefined, "https://oaisdmntprcentralus.blob.core.windows.net/expired.docx");
  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("expired", { status: 403 })));
  request.mockResolvedValueOnce({ _meta: { fileDownloadUrl: "https://worker.example/attachments/token" } });
  const controller = new EditorController();
  await expect(controller.open(file)).rejects.toThrow("Attach the DOCX again");
  await controller.connectChat("00000000-0000-4000-8000-000000000002");
  expect(controller.state.connection).toBe("Document unavailable");
  expect(request).toHaveBeenLastCalledWith("ui/update-model-context", {
    content: [{ type: "text", text: expect.stringContaining("review.docx could not be opened: The attachment could not be restored. Attach the DOCX again.") }],
  });
  await expect(controller.callTool("word_document_inspect", { kind: "context" }))
    .rejects.toThrow("The document could not be opened: The attachment could not be restored. Attach the DOCX again.");
});
