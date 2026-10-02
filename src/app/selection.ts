import type { LocalDocumentSession } from "@wordinweb/agent";
import type { DocxViewProps } from "wordinweb";

export type PresencePosition = Parameters<NonNullable<NonNullable<DocxViewProps["collab"]>["setPresence"]>>[0];
export type SelectionRange = NonNullable<NonNullable<PresencePosition>["ranges"]>[number];
type XmlElement = Parameters<NonNullable<LocalDocumentSession["doc"]["stableIds"]>["idOf"]>[0];

// Selection offsets count text, tabs and breaks in each Word run.
function runText(element: XmlElement): string {
  switch (element.name.split(":").pop()) {
    case "t": return element.text;
    case "tab": return "\t";
    case "br": case "cr": return "\n";
    default: return element.children.map(runText).join("");
  }
}

export function selectionContext(session: LocalDocumentSession, ranges: SelectionRange[]) {
  let text = "";
  for (const [index, range] of ranges.entries()) {
    if (index > 0 && ranges[index - 1].blockId !== range.blockId) text += "\n";
    const run = session.doc.stableIds!.elOf(range.runId)!;
    text += runText(run).slice(range.start, range.end);
  }
  return {
    revision: String(session.getRevision()),
    text,
    // WordInWeb's presence API sends at most 64 ranges.
    possiblyTruncated: ranges.length === 64,
    ranges: ranges.map(({ blockId, runId, start, end }) => ({
      blockRef: `block:${blockId}`, runRef: `run:${runId}`, start, end,
    })),
  };
}
