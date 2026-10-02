import { AgentDocument, LocalDocumentSession } from "@wordinweb/agent";
import { host, readFile, writeFile, type FileSnapshot, type HostFile } from "./host.ts";
import { liveToolHandler, type LiveToolCall } from "./live-tools.ts";
import { selectionContext, type SelectionRange } from "./selection.ts";

const AUTOSAVE_DELAY_MS = 1000;

/** One load of the file. A reload from disk replaces it. */
export type OpenDocument = {
  id: number;
  session: LocalDocumentSession;
  callTool: LiveToolCall;
};

export type EditorState = {
  file: HostFile | null;
  doc: OpenDocument | null;
  status: string;
  /** The file changed on disk while this view had unsaved edits. */
  conflict: boolean;
  connection: string;
};

/**
 * Keeps the open document and the file on disk in step.
 *
 * The user (through DocxView) and the model (through the live tools) edit the
 * same LocalDocumentSession. Every edit schedules a save through the host. When
 * the file changes on disk, the view reloads it, unless the view has unsaved
 * edits. Then the user chooses which version to keep.
 */
export class EditorController {
  state: EditorState = { file: null, doc: null, status: "Waiting for a file", conflict: false, connection: "Connecting chat…" };
  private readonly listeners = new Set<() => void>();
  private etag: string | null = null;
  private writable = false;
  private edits = 0;
  private savedEdits = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  // Saves run one at a time: two writes with the same ifMatch would make the second one conflict.
  private saveQueue: Promise<void> = Promise.resolve();
  private nextId = 1;
  private editorContext = "";

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): EditorState => this.state;

  setConnection = (connection: string): void => { this.set({ connection }); };

  async connectChat(editorSessionId: string): Promise<void> {
    this.editorContext = `Word editor: ${this.state.file?.name}. Use the word_document_* MCP tools with editorSessionId ${editorSessionId}. Commands operate on this open document and changes autosave through the host.`;
    await this.updateModelContext();
    this.setConnection("Chat connected");
  }

  async shareSelection(ranges: SelectionRange[]): Promise<void> {
    const selection = selectionContext(this.state.doc!.session, ranges);
    await this.updateModelContext(`\nUser-selected document text and edit references: ${JSON.stringify(selection)}\nUse this selection when the user refers to highlighted text. For wording edits, refresh the text projection and patch only the selected text. For formatting edits, inspect its references to confirm the current revision. If possiblyTruncated is true, this contains up to 64 text ranges; inspect the surrounding section before treating it as the entire selection.`);
  }

  private async updateModelContext(selection = ""): Promise<void> {
    await host.request("ui/update-model-context", {
      content: [{ type: "text", text: this.editorContext + selection }],
    });
  }

  report = (error: unknown): void => {
    this.set({ status: error instanceof Error ? error.message : String(error) });
  };

  async open(file: HostFile): Promise<void> {
    if (this.state.file?.resourceUri === file.resourceUri) return;
    this.set({ file, status: "Loading" });
    if (!file.resourceUri.startsWith("word-local://")) await host.request("resources/subscribe", { uri: file.resourceUri });
    this.show(await readFile(file.resourceUri));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.state.doc) throw new Error("No document is open. Ask the user to open a .docx file.");
    return this.state.doc.callTool(name, args);
  }

  /** Counts a user or model edit and schedules a save. */
  noteEdit = (): void => {
    this.edits++;
    if (!this.writable) return;
    this.set({ status: "Unsaved changes" });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.queueSave(), AUTOSAVE_DELAY_MS);
  };

  async onFileChanged(uri: string): Promise<void> {
    if (uri !== this.state.file?.resourceUri) return;
    await this.saveQueue; // An in-flight save records its etag first.
    const snapshot = await readFile(uri);
    if (snapshot.etag !== null && snapshot.etag === this.etag) return; // Our own save.
    if (this.edits !== this.savedEdits) this.set({ conflict: true, status: "The file changed on disk" });
    else this.show(snapshot);
  }

  /** Conflict choice: drop the unsaved edits and show the file on disk. */
  async loadDiskVersion(): Promise<void> {
    this.show(await readFile(this.state.file!.resourceUri));
  }

  /** Conflict choice: write this view's version over the file on disk. */
  keepThisVersion(): void {
    this.etag = null;
    this.set({ conflict: false });
    this.queueSave();
  }

  /** Saves pending edits now. The host calls this before it closes the view. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.edits !== this.savedEdits) this.queueSave();
    await this.saveQueue;
  }

  private show(snapshot: FileSnapshot): void {
    clearTimeout(this.saveTimer);
    const session = new LocalDocumentSession(snapshot.bytes);
    // Model edits (and toolbar commands) go through session.submit, which notifies subscribers.
    session.subscribe(this.noteEdit);
    const agent = AgentDocument.connect(session, { provenance: { author: "ChatGPT" } });
    this.etag = snapshot.etag;
    this.writable = snapshot.writable;
    this.edits = 0;
    this.savedEdits = 0;
    this.set({
      doc: { id: this.nextId++, session, callTool: liveToolHandler(agent) },
      conflict: false,
      status: snapshot.writable ? "Saved" : "Read-only: edits stay in this view",
    });
  }

  private queueSave(): void {
    this.saveQueue = this.saveQueue.then(() => this.save()).catch(this.report);
  }

  private async save(): Promise<void> {
    const { doc, file, conflict } = this.state;
    if (!doc || !file || conflict || !this.writable || this.edits === this.savedEdits) return;
    const edits = this.edits;
    this.set({ status: "Saving" });
    const result = await writeFile(file.resourceUri, doc.session.doc.save(), this.etag);
    if (doc !== this.state.doc) return; // Reloaded while saving.
    if (result.outcome === "saved") {
      this.etag = result.etag;
      this.savedEdits = edits;
      this.set({ status: this.edits === this.savedEdits ? "Saved" : "Unsaved changes" });
    } else if (result.outcome === "conflict") {
      this.set({ conflict: true, status: "The file changed on disk" });
    } else {
      this.set({ status: `Not saved: the file is larger than the host limit of ${result.maxBytes} bytes` });
    }
  }

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
