//
// The word rules that the server and the PWA's fix sheet share. No imports, so the PWA can import it.
//

/**
 * Splits a token into leading punctuation, its word, and trailing punctuation.
 */
export function splitPunctuation(token: string) {
  const [, lead, word, trail] = token.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u)!;
  return { lead, word, trail };
}

/**
 * Whether `respelling` can be a Respelling: narration needs a letter or a digit to time.
 */
export const speakable = (respelling: string) => /[\p{L}\p{N}]/u.test(respelling);
