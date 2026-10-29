//
// The Feed: one Clip per screen, buttons in a right-hand rail, and a cached buffer for when the Mac is unreachable.
// Presses go through a queue in localStorage, each with its client event id, so a replayed sync is a no-op.
//

/**
 * A Mac off ZeroTier hangs rather than refusing, so a request gives up after `timeoutMs`;
 * the press queue is retried every `retryMs`.
 */
const SYNC = { timeoutMs: 5000, retryMs: 30_000 };
/**
 * The Feed's gestures and timings: loops before the end nudge, the delay before a press scrolls on, the long-press hold,
 * how much more across than down a swipe goes, the nudge's peek and when snapping resumes, and how long a toast shows.
 */
const UI = {
  nudgeLoops: 3,
  advanceMs: 350,
  longPressMs: 500,
  swipeRatio: 1.5,
  peekPx: 120,
  peekMs: 450,
  settleMs: 500,
  toastMs: 2600,
  percent: 100,
};
/**
 * The API's answers the app tells apart: an empty success, and a Source the Mac refuses.
 */
const STATUS = { noContent: 204, unprocessable: 422 };
const BUTTONS = [
  ["got_it", "✅", "got it"],
  ["didnt_get", "🤔", "didn’t get it"],
  ["know", "⏭️", "already know"],
  ["flag", "🚩", "wrong"],
];
/**
 * What a 🚩 can say is wrong; every reason hides the Clip.
 */
const REASONS = ["Wrong content", "Pronunciation", "Wrong caption", "Other"];

const feedEl = document.querySelector(".feed");
const endEl = document.querySelector(".end");
/** Clip ids already on screen. */
const rendered = new Set();
/**
 * Muted until the first tap, then unmuted for the session.
 */
let sound = false;
/**
 * The Feed's last list of upcoming slots, which the buffer is kept from.
 */
let upcoming = [];

const store = {
  get: (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
};

/** An Angle as the tag shows it. */
const angleName = (angle) => angle.replace("_", " ");

/**
 * Escapes text for use inside HTML, attribute values included.
 */
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A Passage's place in its Source: a page range, or a chapter and section.
 */
function passagePlace({ source, anchor }) {
  const [from, to] = anchor.pages ?? [];
  const place = anchor.pages
    ? from === to
      ? `p. ${from}`
      : `pp. ${from}–${to}`
    : [anchor.chapter, anchor.section].filter(Boolean).join(" › ");
  return `${source.title} · ${place}`;
}

//
// Sync
//

/**
 * GETs from the Mac, keeping the answer for when it's unreachable. `fresh` is false when the answer is the kept one.
 */
async function getJSON(path) {
  const cache = await caches.open("api");
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(SYNC.timeoutMs) });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    await cache.put(path, res.clone());
    return { value: await res.json(), fresh: true };
  } catch {
    const kept = await cache.match(path);
    return { value: kept ? await kept.json() : null, fresh: false };
  }
}

/**
 * Queues a press or a watch to the end, marks its Clip as handled here, tops the cached buffer back up, and tries to sync.
 */
function send(path, body) {
  store.set("queue", [...store.get("queue"), { path, body: { ...body, clientEventId: crypto.randomUUID() } }]);
  store.set("handled", [...store.get("handled"), body.clipId]);
  upcoming = upcoming.filter((slot) => slot.clipId !== body.clipId);
  keepBuffer(upcoming);
  flush();
}

let flushing;
/**
 * Sends the queue in order. Stops at the first network failure and leaves the rest for the next try.
 */
function flush() {
  flushing ??= (async () => {
    try {
      for (let queue = store.get("queue"); queue.length; queue = store.get("queue")) {
        const res = await fetch(queue[0].path, {
          method: "POST",
          body: JSON.stringify(queue[0].body),
          signal: AbortSignal.timeout(SYNC.timeoutMs),
        });
        // The Mac answered, so this press is settled; a rejected one would fail on every retry.
        if (!res.ok) console.error("press rejected", res.status, queue[0]);
        store.set("queue", store.get("queue").slice(1));
      }
    } catch {
      // Mac unreachable: retried on reconnect, on the next interval, or on the next press.
    }
    // Reset in .finally(), which always runs after the assignment, even when the queue was empty.
  })().finally(() => (flushing = undefined));
  return flushing;
}

