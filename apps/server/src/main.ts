import { InvalidConfig } from "@doomlearn/core/config";
import { type Data, InvalidLexicon, openData } from "@doomlearn/core/data";
import { serve } from "./server.ts";
import { superviseWorker } from "./supervisor.ts";

let data: Data;
try {
  data = openData();
} catch (error) {
  if (!(error instanceof InvalidConfig || error instanceof InvalidLexicon)) throw error;
  // The file's problems alone, without a stack trace.
  console.error(error.message);
  process.exit(1);
}
serve(data);
superviseWorker(data);
