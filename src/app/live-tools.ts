import { AgentDocument, type AgentProjectResult } from "@wordinweb/agent";

// The @wordinweb/agent tools the model gets while a document is open. Saving
// is automatic, and asset bytes as base64 only spend the model's context.
const LIVE_TOOL_NAMES = [
  "word_document_capabilities",
  "word_document_inspect",
  "word_document_edit",
  "word_document_project",
  "word_document_patch",
];

/** Tool definitions for the host's `tools/list`. The schemas are the same for every document. */
export const LIVE_TOOLS = AgentDocument.create()
  .tools()
  .filter((tool) => LIVE_TOOL_NAMES.includes(tool.name))
  .map(({ name, description, inputSchema }) => ({
    name, inputSchema,
    description: description + (name === "word_document_project"
      ? " Defaults to text mode: a compact content view for fast wording edits. Use project then patch; formatting inspection and capabilities are unnecessary for this path."
      : name === "word_document_patch"
        ? " Defaults to text mode: change wording while retaining existing styles. Use the revision and window from project. Choose md explicitly for heading or list changes."
        : ""),
  }));

export type LiveToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Runs the live tools against one open document. */
export function liveToolHandler(agent: AgentDocument): LiveToolCall {
  const tools = new Map(agent.tools().map((tool) => [tool.name, tool]));
  const issued = new Set<string>();
  return async (name, args) => {
    const tool = LIVE_TOOL_NAMES.includes(name) ? tools.get(name) : undefined;
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    // A reload from disk creates a new document whose revisions restart at 0.
    // A revision the model saw before the reload could then equal a new one and
    // skip the stale-target check, so accept only revisions this document issued.
    if (typeof args.revision === "string" && !issued.has(args.revision)) {
      throw new Error("That revision is not from the open document. The file was reloaded; inspect it again.");
    }
    const callArgs = name === "word_document_project" || name === "word_document_patch" ? { mode: "text", ...args } : args;
    const result = await tool.execute(callArgs);
    const revision = (result as { revision?: unknown }).revision;
    if (typeof revision === "string") issued.add(revision);
    if (name === "word_document_project" && callArgs.mode === "text") {
      const projection = result as AgentProjectResult;
      return { ...projection, anchors: projection.anchors.map(({ line, role, blockRef, editable }) => ({ line, role, blockRef, editable })) };
    }
    return result;
  };
}
