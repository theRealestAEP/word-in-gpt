import { readFileSync } from "node:fs";
import { AgentDocument, LocalDocumentSession, type AgentReadResult, type AgentContextResult, type AgentProjectResult, type AgentPatchResult } from "@wordinweb/agent";
import { expect, it } from "vitest";
import { selectionContext } from "./selection.ts";
import { liveToolHandler } from "./live-tools.ts";

const fixture = readFileSync(new URL("../../publication/fixtures/review.docx", import.meta.url));

it("shares exact selected text and edit addresses across Word runs and paragraphs", () => {
  const session = new LocalDocumentSession(fixture);
  const agent = AgentDocument.connect(session);
  agent.inspect({ kind: "context" });
  // A Word run can contain several text nodes separated by tabs and breaks.
  const run = session.doc.stableIds!.elOf(2)!;
  run.children = [
    { name: "w:t", attrs: {}, children: [], text: "Alpha" },
    { name: "w:tab", attrs: {}, children: [], text: "" },
    { name: "w:t", attrs: {}, children: [], text: "Beta" },
    { name: "w:br", attrs: {}, children: [], text: "" },
    { name: "w:t", attrs: {}, children: [], text: "Gamma" },
  ];
  session.noteHistory();
  expect(selectionContext(session, [
    { blockId: 1, runId: 2, start: 2, end: 8 },
    { blockId: 1, runId: 2, start: 8, end: 13 },
    { blockId: 3, runId: 4, start: 0, end: 7 },
  ])).toEqual({
    revision: "1", text: "pha\tBeta\nGa\nRevenue", possiblyTruncated: false,
    ranges: [
      { blockRef: "block:1", runRef: "run:2", start: 2, end: 8 },
      { blockRef: "block:1", runRef: "run:2", start: 8, end: 13 },
      { blockRef: "block:3", runRef: "run:4", start: 0, end: 7 },
    ],
  });
});

it("plain text patches retain heading style, alignment and run formatting", async () => {
  const agent = AgentDocument.load(fixture);
  const inspected = agent.inspect({ kind: "context" });
  await agent.edit({ revision: inspected.revision, operations: [
    { kind: "formatParagraph", blockRef: "block:1", align: "center" },
  ] });
  const before = (agent.inspect({ kind: "read" }) as AgentReadResult).blocks[0];
  if (before.type !== "paragraph") throw new Error("Expected a heading paragraph");
  const paragraphProps = structuredClone(agent.document.sections[0].blocks[0].props);
  const callTool = liveToolHandler(agent);
  const projection = await callTool("word_document_project", {}) as AgentProjectResult;
  expect(projection.mode).toBe("text");
  expect(projection.anchors[0]).toEqual({ line: 1, role: "paragraph", blockRef: "block:1", editable: true });
  const result = await callTool("word_document_patch", { revision: projection.revision, edits: [
    { startLine: 1, endLine: 1, newText: "Annual review" },
  ] }) as AgentPatchResult;
  expect(result.status).toBe("applied");
  const after = (agent.inspect({ kind: "read" }) as AgentReadResult).blocks[0];
  if (after.type !== "paragraph") throw new Error("Expected a heading paragraph");
  expect(after).toMatchObject({ text: "Annual review", styleId: "Heading1" });
  expect(agent.document.sections[0].blocks[0].props).toEqual(paragraphProps);
  expect(after.runs[0].formatting).toEqual(before.runs[0].formatting);
  expect((agent.inspect({ kind: "context" }) as AgentContextResult).contents[0].blocks[1]).toMatchObject({ text: "Revenue increased this quarter." });
});
