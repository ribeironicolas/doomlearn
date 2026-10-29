import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LANGUAGES } from "@doomlearn/core/languages";
import { speakable, splitPunctuation } from "@doomlearn/core/respelling";
import { BTN } from "./Feed.tsx";
import { CLS } from "./Screen.tsx";
import { type FixSheet as Sheet, orRefusal, type Preview, UNREACHABLE } from "./sync.ts";

/**
 * How often a preview's state is asked while the worker gets to it.
 */
const POLL_MS = 1000;

/**
 * A fix on the sheet: the words picked (indexes of the first and last), what the voice says for them now, the sound
 * typed, and its preview: a line saying where it is, or the wav to play.
 */
type Row = { id: number; first: number; last: number; says: string; sound: string; preview?: string; wav?: string };

/**
 * `text` without the punctuation around it, as a Lexicon key and narration match it.
 */
const bare = (text: string) => splitPunctuation(text).word;

/**
 * Fixes how the voice says words of a 🚩 Pronunciation Clip, as a bottom sheet over everything: its script as the
 * captions show it, where tapping a word starts a fix and tapping the next (or previous) word extends it. Each fix
 * starts with what the voice says now; ▶ Preview has the worker speak its sentence with every fix on the sheet, and
 * Save writes them to the Clip's Language Lexicon and regenerates the Clip. Tapping outside it closes it.
 */
