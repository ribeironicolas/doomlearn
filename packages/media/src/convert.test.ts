import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { convert } from "./convert.ts";
import { Refused } from "@doomlearn/core/media";

/**
 * Small fixture books: a 4-page PDF with an outline (Preface p1, Threads p2 with section Sharing p3, Locks p4),
 * a PDF where 2 of 3 pages are only an image, and an ebook (Threads with section Sharing, Locks) as `.epub`
 * and `.azw3`, the same as an `.epub` whose TOC is one "Beginning" entry and whose chapters open their files
 * with a styled `<div>` (after a printed contents page listing them and their section), plus DRM'd copies of it (an encrypted MOBI header, an EPUB with ADEPT encryption).
 */
const fixture = (name: string) => fileURLToPath(new URL(`test/fixtures/${name}`, import.meta.url));

/**
 * Calibre and pymupdf4llm (its venv set up by `pnpm bootstrap`) run for real only on demand.
 */
const real = { skip: !process.env.DOOMLEARN_REAL_MEDIA, timeout: 120_000 };

test("an ebook whose MOBI header is encrypted is refused as DRM before Calibre runs", async () => {
  await assert.rejects(convert(fixture("drm.azw3")), new Refused("DRM-protected ebook: its MOBI header is encrypted"));
});

test("a text-layer PDF splits at its top-level outline entries, each page marked with its number", real, async () => {
  const { title, chapters } = await convert(fixture("book.pdf"));

  assert.equal(title, "Tiny Concurrency");
  assert.deepEqual(
    chapters.map((chapter) => [
      chapter.title,
      [...chapter.text.matchAll(/<!-- page (\d+) -->/g)].map((page) => Number(page[1])),
    ]),
    [
      ["Preface", [1]],
      ["Threads", [2, 3]],
      ["Locks", [4]],
    ],
  );
  assert.match(chapters[1].text, /<!-- page 3 -->\nThreads share the address space/);
});

test("a PDF with most pages lacking a text layer is refused as scanned", real, async () => {
  await assert.rejects(convert(fixture("scanned.pdf")), new Refused("Scanned PDF: 2 of 3 pages have no text layer"));
});

for (const type of ["epub", "azw3"]) {
  test(
    `an .${type} converts to plain text split at its top-level TOC chapters, sections marked as headings`,
    real,
    async () => {
      const { title, chapters } = await convert(fixture(`book.${type}`));

      assert.equal(title, "Tiny Locks");
      assert.deepEqual(
        chapters.map((chapter) => chapter.title),
        ["Threads", "Locks"],
      );
      assert.match(
        chapters[0].text,
        /^\s*Threads\n[\s\S]*A thread is one sequence[\s\S]*\nSharing\n[\s\S]*address space of their process & its heap\./,
      );
      assert.match(chapters[0].text, /\n## Sharing\n/);
      assert.match(chapters[1].text, /A lock lets only one thread into a critical section\./);
    },
  );
}

test(
  "an ebook whose TOC has a single entry splits at the styled block that opens each of its files, sections marked from its printed contents",
  real,
  async () => {
    const { chapters } = await convert(fixture("flat-toc.epub"));

    assert.deepEqual(
      chapters.map((chapter) => chapter.title),
      ["flat-toc", "Chapter 1: Threads", "Chapter 2: Locks"],
    );
    assert.match(chapters[0].text, /Table of Contents/);
    assert.match(chapters[1].text, /A thread is one sequence[\s\S]*\n## Sharing\n[\s\S]*its heap\./);
    assert.match(chapters[2].text, /A lock lets only one thread into a critical section\./);
  },
);

test("an ebook Calibre refuses to convert is refused as DRM", real, async () => {
  await assert.rejects(
    convert(fixture("drm.epub")),
    (error) =>
      error instanceof Refused && /^DRM-protected or unreadable ebook: Calibre failed \(.*DRM/.test(error.message),
  );
});
