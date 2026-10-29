import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Chapter, type Converted, Refused } from "@doomlearn/core/media";
import { oneShotTool } from "./tools.ts";

const run = promisify(execFile);
const PYTHON = fileURLToPath(new URL("../python/convert/", import.meta.url));
/**
 * Byte offsets in a MOBI-family header: where record 0's offset is stored, and the encryption type within record 0.
 */
const MOBI = { record0At: 78, encryptionAt: 12 };

/**
 * Splits a Source into chapters: a PDF by its outline, an ebook by its TOC, `.md`/`.txt` by headings.
 * Text before the first chapter is a chapter titled `name`, the file's name unless given.
 * Throws `Refused` for a scanned PDF or a DRM'd ebook.
 */
export async function convert(file: string, name = basename(file, extname(file))): Promise<Converted> {
  const type = extname(file).slice(1).toLowerCase();
  if (type === "pdf") return pdf(file, name);
  if (type === "epub" || type === "azw3") return ebook(file, type, name);

  const chapters: Chapter[] = [];
  // Each top-level heading starts a chapter; text before the first one is a chapter named after the file.
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const heading = line.match(/^# (.+)/);
    if (heading || !chapters.length) chapters.push({ title: heading?.[1].trim() ?? name, text: "" });
    if (!heading) chapters[chapters.length - 1].text += `${line}\n`;
  }
  return { chapters: chapters.filter((chapter) => chapter.text.trim()) };
}

/**
 * Splits a PDF into chapters by its outline, through `python/convert/pdf.py`.
 */
async function pdf(file: string, name: string): Promise<Converted> {
  const { title, toc, pages, textless } = await oneShotTool("convert", [file]);
  // Provisional threshold: more than half the pages without a text layer means a scan.
  if (textless > pages.length / 2)
    throw new Refused(`Scanned PDF: ${textless} of ${pages.length} pages have no text layer`);

  // Each top-level outline entry starts a chapter that runs to the next one; pages before the first
  // are a chapter named after the file. An entry pointing at no page (-1) is skipped.
  const starts = [
    { title: name, page: 1 },
    ...toc.filter(([level, , page]) => level === 1 && page >= 1).map(([, title, page]) => ({ title, page })),
  ];
  const chapters = starts.map((start, i) => {
    const end = (starts[i + 1]?.page ?? pages.length + 1) - 1;
    const text = pages
      .slice(start.page - 1, end)
      .map((page, j) => `<!-- page ${start.page + j} -->\n${page}`)
      .join("\n");
    return { title: start.title, text };
  });
  return { title: title || undefined, chapters: chapters.filter((chapter) => chapter.text) };
}

/**
 * Splits an EPUB or AZW3 ebook into chapters by its TOC, through Calibre. Throws `Refused` for a DRM'd AZW3.
 */
async function ebook(file: string, type: "epub" | "azw3", name: string): Promise<Converted> {
  if (type === "azw3") {
    // A MOBI-family header says whether the text is encrypted: record 0 holds the encryption type.
    const bytes = await readFile(file);
    if (bytes.readUInt16BE(bytes.readUInt32BE(MOBI.record0At) + MOBI.encryptionAt) !== 0)
      throw new Refused("DRM-protected ebook: its MOBI header is encrypted");
  }
  const dir = await mkdtemp(join(tmpdir(), "doomlearn-convert-"));
  try {
    const marked = join(dir, `marked.${type}`);
    let toc: { level: number; title: string }[];
    let title: string;
    try {
      const { stdout } = await run("calibre-debug", ["-e", join(PYTHON, "ebook.py"), file, marked], {
        maxBuffer: Infinity,
      });
      // Calibre may log progress before the JSON line.
      ({ toc, title } = JSON.parse(stdout.trim().split("\n").at(-1)!));
      // Plain text, never Calibre Markdown: it escapes characters and breaks the verbatim Passage check.
      await run("ebook-convert", [marked, join(dir, "book.txt")], { maxBuffer: Infinity });
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? error).trim();
      throw new Refused(`DRM-protected or unreadable ebook: Calibre failed (${stderr.split("\n").at(-1)})`);
    }

    // ebook.py put a line ⟦n⟧ where TOC entry n starts: a top-level entry starts a chapter,
    // a deeper one is a section inside it, marked by a Markdown heading of its level so a Passage
    // can be sliced at it. Text before the first chapter is one named after the file.
    const chapters: Chapter[] = [{ title: name, text: "" }];
    for (const line of (await readFile(join(dir, "book.txt"), "utf8")).split("\n")) {
      const marker = line.trim().match(/^⟦(\d+)⟧$/);
      const entry = marker && toc[Number(marker[1])];
      if (!entry) chapters[chapters.length - 1].text += `${line}\n`;
      else if (entry.level === 1) chapters.push({ title: entry.title, text: "" });
      else chapters[chapters.length - 1].text += `${"#".repeat(entry.level)} ${entry.title}\n`;
    }
    // Calibre reports a book without a title as "Unknown".
    return {
      title: title === "Unknown" ? undefined : title,
      chapters: chapters.filter((chapter) => chapter.text.trim()),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