/**
 * Keeps the Feed's upcoming Clips in the cache the service worker plays them from, and drops the rest.
 */
async function keepBuffer(slots) {
  const cache = await caches.open("clips");
  const keep = slots.map((slot) => new URL(slot.url, location.href).href);
  for (const request of await cache.keys()) if (!keep.includes(request.url)) await cache.delete(request);
  for (const url of keep) if (!(await cache.match(url))) await cache.add(url).catch(() => {});
}

/**
 * Syncs, then appends the Feed's slots not on screen yet. Returns the first new slide, if any.
 */
async function load() {
  await flush();
  const { value: slots, fresh } = await getJSON("/api/next");
  // The Mac has every press, so its list is the truth again.
  if (fresh && !store.get("queue").length) store.set("handled", []);
  const handled = new Set(store.get("handled"));
  upcoming = (slots ?? []).filter((slot) => !handled.has(slot.clipId));
  if (fresh) keepBuffer(upcoming);
  let first;
  for (const slot of upcoming.filter((slot) => !rendered.has(slot.clipId))) {
    rendered.add(slot.clipId);
    const el = slide(slot);
    feedEl.insertBefore(el, endEl);
    first ??= el;
  }
  return first;
}

//
// Feed screen
//

/**
 * One Clip's screen: the video, its tag, the button rail and its Passage, with their gestures.
 */
function slide(slot) {
  const el = document.createElement("section");
  el.className = "slide";
  const kind = slot.kind === "review" ? `Review · ${slot.concept.days}d` : "New";
  el.innerHTML = `
    <video playsinline muted preload="metadata" src="${slot.url}"></video>
    <div class="tag"><b>${kind}</b> · ${esc(slot.concept.title)} · ${esc(slot.source.title)} · ${angleName(slot.angle)}</div>
    <div class="rail">${BUTTONS.map(([button, emoji, label]) => `<button data-button="${button}">${emoji}<small>${label}</small></button>`).join("")}</div>
    <aside class="passage"><button class="close">✕</button>
      ${slot.passages.map((passage) => `<p class="where">${esc(passagePlace(passage))}</p><p>${esc(passage.text)}</p>`).join("")}
    </aside>`;
  const video = el.querySelector("video");
  let ended = false;
  let loops = 0;
  let longPressed = false;
  let pressed = false;

  el.show = () => {
    video.currentTime = 0;
    video.muted = !sound;
    video.play().catch(() => {});
  };
  el.hide = () => {
    video.pause();
    loops = 0;
    el.classList.remove("clean", "reading");
    el.querySelector(".nudge")?.remove();
  };

  // The end counts as an implicit ✅ once, then the Clip loops; after 3 loops, nudge to scroll on.
  video.onended = () => {
    if (!ended) send("/api/seen", { clipId: slot.clipId, completed: true });
    ended = true;
    if (++loops === UI.nudgeLoops) nudge(el);
    video.play().catch(() => {});
  };

  video.onclick = () => {
    if (longPressed) return;
    video.paused ? video.play() : video.pause();
  };

  // Any button auto-advances after 0.35 s; only the first press on a Clip counts. 🚩 asks its reason first; closing the sheet cancels it.
  for (const button of el.querySelectorAll("[data-button]")) {
    button.onclick = async () => {
      if (pressed) return;
      pressed = true;
      const { button: kind } = button.dataset;
      const flag = kind === "flag" && (await flagSheet(slot.concept.title));
      if (kind === "flag" && !flag) {
        pressed = false;
        return;
      }
      send("/api/press", { clipId: slot.clipId, button: kind, ...flag });
      // A 🚩, or a 🤔 out of Angles, adds an inbox item; offline, the badge catches up later.
      flush()
        .then(() => api("/api/inbox"))
        .then(showBadge, () => {});
      setTimeout(() => el.nextElementSibling.scrollIntoView({ behavior: "smooth" }), UI.advanceMs);
    };
  }

  // Long-press hides the rail and tag for this Clip only; hide() brings them back.
  let timer, x0, y0;
  el.addEventListener("pointerdown", (event) => {
    longPressed = false;
    if (event.target.closest("button, .passage")) return;
    [x0, y0] = [event.clientX, event.clientY];
    timer = setTimeout(() => {
      el.classList.toggle("clean");
      longPressed = true;
    }, UI.longPressMs);
  });
  // Moving more than 10 px is a scroll, not a long-press.
  el.addEventListener("pointermove", (event) => {
    if (Math.hypot(event.clientX - x0, event.clientY - y0) > 10) clearTimeout(timer);
  });
  for (const type of ["pointerup", "pointercancel"]) el.addEventListener(type, () => clearTimeout(timer));
  el.addEventListener("contextmenu", (event) => event.preventDefault());

  // A sideways swipe pauses the Clip and shows its Passage; another one, or ✕, goes back.
  /**
   * Shows or hides this Clip's Passage, pausing the Clip while it shows.
   */
  const reading = (on) => {
    el.classList.toggle("reading", on);
    on ? video.pause() : video.play().catch(() => {});
  };
  // Sideways means over 60 px across and clearly more across than down.
  let touch;
  el.addEventListener("touchstart", (event) => ([touch] = event.touches), { passive: true });
  el.addEventListener("touchend", (event) => {
    const dx = event.changedTouches[0].clientX - touch.clientX;
    const dy = event.changedTouches[0].clientY - touch.clientY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > UI.swipeRatio * Math.abs(dy)) reading(!el.classList.contains("reading"));
  });
  el.querySelector(".close").onclick = () => reading(false);

  observer.observe(el);
  return el;
}

