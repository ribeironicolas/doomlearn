import { openData } from "@doomlearn/core/data";
import { fakeMedia } from "@doomlearn/core/test/fakes";
import { work } from "../worker.ts";

// The worker on fake media, so no Python is needed, and the real Agent port on whatever `claude` is on PATH.
await work(openData(), {
  media: fakeMedia(),
  checkMedia: async () => ({ problems: [], toolProblems: [], voiceless: [], interpreters: [] }),
});
process.exit(0);
