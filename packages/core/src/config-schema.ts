// Writes config.schema.json from the Zod schema; `pnpm config:schema` runs it, then Biome formats the file.
// CI fails when the committed file is stale.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigSchema, SCHEMA_FILE } from "./config.ts";

writeFileSync(SCHEMA_FILE, `${JSON.stringify(z.toJSONSchema(ConfigSchema, { io: "input" }), null, 2)}\n`);