/**
 * Peeks at what's below and leaves a bouncing hint, so it's clear this Clip is over.
 */
function nudge(el) {
  el.insertAdjacentHTML("beforeend", '<div class="nudge">↑ That’s the end, swipe up for the next one</div>');
  // Peeks 120 px down, then back after 0.45 s, and snaps again once settled.
  const top = el.offsetTop;
  feedEl.style.scrollSnapType = "none";
  feedEl.scrollTo({ top: top + UI.peekPx, behavior: "smooth" });
  setTimeout(() => {
    feedEl.scrollTo({ top, behavior: "smooth" });
    setTimeout(() => (feedEl.style.scrollSnapType = ""), UI.settleMs);
  }, UI.peekMs);
}

//
// Done for today
//

/**
 * Fills the end screen: today's presses, the buffer, tomorrow's Reviews; or scrolls to Clips made meanwhile.
 */
async function showEnd() {
  // Clips the worker made since the Feed loaded come before the end screen.
  const added = await load();
  if (added) return added.scrollIntoView({ behavior: "smooth" });
  const [{ value: today, fresh }, { value: inbox }] = await Promise.all([getJSON("/api/today"), getJSON("/api/inbox")]);
  const queued = store.get("queue").length;
  const lines = [];
  if (today) {
    const { counts, buffer, dueTomorrow } = today;
    lines.push(
      `Today: ✅ ${counts.got_it} · 🤔 ${counts.didnt_get} · ⏭️ ${counts.know} · 🚩 ${counts.flag}`,
      `Generating ${buffer.generating} · buffer ${buffer.ready}/${buffer.target}`,
      `Tomorrow: ${dueTomorrow} Review${dueTomorrow === 1 ? "" : "s"} due.`,
    );
  }
  if (!fresh) lines.push(today ? "Mac unreachable: these numbers are from the last sync." : "Mac unreachable.");
  if (queued) lines.push(`${queued} press${queued === 1 ? "" : "es"} waiting to sync.`);
  lines.push("No early Reviews, on purpose.");
  endEl.innerHTML = `<h2>Done for today 🌙</h2>${lines.map((line) => `<p>${line}</p>`).join("")}`;
  if (inbox) {
    endEl.insertAdjacentHTML(
      "beforeend",
      `<div class="card"><b>📥 ${inboxCount(inbox)} to look at</b>
        <div class="meta">${inbox.flags.length} 🚩 · ${inbox.notLanding.length} not landing · ${inbox.stuck.length} stuck</div>
        <div class="actions"><button class="btn" data-go="inbox">Open inbox</button><button class="btn" data-go="sources">Sources</button></div></div>`,
    );
    showBadge(inbox);
  }
}

//
// Search, inbox and Sources: online only, each over the Feed, with the phone's back gesture closing it
//

const screenEl = document.querySelector(".screen");
/**
 * The Feed slide on screen, paused while a screen covers it.
 */
let current;

