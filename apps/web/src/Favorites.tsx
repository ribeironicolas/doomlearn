import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { angleName, CLS, Player, Screen, useToast } from "./Screen.tsx";
import { type Favorite, syncFavorites } from "./sync.ts";

/**
 * What befell a Favorite's Concept, Source or Clip, as its chips say: Retired, Paused (the Concept, its chapter or its
 * Source), Deleted, 🚩.
 */
const chips = ({ concept, source, flagged }: Favorite) =>
  [
    concept.status === "retired" && "Retired",
    !concept.deleted && (concept.paused || source.status === "paused") && "Paused",
    !!concept.deleted && "Deleted",
    flagged && "🚩",
  ].filter((chip) => chip !== false);

/**
 * The Favorites, newest first, each with its first frame, Concept, Angle, Language, Source and chips. The list comes
 * from the Mac, else the last good one, so it opens with the Mac off. A row plays in the player with ⭐, Download and
 * Share, as a history entry with no URL; a 🚩 Favorite plays here only.
 */
export function Favorites() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const [toast, showToast] = useToast();
  const { data: list, refetch } = useQuery({ queryKey: ["favorites"], queryFn: syncFavorites });
  const played: Favorite | undefined = state?.favorite;
  const was = useRef(played);
  // Closing the player shows the list as its ⭐ left it.
  useEffect(() => {
    if (was.current && !played) refetch();
    was.current = played;
  }, [played, refetch]);

  return (
    <Screen title="Favorites">
      {list?.length === 0 && <p className={CLS.meta}>No Favorites yet. Tap ⭐ on a Clip to keep it here.</p>}
      {list?.map((item) => (
        <button
          key={item.clipId}
          type="button"
          data-favorite={item.clipId}
          className={`${CLS.card} flex w-full gap-3 text-left`}
          onClick={() => navigate("/favorites", { state: { favorite: item } })}
        >
          <video
            src={item.url}
            preload="metadata"
            muted
            playsInline
            className="h-24 w-[54px] shrink-0 rounded-md bg-black object-cover"
          />
          <span>
            <b>{item.concept.title}</b>
            {chips(item).map((chip) => (
              <span key={chip} className={`${CLS.chip} ${chip === "🚩" ? CLS.bad : "border-line"}`}>
                {chip}
              </span>
            ))}
            <span className={`block ${CLS.meta}`}>
              {item.source.title} · {angleName(item.angle)} · {item.language}
            </span>
          </span>
        </button>
      ))}
      {played && (
        <Player
          clip={{ ...played, favorite: true }}
          label={chips(played).join(" · ") || "⭐"}
          buttons="favorite"
          toast={showToast}
        />
      )}
      {toast}
    </Screen>
  );
}
