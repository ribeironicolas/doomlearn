import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { angleName, CLS, Player, Screen, UNREACHABLE, useToast } from "./Screen.tsx";
import { api, type Hit } from "./sync.ts";

/**
 * FTS5 wraps each match in a caption between \u0002 and \u0003.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are the markers FTS5's highlight() was given.
const MATCH = /[\u0002\u0003]/;

/**
 * Where a Concept is: New, its ladder step as days, or Retired.
 */
const ladderLabel = ({ status, days }: Hit["concept"]) =>
  status === "new" ? "New" : status === "retired" ? "Retired" : `${days}d`;

/**
 * A box over Clip captions, each result tagged with its Clip's Language. A result opens the player with 🤔, 🚩 and ⭐,
 * as a history entry with no URL.
 * Off the network it says "Mac unreachable" and the box is disabled.
 */
export function Search() {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { state } = useLocation();
  const [toast, showToast] = useToast();
  // A slower answer to an earlier query is dropped: each query is its own key.
  const { data: hits, isError } = useQuery({
    queryKey: ["search", query],
    queryFn: () => api<Hit[]>(`/api/search?q=${encodeURIComponent(query)}`),
    enabled: !!query.trim(),
    placeholderData: keepPreviousData,
  });
  const shown = query.trim() && !isError ? hits : undefined;
  // The tapped hit itself, not its index: a newer query's answer may reorder the list under the player.
  const played: Hit | undefined = state?.hit;

  useEffect(() => input.current!.focus(), []);

  return (
    <Screen title="Search">
      <input
        ref={input}
        type="search"
        placeholder="Search the captions: mutex, pointer…"
        className="w-full rounded-xl border border-line bg-card px-3.5 py-3 text-fg disabled:opacity-50"
        value={query}
        disabled={isError}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="mt-2.5">
        {isError && <p className={CLS.meta}>{UNREACHABLE}</p>}
        {shown?.length === 0 && <p className={CLS.meta}>Nothing in the captions.</p>}
        {shown?.map((hit, i) => (
          <button
            key={hit.clipId}
            type="button"
            data-hit={i}
            className={`${CLS.card} block w-full text-left`}
            onClick={() => navigate("/search", { state: { hit } })}
          >
            <b>{hit.concept.title}</b>
            <span className={`${CLS.chip} ${hit.concept.status === "scheduled" ? CLS.ok : "border-line"}`}>
              {ladderLabel(hit.concept)}
            </span>
            <span className={`block ${CLS.meta}`}>
              {hit.source.title} · {angleName(hit.angle)} · {hit.language}
            </span>
            <span className="block">
              “
              {hit.caption.split(MATCH).map((part, n) =>
                // Odd parts are the matches.
                n % 2 ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the caption's parts never reorder.
                  <mark key={n} className="rounded-[3px] bg-accent px-0.5 text-black">
                    {part}
                  </mark>
                ) : (
                  part
                ),
              )}
              ”
            </span>
          </button>
        ))}
      </div>
      {played && <Player clip={played} label={ladderLabel(played.concept)} buttons="search" toast={showToast} />}
      {toast}
    </Screen>
  );
}