export function FixSheet({
  eventId,
  title,
  onClose,
  onSaved,
}: {
  eventId: number;
  title: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: sheet, error: refused } = useQuery({
    queryKey: ["fix", eventId],
    queryFn: async (): Promise<Sheet> => (await orRefusal(`/api/fix?eventId=${eventId}`)).json(),
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>();
  // Each row's latest preview: an older one still polling stops once a newer one starts, or the sheet closes.
  const latest = useRef(new Map<number, number>());
  // The previews' wav URLs, released when the sheet closes.
  const wavs = useRef<string[]>([]);
  useEffect(
    () => () => {
      latest.current.clear();
      for (const wav of wavs.current) URL.revokeObjectURL(wav);
    },
    [],
  );
  const nextRow = useRef(0);

  if (!sheet)
    return createPortal(
      <Frame onClose={onClose}>{refused && <p className={CLS.meta}>{refused.message}</p>}</Frame>,
      document.body,
    );
  const { words } = sheet;
  /**
   * What the voice says now for words `first` to `last`: each chunk they are in, once.
   */
  const saysFor = (first: number, last: number) =>
    bare(
      [...new Set(words.slice(first, last + 1).map((word) => word.chunk))].map((chunk) => sheet.says[chunk]).join(" "),
    );
  /**
   * The term a row fixes: its words, each without the punctuation around it, as narration matches them.
   */
  const term = (row: Row) =>
    words
      .slice(row.first, row.last + 1)
      .map((word) => bare(word.text))
      .filter(Boolean)
      .join(" ");
  const fixes = rows.map((row) => ({ term: term(row), respelling: row.sound.trim() }));
  /**
   * Applies `change` to the row `id`.
   */
  const update = (id: number, change: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));

  /**
   * A tap on word `i` picks the chunk it is in, so a Lexicon term of several words is fixed whole. The pick extends
   * the last fix when it is just after or before it in the same beat, and starts a new fix otherwise. A script's own
   * `{shown|spoken}` term is never part of a longer fix: narration would not match it. A word already in a fix does
   * nothing.
   */
  const tap = (i: number) => {
    if (rows.some((row) => row.first <= i && i <= row.last)) return;
    const from = words.findIndex((word) => word.chunk === words[i].chunk);
    const to = words.findLastIndex((word) => word.chunk === words[i].chunk);
    const last = rows.at(-1);
    const next =
      last &&
      (from === last.last + 1 || to === last.first - 1) &&
      words[from].beat === words[last.first].beat &&
      !words.slice(Math.min(from, last.first), Math.max(to, last.last) + 1).some((word) => word.markup);
    if (!last || !next) {
      const says = saysFor(from, to);
      setRows([...rows, { id: nextRow.current++, first: from, last: to, says, sound: says }]);
      return;
    }
    const [first, end] = [Math.min(from, last.first), Math.max(to, last.last)];
    const says = saysFor(first, end);
    // A sound the Learner has not changed follows the pick.
    update(last.id, { first, last: end, says, sound: last.sound === last.says ? says : last.sound });
  };

  /**
   * The line a preview's state shows: its Blocker, its error, that a newer preview replaced it, or the worker's step.
   */
  const line = (state: Preview) => {
    if (state.blocker) return state.blocker;
    if (state.status === "failed") return state.error ?? undefined;
    if (state.status === "superseded") return "Replaced by a newer preview: tap ▶ Preview again";
    if (state.step === "waiting") return "Waiting for the worker to finish a step";
    if (state.step === "loading") return `Loading the ${LANGUAGES[sheet.language].name} voice`;
    if (state.step === "next" || state.step === "speaking") return "Speaking…";
  };

  /**
   * Asks the worker to speak row `row`'s sentence with every fix on the sheet, then follows it until it plays.
   */
  const preview = async (row: Row) => {
    const { beat, sentence } = words[row.first];
    if (row.wav) URL.revokeObjectURL(row.wav);
    // The first answer says where the preview is.
    update(row.id, { preview: undefined, wav: undefined });
    try {
      let state: Preview & { id?: number } = await (
        await orRefusal("/api/preview", { eventId, beat, sentence, fixes })
      ).json();
      const id = state.id!;
      latest.current.set(row.id, id);
      for (;;) {
        if (latest.current.get(row.id) !== id) return;
        if (state.wavUrl) {
          const res = await fetch(state.wavUrl).catch(() => undefined);
          if (!res?.ok) throw new Error(UNREACHABLE);
          const wav = URL.createObjectURL(await res.blob());
          wavs.current.push(wav);
          update(row.id, { preview: undefined, wav });
          return;
        }
        update(row.id, { preview: line(state) });
        if (state.blocker || state.step === null) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        state = await (await orRefusal(`/api/preview?id=${id}`)).json();
      }
    } catch (failed) {
      update(row.id, { preview: (failed as Error).message });
    }
  };

  /**
   * Writes every fix on the sheet to the Lexicon, changed or not, so it beats any Respelling a script wrote, and
   * regenerates the Clip.
   */
  const save = () =>
    orRefusal("/api/fix", { eventId, fixes }).then(onSaved, (failed: Error) => setError(failed.message));

  return createPortal(
    <Frame onClose={onClose}>
      <h3 className="mb-2.5 font-bold text-[1.17em]">🗣️ Fix pronunciation in “{title}”</h3>
      {sheet.note && <p className="mb-2 text-[13px]">🚩 “{sheet.note}”</p>}
      <p className={`${CLS.meta} mb-2`}>
        Tap the word that sounds wrong. Tap the next word too for a term of several words.
      </p>
      <div className="mb-3 max-h-[36dvh] overflow-y-auto rounded-[10px] border border-line p-2 leading-8">
        {words.map((word, i) => {
          const picked = rows.some((row) => row.first <= i && i <= row.last);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the script's words never move, and a word can repeat.
            <span key={i}>
              {i > 0 && words[i - 1].beat !== word.beat && <br />}
              <button
                type="button"
                aria-pressed={picked}
                className={`rounded px-0.5 ${picked ? "bg-accent text-black" : ""}`}
                onClick={() => tap(i)}
              >
                {word.text}
              </button>{" "}
            </span>
          );
        })}
      </div>
      {rows.map((row) => (
        <div key={row.id} className={CLS.card}>
          <label className="block text-[13px]">
            Sound of “<b>{term(row)}</b>”
            <input
              aria-label={`Sound of “${term(row)}”`}
              className="mt-1 w-full rounded-[10px] border border-line bg-bg p-2.5 text-fg"
              value={row.sound}
              onChange={(event) => update(row.id, { sound: event.target.value })}
            />
          </label>
          {!speakable(row.sound) && (
            <p className="mt-1 text-[13px] text-bad">A Respelling needs a letter or a digit.</p>
          )}
          <div className={CLS.actions}>
            <button
              type="button"
              className={BTN}
              disabled={!speakable(row.sound) || !term(row)}
              onClick={() => preview(row)}
            >
              ▶ Preview
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                latest.current.delete(row.id);
                if (row.wav) URL.revokeObjectURL(row.wav);
                setRows(rows.filter((other) => other.id !== row.id));
              }}
            >
              ✕ Remove
            </button>
          </div>
          {row.preview && <p className="mt-2 text-[13px]">{row.preview}</p>}
          {/* biome-ignore lint/a11y/useMediaCaption: a preview is one spoken sentence, shown above as text. */}
          {row.wav && <audio className="mt-2 w-full" controls autoPlay src={row.wav} />}
        </div>
      ))}
      {error && <p className="mb-2 text-[13px] text-bad">{error}</p>}
      {/* Kept in reach at the bottom while the sheet scrolls. */}
      <button
        type="button"
        className="sticky bottom-0 w-full rounded-[10px] bg-accent px-4 py-3 font-semibold text-black disabled:opacity-50"
        disabled={!rows.length || !rows.every((row) => speakable(row.sound) && term(row))}
        onClick={save}
      >
        Save and regenerate
      </button>
    </Frame>,
    document.body,
  );
}

/**
 * The bottom sheet's backdrop and panel. Tapping the backdrop closes it.
 */
function Frame({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <>
      <button type="button" aria-label="Close" className="fixed inset-0 z-39 bg-[#0008]" onClick={onClose} />
      <div
        data-testid="fix-sheet"
        className="fixed right-0 bottom-0 left-0 z-40 max-h-[85dvh] overflow-y-auto rounded-t-[18px] border-line border-t bg-card px-4 pt-[18px] pb-[calc(18px+env(safe-area-inset-bottom))]"
      >
        {children}
      </div>
    </>
  );
}
