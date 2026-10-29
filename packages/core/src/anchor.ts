import type { Anchor } from "./schema.ts";

/**
 * A Markdown heading line: its level and its title.
 */
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Slices a Passage from the text of the chapter being extracted, at its anchor.
 * A page range runs from the `<!-- page first -->` line to the next page after `last`.
 * A chapter anchor is the whole chapter; with a section, it runs from that heading to the next
 * heading of the same or a higher level. Returns undefined when the anchor's text isn't in the chapter.
 */
export function sliceAnchor(chapter: string, anchor: Anchor) {
  const lines = chapter.split("\n");
  if ("pages" in anchor) {
    const [first, last] = anchor.pages;
    /** The line marking page `n`. */
    const page = (n: number) => lines.indexOf(`<!-- page ${n} -->`);
    const start = page(first);
    if (start === -1 || last < first) return undefined;
    const end = lines.findIndex((line, i) => i > start && Number(line.match(/^<!-- page (\d+) -->$/)?.[1]) > last);
    return lines
      .slice(start, end === -1 ? undefined : end)
      .join("\n")
      .trim();
  }
  if (!anchor.section) return chapter.trim() || undefined;
  const headings = lines.map((line) => line.match(HEADING));
  const start = headings.findIndex((heading) => heading?.[2].toLowerCase() === anchor.section!.trim().toLowerCase());
  if (start === -1) return undefined;
  const level = headings[start]![1].length;
  const end = headings.findIndex((heading, i) => i > start && heading && heading[1].length <= level);
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}