/**
 * Calls the Mac's API: a GET, or a POST of `body` as JSON. Throws when the Mac is unreachable or refuses.
 */
async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
  const res = await fetch(path, { ...init, signal: AbortSignal.timeout(SYNC.timeoutMs) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.status === STATUS.noContent ? null : res.json();
}

/**
 * Shows a short message at the top for 2.6 s, replacing any still showing.
 */
function toast(text) {
  document.querySelector(".toast")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div class="toast">${esc(text)}</div>`);
  const el = document.querySelector(".toast");
  setTimeout(() => el.remove(), UI.toastMs);
}

/** The inbox's open items: 🚩, not landing, stuck. */
const inboxCount = ({ flags, notLanding, stuck }) => flags.length + notLanding.length + stuck.length;

/**
 * Puts the inbox's open-item count on 📥, hidden at zero.
 */
function showBadge(inbox) {
  const badge = document.querySelector(".badge");
  badge.textContent = inboxCount(inbox);
  badge.hidden = !inboxCount(inbox);
}

/**
 * A bottom sheet over everything; tapping outside it closes it and calls `onClose`.
 */
function sheet(html, onClose) {
  document.body.insertAdjacentHTML("beforeend", `<div class="scrim"></div><div class="sheet">${html}</div>`);
  const [scrim, el] = [...document.querySelectorAll(".scrim, .sheet")].slice(-2);
  /** Removes the sheet and its scrim. */
  const close = () => {
    scrim.remove();
    el.remove();
  };
  scrim.onclick = () => {
    close();
    onClose?.();
  };
  return { el, close };
}

/**
 * Asks why a Clip is wrong. Resolves to its reason and optional note, or to null when the sheet is closed.
 */
function flagSheet(title) {
  return new Promise((resolve) => {
    const { el, close } = sheet(
      `<h3>🚩 What’s wrong in “${esc(title)}”?</h3>
      ${REASONS.map((reason, i) => `<button class="opt${i ? "" : " sel"}">${reason}</button>`).join("")}
      <textarea rows="2" placeholder="Optional note, e.g. “cache” came out as “catchê”"></textarea>
      <button class="primary">Hide this Clip and log it</button>`,
      () => resolve(null),
    );
    let reason = REASONS[0];
    for (const option of el.querySelectorAll(".opt")) {
      option.onclick = () => {
        reason = option.textContent;
        for (const other of el.querySelectorAll(".opt")) other.classList.toggle("sel", other === option);
      };
    }
    el.querySelector(".primary").onclick = () => {
      close();
      resolve({
        reason,
        ...(el.querySelector("textarea").value.trim() && { note: el.querySelector("textarea").value.trim() }),
      });
    };
  });
}

/**
 * Shows a Concept's Passages, each with its place in its Source.
 */
function passageSheet(title, passages) {
  sheet(
    `<h3>${esc(title)}</h3>${passages.map((passage) => `<p class="where">${esc(passagePlace(passage))}</p><p>${esc(passage.text)}</p>`).join("")}`,
  );
}

/**
 * A layer (screen or player) the back gesture closes: it gets a history entry, and popping it runs `close`.
 */
const layers = [];
/**
 * Opens a layer: one history entry that the back gesture pops, running `close`.
 */
function pushLayer(close) {
  layers.push(close);
  history.pushState(null, "");
}
addEventListener("popstate", () => layers.pop()?.());

/**
 * Opens search, the inbox or Sources over the Feed, pausing the Clip on screen.
 */
function openScreen(name) {
  current?.hide();
  screenEl.hidden = false;
  screenEl.innerHTML = `<button class="back">←</button><div class="page"></div>`;
  screenEl.querySelector(".back").onclick = () => history.back();
  if (!layers.length) {
    pushLayer(() => {
      screenEl.hidden = true;
      screenEl.innerHTML = "";
      current?.show();
      api("/api/inbox").then(showBadge, () => {});
    });
  }
  screens[name](screenEl.querySelector(".page"));
}

/**
 * Plays one Clip full-screen. Nothing it plays is recorded: watching from here never moves the ladder.
 * With `buttons`, it offers 🤔 (which un-retires a Retired Concept) and 🚩.
 */
function player(hit, { buttons = false } = {}) {
  const el = document.createElement("div");
  el.className = "player";
  el.innerHTML = `<video playsinline autoplay loop src="${hit.url}"></video><button class="back">←</button>
    <div class="tag"><b>${hit.label}</b> · ${esc(hit.concept.title)} · ${angleName(hit.angle)}</div>
    ${buttons ? '<div class="rail"><button data-button="didnt_get">🤔<small>didn’t get it</small></button><button data-button="flag">🚩<small>wrong</small></button></div>' : ""}`;
  el.querySelector("video").muted = !sound;
  el.querySelector(".back").onclick = () => history.back();
  for (const button of el.querySelectorAll("[data-button]")) {
    button.onclick = async () => {
      const flag = button.dataset.button === "flag" && (await flagSheet(hit.concept.title));
      if (button.dataset.button === "flag" && !flag) return;
      try {
        await api("/api/press", {
          clipId: hit.clipId,
          button: button.dataset.button,
          clientEventId: crypto.randomUUID(),
          ...flag,
        });
        el.querySelector(".rail").remove();
        toast(flag ? "🚩 Logged; this Clip is hidden." : "🤔 Back to step 0, due tomorrow.");
      } catch {
        toast("Mac unreachable: nothing was recorded.");
      }
    };
  }
  document.body.append(el);
  pushLayer(() => el.remove());
}

/**
 * Where a Concept is: New, its ladder step as days, or Retired.
 */
const ladderLabel = ({ status, days }) => (status === "new" ? "New" : status === "retired" ? "Retired" : `${days}d`);
/** What a screen shows when the Mac doesn't answer. */
const unreachable = '<p class="meta">Mac unreachable. Try again once it’s back.</p>';

/**
 * Each screen renders itself into `page`, and again after each of its actions.
 */
const screens = {
  /**
   * A box over Clip captions; a result opens the player with 🤔 and 🚩.
   */
  search(page) {
    page.innerHTML = `<h1>Search</h1><input class="search" type="search" placeholder="Search the captions: mutex, pointer…"><div class="results"></div>`;
    const input = page.querySelector("input");
    const results = page.querySelector(".results");
    let hits = [];
    input.oninput = async () => {
      const query = input.value;
      let found;
      try {
        found = query.trim() ? await api(`/api/search?q=${encodeURIComponent(query)}`) : [];
      } catch {
        results.innerHTML = unreachable;
        return;
      }
      // A slower answer to an earlier query is dropped.
      if (query !== input.value) return;
      hits = found.map((hit) => ({ ...hit, label: ladderLabel(hit.concept) }));
      results.innerHTML = query.trim() && !hits.length ? '<p class="meta">Nothing in the captions.</p>' : "";
      results.insertAdjacentHTML(
        "beforeend",
        hits
          .map(
            (
              hit,
              i,
            ) => `<div class="card" data-hit="${i}"><b>${esc(hit.concept.title)}</b><span class="chip${hit.concept.status === "scheduled" ? " ok" : ""}">${hit.label}</span>
              <div class="meta">${esc(hit.source.title)} · ${angleName(hit.angle)}</div>
              <div>“${esc(hit.caption).replaceAll("\u0002", "<mark>").replaceAll("\u0003", "</mark>")}”</div></div>`,
          )
          .join(""),
      );
      for (const card of results.querySelectorAll("[data-hit]"))
        card.onclick = () => player(hits[card.dataset.hit], { buttons: true });
    };
    input.focus();
  },

  /**
   * Open 🚩, not-landing Concepts and stuck jobs, each with its actions.
   */
  async inbox(page) {
    page.innerHTML = "<h1>Inbox</h1>";
    let inbox;
    try {
      inbox = await api("/api/inbox");
    } catch {
      return page.insertAdjacentHTML("beforeend", unreachable);
    }
    showBadge(inbox);
    const { flags, notLanding, stuck } = inbox;
    page.insertAdjacentHTML(
      "beforeend",
      `<h2>🚩 Flagged Clips (${flags.length})</h2>` +
        flags
          .map(
            (
              flag,
              i,
            ) => `<div class="card"><b>${esc(flag.concept.title)}</b><span class="chip ${flag.reason === "Pronunciation" ? "warn" : "bad"}">${esc(flag.reason ?? "Wrong")}</span>
              <div class="meta">${angleName(flag.angle)} · ${new Date(flag.at).toLocaleString()}</div>${flag.note ? `<div>“${esc(flag.note)}”</div>` : ""}
              <div class="actions"><button class="btn" data-view="${i}">▶ View Clip</button><button class="btn" data-resolve="${flag.eventId}">Resolved</button></div></div>`,
          )
          .join("") +
        `<h2>Not landing (${notLanding.length})</h2>` +
        notLanding
          .map(
            (
              item,
              i,
            ) => `<div class="card"><b>${esc(item.concept.title)}</b><span class="chip warn">${item.tried.length}/${item.fit} Angles</span>
              <div class="meta">Tried ${item.tried.map(angleName).join(", ")} · since ${new Date(item.since).toLocaleDateString()}. Reviews reuse its least recently seen Clip.</div>
              <div class="actions"><button class="btn" data-read="${i}">Read the Passage</button><button class="btn" data-retire="${item.clipId}">⏭️ Retire</button></div></div>`,
          )
          .join("") +
        `<h2>Stuck jobs (${stuck.length})</h2>` +
        stuck
          .map(
            (
              job,
            ) => `<div class="card"><b>${esc(job.kind === "extract_chapter" ? `${job.source.title} · ${job.chapter.title}` : `${job.concept.title} · ${angleName(job.angle)}`)}</b><span class="chip bad">stuck</span>
              <div class="meta">${job.kind === "extract_chapter" ? "Extraction" : "Clip"} · ${job.stage ? `after ${esc(job.stage)}` : "at the first stage"}</div><div>${esc(job.lastError ?? "")}</div>
              <div class="actions"><button class="btn" data-retry="${job.jobId}">↻ Retry</button></div></div>`,
          )
          .join(""),
    );
    /**
     * On click, runs `call`, then toasts `done` and re-renders the inbox.
     */
    const act = (button, call, done) =>
      (button.onclick = () =>
        call().then(
          () => {
            toast(done);
            return screens.inbox(page);
          },
          () => toast("Mac unreachable: try again."),
        ));
    for (const button of page.querySelectorAll("[data-view]"))
      button.onclick = () => player({ ...flags[button.dataset.view], label: "🚩" });
    for (const button of page.querySelectorAll("[data-read]")) {
      const item = notLanding[button.dataset.read];
      button.onclick = () => passageSheet(item.concept.title, item.passages);
    }
    for (const button of page.querySelectorAll("[data-resolve]"))
      act(button, () => api("/api/resolve", { eventId: Number(button.dataset.resolve) }), "🚩 Resolved.");
    for (const button of page.querySelectorAll("[data-retire]")) {
      act(
        button,
        () =>
          api("/api/press", {
            clipId: Number(button.dataset.retire),
            button: "know",
            clientEventId: crypto.randomUUID(),
          }),
        "⏭️ Retired.",
      );
    }
    for (const button of page.querySelectorAll("[data-retry]"))
      act(button, () => api("/api/retry", { jobId: Number(button.dataset.retry) }), "↻ Back in the queue.");
  },

  /**
   * Upload with the last refusal (if any), the queue line, and a card per Source.
   */
  async sources(page, refusal = "") {
    page.innerHTML = `<h1>Sources</h1>
      <label class="drop">📄 Add a PDF, .txt, .md, .epub or .azw3<input type="file" accept=".pdf,.txt,.md,.epub,.azw3" hidden></label>
      ${refusal}`;
    const drop = page.querySelector(".drop");
    // Uploads run as long as the file takes, so no timeout.
    /**
     * Sends `file` to the Mac as a new Source, then re-renders Sources with any refusal on top.
     */
    const upload = async (file) => {
      drop.firstChild.textContent = `Adding ${file.name}…`;
      let message;
      try {
        const res = await fetch(`/api/sources?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        message =
          res.status === STATUS.unprocessable
            ? `<b>${esc(file.name)} refused.</b> ${esc((await res.json()).error)}`
            : res.ok
              ? ""
              : `<b>${esc(file.name)} failed</b> (${res.status}).`;
      } catch {
        message = `<b>${esc(file.name)} not sent.</b> Mac unreachable.`;
      }
      screens.sources(page, message && `<div class="card refusal">${message}</div>`);
    };
    drop.querySelector("input").onchange = (event) => event.target.files[0] && upload(event.target.files[0]);
    drop.ondragover = (event) => {
      event.preventDefault();
      drop.classList.add("over");
    };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (event) => {
      event.preventDefault();
      if (event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]);
    };

    let status;
    try {
      status = await api("/api/sources");
    } catch {
      return page.insertAdjacentHTML("beforeend", unreachable);
    }
    const { sources, queue } = status;
    // HH:MM, as in the CLI's status.
    const paused = queue.pausedUntil
      ? `Paused until ${new Date(queue.pausedUntil).toLocaleTimeString().slice(0, "HH:MM".length)} (rate limit) · `
      : "";
    page.insertAdjacentHTML(
      "beforeend",
      `<p class="meta" style="margin-top:12px">Queue: ${paused}buffer ${queue.buffer.clips}/${queue.buffer.target} · today ${queue.today.clips}/${queue.today.cap} Clips</p>
      <h2>Your Sources</h2><div class="srcgrid">` +
        sources
          .map((source) => {
            const { done, total } = source.chapters;
            const chip =
              source.status === "paused"
                ? '<span class="chip warn">paused</span>'
                : source.stuck.length
                  ? `<span class="chip bad">${source.stuck.length} stuck</span>`
                  : total && done === total
                    ? '<span class="chip ok">complete</span>'
                    : '<span class="chip">extracting</span>';
            return `<div class="card"><b>${esc(source.title)}</b>${chip}
              <div class="bar"><div style="width:${total ? (UI.percent * done) / total : 0}%"></div></div>
              <div class="meta">chapter ${done}/${total} · ${source.concepts} Concepts</div>
              ${source.stuck
                .map(
                  (
                    job,
                  ) => `<div class="stuck"><span>✗ ch. ${job.chapter.seq + 1} “${esc(job.chapter.title)}”: ${esc(job.lastError ?? "")}</span>
                    <button class="btn" data-retry="${job.jobId}">↻ Retry</button></div>`,
                )
                .join("")}
              <div class="actions"><button class="btn" data-${source.status === "paused" ? "resume" : "pause"}="${source.id}">${source.status === "paused" ? "▶ Resume" : "⏸ Pause"}</button></div></div>`;
          })
          .join("") +
        '</div><p class="meta" style="margin-top:12px">Pausing stops new Concepts and Clips from that Source; Reviews and 🤔 go on. Sources are never deleted.</p>',
    );
    /**
     * Wires each button matching `selector` to `call` with its data id, then re-renders.
     */
    const act = (selector, call) => {
      for (const button of page.querySelectorAll(selector)) {
        button.onclick = () =>
          call(Number(Object.values(button.dataset)[0])).then(
            () => screens.sources(page),
            () => toast("Mac unreachable: try again."),
          );
      }
    };
    act("[data-retry]", (jobId) => api("/api/retry", { jobId }));
    act("[data-pause]", (sourceId) => api("/api/pause", { sourceId }));
    act("[data-resume]", (sourceId) => api("/api/resume", { sourceId }));
  },
};

