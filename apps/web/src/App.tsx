import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Outlet, Route, Routes, useLocation, useNavigate } from "react-router";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Favorites } from "./Favorites.tsx";
import { Feed, inboxCount } from "./Feed.tsx";
import { Inbox } from "./Inbox.tsx";
import { Search } from "./Search.tsx";
import { Settings } from "./Settings.tsx";
import { Source } from "./Source.tsx";
import { Sources } from "./Sources.tsx";
import { ICON_BTN } from "./Slide.tsx";
import { api, type Blocker, type Inbox as Items, queryClient, type Status } from "./sync.ts";

/**
 * The Blockers the Learner must act on, the only ones that put a dot on ⚙️; the others are intentional.
 */
const NEEDS_YOU: Blocker["kind"][] = ["stopped", "preflight", "invalid_config"];

/**
 * The Feed with 🔍 ⭐ 📚 📥 ⚙️ over it; Search, Favorites, the inbox, Sources (and a Source's screen) and Settings open
 * full-screen over it, and back closes them.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={null} />
        <Route path="search" element={<Search />} />
        <Route path="favorites" element={<Favorites />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="sources" element={<Sources />} />
        <Route path="sources/:id" element={<Source />} />
        <Route path="settings/:tab" element={<Settings />} />
      </Route>
    </Routes>
  );
}

/**
 * The Feed stays mounted, so back returns to the same Clip and scroll position.
 */
function Layout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const was = useRef(pathname);
  // Fetched at startup and whenever a screen closes, never polled; a failed fetch keeps the last count and dot.
  const { data: inbox } = useQuery({ queryKey: ["inbox"], queryFn: () => api<Items>("/api/inbox") });
  const { data: status } = useQuery({ queryKey: ["status"], queryFn: () => api<Status>("/api/status") });
  useEffect(() => {
    if (pathname === "/" && was.current !== "/") {
      queryClient.refetchQueries({ queryKey: ["inbox"] });
      queryClient.refetchQueries({ queryKey: ["status"] });
    }
    was.current = pathname;
  }, [pathname]);
  const count = inbox ? inboxCount(inbox) : 0;
  const needsYou = !!status?.blockers.some((blocker) => NEEDS_YOU.includes(blocker.kind));
  return (
    <>
      <Feed />
      <nav className="fixed top-[calc(8px+env(safe-area-inset-top))] right-2.5 z-20 flex gap-1.5">
        {(
          [
            ["search", "🔍"],
            ["favorites", "⭐"],
            ["sources", "📚"],
            ["inbox", "📥"],
            ["settings/worker", "⚙️"],
          ] as const
        ).map(([to, emoji]) => (
          <button
            key={to}
            type="button"
            className={`relative bg-[#0008] ${ICON_BTN}`}
            onClick={() => navigate(`/${to}`)}
          >
            {emoji}
            {to === "inbox" && (
              <span
                hidden={!count}
                className="absolute -top-0.5 -right-0.5 h-4 min-w-4 rounded-lg bg-bad text-[10px] leading-4"
              >
                {count}
              </span>
            )}
            {to === "settings/worker" && needsYou && (
              <span data-testid="needs-you" className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-bad" />
            )}
          </button>
        ))}
      </nav>
      <Outlet />
      <UpdateToast />
    </>
  );
}

/**
 * A waiting version shows at the top until tapped; nothing reloads mid-Clip on its own.
 */
function UpdateToast() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <button
      type="button"
      className="fixed top-[calc(60px+env(safe-area-inset-top))] left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-xl border border-line bg-[#111827f0] px-3.5 py-2.5 text-[13px]"
      onClick={() => {
        // vite-plugin-pwa reloads only for a version found while registering; one found later (a long-open app)
        // would take over without a reload, so reload once it controls the page.
        navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
        updateServiceWorker(true);
      }}
    >
      New version · Reload
    </button>
  );
}
