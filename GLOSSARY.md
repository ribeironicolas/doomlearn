# doomlearn

Turns long reading material (books, articles) into a personal feed of short, dynamic explainer videos, so a Learner studies by scrolling instead of reading.

## Language

**Learner**:
The single person who owns a doomlearn instance: feeds it Sources and watches its Feed.
_Avoid_: user, viewer, audience

**Source**:
A piece of reading material the Learner feeds in (book PDF, article, long text); the raw material Concepts come from.
_Avoid_: document, input, material

**Chapter**:
One entry of a Source's table of contents, extracted on its own; a Source's Concepts are grouped by Chapter, in book order. A Concept taught in several Chapters belongs to each of them.
_Avoid_: section, part, unit

**Paused**:
A Source, Chapter or Concept that no longer yields new Concepts or first Clips; its existing Clips, Reviews and 🤔 follow-ups go on. Reversible with Resume.
_Avoid_: removed, archived, deleted

**Deleted**:
A Chapter or Concept the Learner removed: it leaves the Feed and Search but stays on the Source screen, greyed, with Restore. Nothing is erased. A Concept leaves with its Chapter only while no live Chapter teaches it.
_Avoid_: removed, archived, hidden, Retired (a Concept the Learner knows)

**Concept**:
A single, self-contained idea with one through-line, small enough for one Clip to explain (e.g. "what is a thread"). Taught by one or more Passages, possibly from different Sources.
_Avoid_: topic, subject, lesson

**Passage**:
The part of a Source that teaches a Concept; what a Clip's script is grounded in and checked against.
_Avoid_: excerpt, quote, snippet

**Clip**:
A short vertical narrated video that explains one Concept through one Angle, in its own words.
_Avoid_: video, reel, short, post

**Flagged**:
A Clip the Learner marked 🚩 as bad; it stays out of the Feed and Search, and cannot be played, except from Favorites, until it is regenerated.
_Avoid_: hidden, reported, rejected, removed

**Angle**:
The narrative structure of a Clip's body, after its opening hook: one of concrete example, analogy, mechanism, or contrast. Defined by structure, not content (two different analogies are the same Angle). Two Clips with the same Concept, Angle and Language are duplicates.
_Avoid_: style, format, approach

**Language**:
The one language a Clip is spoken and captioned in, chosen from those doomlearn can narrate, time and draw. A Clip in another Language is its own Clip; the Concept's progress is shared across Languages.
_Avoid_: locale, idioma, voice, narration language, variant, version, dub

**Language of new Clips**:
The Learner's single setting for the Language the worker makes new Clips in, 🤔 follow-ups included; Reviews prefer a Clip in it. Clips already made keep their own Language.
_Avoid_: default language, preferred language, UI language, default locale

**Translation**:
A Clip made from an existing Clip's beats (same hook, example and order), said in another Language, for the same Concept and Angle. It is its own Clip in that Language; only the Learner asks for one, never the worker.
_Avoid_: remake, dub, subtitle, version, variant

**Lexicon**:
The Learner's list, per Language, of terms and how the voice says each one. It wins over any Respelling a script wrote, and a fix to it applies to every later Clip in that Language.
_Avoid_: dictionary, pronunciation table, override

**Respelling**:
A term written the way the Language's voice reads it, so the voice says it right (e.g. tréd for thread).
_Avoid_: phonetic, IPA, spoken form

**Feed**:
The ordered stream of Clips the Learner scrolls through.
_Avoid_: timeline, playlist

**Pass**:
One play-through of a Clip, from its start to its end; each Pass that ends counts as a loop and can give the implicit ✅, unless it is a Skipped pass.
_Avoid_: play, view, watch-through

**Skipped pass**:
A Pass in which the Learner scrubbed forward; when it ends it gives no implicit ✅ and does not count as a loop. Rewinding or watching faster does not make a Pass skipped.
_Avoid_: tainted pass, scrubbed pass, partial view

**Favorite**:
A Clip the Learner kept with ⭐ to watch, download or share later; it stays until the Learner removes it, whatever happens to its Concept, and changes nothing about learning. All of them form one list, Favorites, newest first.
_Avoid_: saved, bookmark, like, collection, library

**Review**:
A Concept coming back into the Feed because it's due again; shows one of its existing Clips.
_Avoid_: repeat, rerun, revisit

**Retired**:
A Concept that no longer enters the Feed, because the Learner already knew it or it was understood enough times; reachable only through search.
_Avoid_: archived, done, deleted

**Provider**:
An agent CLI that doomlearn drives under the Learner's own login, or with no login (today Claude Code and Codex); each has one adapter that builds its argv and parses its output.
_Avoid_: backend, vendor, engine, LLM

**Effort**:
The reasoning level a stage passes to its Provider, in that Provider's own words (Claude `low…max`, Codex `low…ultra`).
_Avoid_: thinking level, reasoning budget, quality

**Run window**:
A span of days and local times in which the worker may start stages; none set means always.
_Avoid_: quiet hours, schedule slot, cron

**Worker pause**:
The Learner's switch that stops the worker from starting new stages; buffered Clips keep playing. Distinct from a Paused Source, Chapter or Concept and from the rate-limit pause.
_Avoid_: "Paused" for the worker, stop, suspend

**Usage window**:
A rolling period over which a Provider's plan caps the Learner's use (e.g. Claude's 5-hour and 7-day windows). doomlearn reads how much is used but never sets it.
_Avoid_: quota, credits, rate limit

**Worker status**:
The worker's live state: liveness (running, idle, stopping, stopped) plus current job, stage and start time, and the list of active Blockers.
_Avoid_: heartbeat, health, worker state

**Blocker**:
One active reason the worker will not start a new stage (stopped, stopping, preflight failure, invalid config, Worker pause, outside Run window, rate-limit pause, usage threshold), with a reason and optional until-time; several can be active.
_Avoid_: error, block state, "paused" for anything but a Worker pause or a Paused Source, Chapter or Concept

**Needs-you Blocker**:
A Blocker the Learner must act on: stopped (crash), preflight failure, invalid config. The only kind that puts a dot on ⚙️.
_Avoid_: error, alert, critical blocker
