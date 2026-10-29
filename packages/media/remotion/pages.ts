import { createTikTokStyleCaptions, type Caption, type TikTokPage } from "@remotion/captions";

/**
 * A spoken word in its shown spelling and where it sits in the narration audio; same as `Word` in packages/core/src/media.ts.
 */
export type Word = { word: string; startMs: number; endMs: number };

/**
 * The most words a caption page holds.
 */
const PAGE_WORDS = 4;

/**
 * Caption pages of up to 4 words; a sentence end (. ? ! :) always closes the page.
 */
export function captionPages(words: Word[]) {
  let inPage = 0;
  const captions: Caption[] = words.map((word, i) => {
    inPage++;
    const pageBreakAfter = /[.?!:]$/.test(word.word) || inPage === PAGE_WORDS;
    if (pageBreakAfter) inPage = 0;
    // A leading space is how createTikTokStyleCaptions separates words.
    return {
      text: (i ? " " : "") + word.word,
      startMs: word.startMs,
      endMs: word.endMs,
      timestampMs: null,
      confidence: null,
      pageBreakAfter,
    };
  });
  // A huge combine window, so pages are cut only by pageBreakAfter above.
  return createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: 60_000 }).pages;
}

/**
 * The page on screen at `ms` and its active word: the last one already started,
 * so it stays lit through pauses and zero-length words.
 */
export function captionAt(pages: TikTokPage[], ms: number) {
  const page = pages.findLast((candidate) => candidate.startMs <= ms);
  return page && { page, active: page.tokens.findLastIndex((token) => token.fromMs <= ms) };
}
