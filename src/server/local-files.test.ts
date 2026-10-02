import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { LocalFiles } from "./local-files.ts";

it("grants one explicit local file and prevents conflicting saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "word-local-test-"));
  try {
    const path = join(dir, "test.docx");
    await writeFile(path, "original");
    const files = new LocalFiles();
    const { resourceUri } = await files.open(pathToFileURL(path).href);
    const snapshot = await files.read(resourceUri);
    const [first, second] = await Promise.all([
      files.write(resourceUri, Buffer.from("first edit").toString("base64"), snapshot.etag),
      files.write(resourceUri, Buffer.from("second edit").toString("base64"), snapshot.etag),
    ]);
    expect(first.outcome).toBe("saved");
    expect(second.outcome).toBe("conflict");
    expect(await readFile(path, "utf8")).toBe("first edit");
    await expect(files.read(pathToFileURL(path).href)).rejects.toThrow("handle has expired");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
