import { setTimeout } from "node:timers/promises";
import { createAgent, preflightAgents } from "@doomlearn/agents/agent";
import type { Agent } from "@doomlearn/core/agent";
import type { Config } from "@doomlearn/core/config";
import { type Data, openData } from "@doomlearn/core/data";
import { LANGUAGE_TAGS, LANGUAGES, type Language } from "@doomlearn/core/languages";
import type { Media } from "@doomlearn/core/media";
import { createPipeline } from "@doomlearn/core/pipeline";
import { createPronunciation } from "@doomlearn/core/pronunciation";
import { publishPreflight, publishStage } from "@doomlearn/core/status";
import { localMedia } from "@doomlearn/media/local-media";
import { mediaPreflight, voiceProblem } from "@doomlearn/media/tools";

/**
 * How long the worker waits before checking for new work again when it is idle or blocked.
 */
const IDLE_POLL_MS = 5000;

/**
 * The worker loop, in the process the server forks. It reaches the server only through SQLite and `config.json`.
 * A SIGINT (the server relays the first Ctrl+C) lets the running stage finish and starts none; a second one, or the
 * server going away, kills the running agent calls now. The media preflight checks the voices of the Languages the
 * worker needs (the Language of new Clips, every queued or running job's and every queued preview's), again whenever
 * the config or those Languages change, and before each tick while a voice is missing (a check is ~0.2 s), so
 * `pnpm bootstrap` lets its jobs run without a restart. A missing voice holds back only the jobs and previews in its
 * Language.
 * Between its steps the worker first speaks the fix sheet's previews, through its own TTS: they use no Provider Usage
 * window, so neither a gate (Worker pause, Run windows, daily cap, usage threshold, rate-limit pause) nor an agent
 * problem holds them; a media problem does.
 * `media`, `agent` and `checkMedia` are seams for tests.
 */
export async function work(
  data: Data,
  { media = localMedia as Media, agent = undefined as Agent | undefined, checkMedia = mediaPreflight } = {},
) {
  const stop = new AbortController();
  const kill = new AbortController();
  /**
   * Kills the running agent calls and exits.
   */
  const quit = () => {
    kill.abort();
    process.exit(1);
  };
  process.on("SIGINT", () => (stop.signal.aborted ? quit() : stop.abort()));
  process.on("disconnect", quit);

  // The voice the TTS holds, once it has spoken: a preview in a Language with another voice first reloads it.
  let voice: string | undefined;
  const voiced: Media = {
    ...media,
    speak: (text, out, language) => {
      voice = LANGUAGES[language].tts.checkpoint;
      return media.speak(text, out, language);
    },
  };
  const pipeline = createPipeline(data, agent ?? createAgent(data, { signal: kill.signal }), voiced);
  const pronunciation = createPronunciation(data);
  // A stage left by a crashed worker is over, and so is a preview it was speaking.
  publishStage(data, null);
  pronunciation.sweep({ startup: true });
  // What the media preflight last found, and for which Languages. A media or agent problem blocks only the
  // worker: the server keeps serving the buffered Clips.
  let mediaCheck: Awaited<ReturnType<typeof checkMedia>> | undefined;
  let checkedLanguages: Language[] = [];
  /**
   * Runs the media preflight for the `needed` Languages and logs each problem it did not find last time.
   */
  const preflightMedia = async (needed: Language[]) => {
    const found = await checkMedia(needed);
    for (const problem of found.problems)
      if (!mediaCheck?.problems.includes(problem)) console.error(`doomlearn: worker blocked: ${problem}`);
    checkedLanguages = needed;
    return found;
  };
  /**
   * The media preflight's problems, each naming the Languages whose previews it holds: a tool problem holds them all,
   * a missing voice its own Language's.
   */
  const mediaBlockers = ({ toolProblems, voiceless }: NonNullable<typeof mediaCheck>) => [
    ...toolProblems.map((reason) => ({ reason, languages: LANGUAGE_TAGS })),
    ...voiceless.map((language) => ({ reason: voiceProblem(language), languages: [language] })),
  ];
  /**
   * The Languages the media preflight checks: the pipeline's and those of the queued previews.
   */
  const languages = () => [...new Set([...pipeline.languages(), ...pronunciation.languages()])].sort();
  mediaCheck = await preflightMedia(languages());
  // Shown at once; the agent preflight below adds its own.
  publishPreflight(data, mediaBlockers(mediaCheck));
  console.log(`doomlearn: data in ${data.home}, media ${mediaCheck.problems.length ? "blocked" : "ready"}`);

  // The config the preflights last checked, and what the agent preflight found. Both run again on every config
  // change, and the media preflight also when the Languages needed change or while a voice is missing.
  let checked: Config | undefined;
  let agentProblems: string[] = [];
  while (!stop.signal.aborted) {
    const config = data.config();
    const needed = languages();
    let republish = false;
    if (checked && (config !== checked || needed.join() !== checkedLanguages.join() || mediaCheck.voiceless.length)) {
      mediaCheck = await preflightMedia(needed);
      republish = true;
    }
    if (config !== checked) {
      checked = config;
      const { problems, warnings } = await preflightAgents(data.home, config);
      for (const warning of warnings) console.warn(`doomlearn: warning: ${warning}`);
      for (const problem of problems) console.error(`doomlearn: worker blocked: ${problem}`);
      agentProblems = problems;
      republish = true;
    }
    const held = mediaBlockers(mediaCheck);
    if (republish) publishPreflight(data, [...held, ...agentProblems]);
    pronunciation.sweep({ startup: false });
    // A preview queued since `needed` was read waits for the next round's preflight.
    await pronunciation.serve(voiced, {
      languages: checkedLanguages,
      held: (language) => held.find((blocker) => blocker.languages.includes(language))?.reason,
      loading: (language) => LANGUAGES[language].tts.checkpoint !== voice,
    });
    // A missing voice holds back only that Language's jobs; any other problem holds back every job. When blocked, idle,
    // during a Worker pause, a rate-limit pause or outside the Run windows, check for new work (e.g. a Source added
    // from the CLI) and config edits every 5 s.
    const blocked = mediaCheck.toolProblems.length || agentProblems.length;
    if (blocked || !(await pipeline.tick(mediaCheck.voiceless)))
      await setTimeout(IDLE_POLL_MS, undefined, { signal: stop.signal }).catch(() => {});
  }
}

if (import.meta.main) {
  await work(openData());
  process.exit(0);
}
