import { randomUUID, createHash } from "node:crypto";
import { access, readFile, realpath, writeFile, stat, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, extname } from "node:path";

const etag = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Local stdio only. Each opaque URI grants access to one explicitly opened file. */
export class LocalFiles {
  private readonly files = new Map<string, string>();
  private writes: Promise<unknown> = Promise.resolve();

  async open(fileUri: string) {
    const path = await realpath(fileURLToPath(fileUri));
    if (extname(path).toLowerCase() !== ".docx") throw new Error("Choose a .docx file.");
    await access(path, constants.R_OK);
    const resourceUri = `word-local://${randomUUID()}`;
    this.files.set(resourceUri, path);
    return { name: basename(path), resourceUri };
  }

  private path(uri: string): string {
    const path = this.files.get(uri);
    if (!path) throw new Error("This file handle has expired. Open the document again.");
    return path;
  }

  async read(uri: string) {
    const path = this.path(uri);
    const bytes = await readFile(path);
    let writable = true;
    try { await access(path, constants.W_OK); } catch { writable = false; }
    return { blob: bytes.toString("base64"), etag: etag(bytes), writable };
  }

  write(uri: string, blob: string, ifMatch?: string) {
    const result = this.writes.then(() => this.save(uri, blob, ifMatch));
    this.writes = result.catch(() => {});
    return result;
  }

  private async save(uri: string, blob: string, ifMatch?: string) {
    const path = this.path(uri);
    const current = await readFile(path);
    if (ifMatch && ifMatch !== etag(current)) return { outcome: "conflict", etag: etag(current) };
    const bytes = Buffer.from(blob, "base64");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: (await stat(path)).mode });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return { outcome: "saved", etag: etag(bytes) };
  }
}
