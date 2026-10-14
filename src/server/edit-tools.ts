import { agentCapabilities } from "@wordinweb/agent";
import { z } from "zod";

const toolName = (kind: string) => `word_document_${kind.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`;
const revision = z.string().min(1).describe("Revision returned by inspecting or projecting the open document.");

// Publish each edit with its own closed schema. The editor still validates and
// applies it through the library's transaction API.
export const EDIT_TOOLS: {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  operation: (args: Record<string, unknown>) => Record<string, unknown>;
}[] = agentCapabilities().filter(tool => tool.kind !== "tableOp").map(tool => ({
  name: toolName(tool.kind),
  description: tool.description,
  inputSchema: (z.fromJSONSchema(tool.inputSchema) as z.ZodObject).omit({ kind: true }).extend({ revision }),
  operation: (args: Record<string, unknown>) => ({ ...args, kind: tool.kind }),
}));

const table = agentCapabilities(undefined, "tableOp")[0];
const tableSchema = z.fromJSONSchema(table.inputSchema) as z.ZodObject;
const tableTarget = tableSchema.omit({ kind: true, op: true }).extend({ revision });
const tableActions = {
  deleteRow: "Delete the table row containing the selected cell.",
  deleteCol: "Delete the table column containing the selected cell.",
  deleteTable: "Delete the table containing the selected cell.",
  rowAbove: "Insert a table row above the selected cell.",
  rowBelow: "Insert a table row below the selected cell.",
  colLeft: "Insert a table column to the left of the selected cell.",
  colRight: "Insert a table column to the right of the selected cell.",
  mergeRight: "Merge the selected table cell with the cell to its right.",
  mergeDown: "Merge the selected table cell with the cell below it.",
  splitCell: "Split the selected table cell.",
};
for (const [op, description] of Object.entries(tableActions)) {
  EDIT_TOOLS.push({
    name: toolName(`table_${op}`), description, inputSchema: tableTarget,
    operation: (args: Record<string, unknown>) => ({ ...args, kind: "tableOp", op }),
  });
}

const tableValues = [
  { kind: "cellShading", description: "Set or clear the selected table cell's fill color." },
  { kind: "cellVAlign", description: "Set vertical text alignment in the selected table cell." },
  { kind: "textWrapping", description: "Set the selected table's text wrapping and position." },
];
const variants = (table.inputSchema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).op.anyOf;
for (const { kind, description } of tableValues) {
  const variant = variants.find(schema => (schema.properties as Record<string, { const: string }> | undefined)?.kind.const === kind)!;
  const valueSchema = (z.fromJSONSchema(variant) as z.ZodObject).omit({ kind: true });
  EDIT_TOOLS.push({
    name: toolName(`table_${kind}`), description,
    inputSchema: tableTarget.extend(valueSchema.shape),
    operation: ({ cellRef, suggest, ...values }: Record<string, unknown>) => ({
      kind: "tableOp", cellRef, ...(suggest === undefined ? {} : { suggest }), op: { kind, ...values },
    }),
  });
}