/**
 * Plays only the Clip on screen; reaching the end screen refreshes it.
 */
const observer = new IntersectionObserver(
  (entries) => {
    for (const { target, isIntersecting } of entries) {
      // A screen over the Feed keeps it paused; closing it plays `current` again.
      if (target === endEl) {
        if (isIntersecting) {
          current = undefined;
          showEnd();
        }
      } else if (!isIntersecting) target.hide();
      else {
        current = target;
        if (screenEl.hidden) target.show();
      }
    }
  },
  { threshold: 0.6 },
);

navigator.serviceWorker?.register("/sw.js");
// The top-right icons, and the end screen's inbox card.
document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]");
  if (go) openScreen(go.dataset.go);
});
api("/api/inbox").then(showBadge, () => {});
addEventListener("online", flush);
setInterval(flush, SYNC.retryMs);
// The first tap anywhere unmutes for the session; a tap on the video then doesn't also pause it.
document.addEventListener(
  "click",
  (event) => {
    sound = true;
    document.querySelector(".tapsound")?.remove();
    for (const video of document.querySelectorAll("video")) video.muted = false;
    if (event.target.matches("video")) event.stopPropagation();
  },
  { capture: true, once: true },
);
// Scroll snap would keep the end screen, the only slide at first, in view; open on the first Clip instead.
load().then(() => {
  feedEl.scrollTo({ top: 0 });
  observer.observe(endEl);
});
