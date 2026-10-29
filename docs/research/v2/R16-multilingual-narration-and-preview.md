# R16: Which languages can the narration chain speak and time, how is pronunciation fixed in each, and how fast is a one-phrase preview?

## Setup

- Mac: Apple silicon, 18 GB RAM.
- Runtimes: `pnpm bootstrap` in the research worktree. It synced the three venvs and fetched nothing from HF (the pinned weights were cached).
- Installed versions: `chatterbox-tts` 0.1.7 at git `5de7a54` (tts venv, `direct_url.json`), `mlx-audio==0.5.8` (`packages/media/python/align/pyproject.toml`). The TTS server uses the vendored loader in `packages/media/python/tts/vendor/chatterbox`, not the pip package.
- Extra weights for this test went into a scratch HF cache (`HF_HUB_CACHE=<scratchpad>/hf`, 5.9 GB), not `~/.cache/huggingface`:
  - `ResembleAI/chatterbox@5bb1f6ee…`: `t3_mtl23ls_v3.safetensors` and `s3gen.pt`.
  - `ResembleAI/Chatterbox-Multilingual-es-mx-latam@27e595bf…`: `t3_es_mx_latam.safetensors`.
  - `mlx-community/Qwen3-ASR-0.6B-8bit@89e96d92…` (1.0 GB). This is the recogniser used for the round-trip.
- Scripts (scratch, not committed): `synth.py` speaks sentence by sentence like `server.py`, with faber, `exaggeration 0.5`, seed 0. Unlike `server.py`, it reseeds and calls `torch.mps.empty_cache()` after every sentence. `evaluate.py` runs Qwen3-ASR (language auto-detect) and gets WER, then runs Qwen3-ForcedAligner and checks the word list. `bench_preview.py` spawns the real `server.py`. `memprobe.py` reads the MPS allocator.
- Noise: during the first runs, another ticket's Android emulator used ~340% CPU and swap was nearly full. The timings in answer 5 come from a rerun after the emulator had exited (load average about 4-5). The RTFs in the synthesis table come from runs under load and are only indicative.
- Listening assets (owner): 23 wavs in `<scratchpad>/r16-samples/` of the research session (20 MB, not committed). Names follow `<model>-<text>-lang_<id>-cfg<w>.wav`. The model is `ptbr` (current pack), `v3` (multilingual V3) or `esmx` (LatAm Spanish pack). The text is the ~110-word "what is a thread" script in `pt`/`en`/`es`, or a short and hard variant.

## 1. TTS languages: both, and one checkpoint serves all 23

- Chatterbox ships both. Multilingual V3 is one checkpoint for 23 languages. The "Single Language Pack" is six dedicated finetunes: Chinese, LatAm Spanish, Brazilian Portuguese, Spain Spanish, Portugal Portuguese and Hindi. There is **no English pack** (https://huggingface.co/ResembleAI/chatterbox, README "Model Zoo" and "Single Language Pack"; `curl https://huggingface.co/api/models?search=Chatterbox-Multilingual&author=ResembleAI` lists exactly es-es, es-mx-latam, pt-pt, pt-br, zh-cmn and hi). The same Model Zoo table also lists the original **English-only Chatterbox** (500M, "CFG and exaggeration tuning"). Its weights (`t3_cfg.safetensors` 2.13 GB, `s3gen.pt`) sit in the base repo `ResembleAI/chatterbox`, which is already pinned for `ve.pt`/`conds.pt`. This research did not test it (see Unverified).
- The language list is `SUPPORTED_LANGUAGES` in the installed `chatterbox/mtl_tts.py`: ar, da, de, el, en, es, fi, fr, he, hi, it, ja, ko, ms, nl, no, pl, pt, ru, sv, sw, tr, zh. Context7 `/resemble-ai/chatterbox` gives the same list.
- Each pack is one language. Its own demo Space hard-codes `FIXED_LANGUAGE_ID = 'pt'` (pt-br) or `'es'` (es-mx-latam) in `app.py` (https://huggingface.co/spaces/ResembleAI/Chatterbox-Multilingual-TTS-pt-br, …-es-mx-latam). The pt-br card says: "For a single model that covers all supported languages, use ResembleAI/chatterbox" (cached `README.md` of the pack).
- `language_id` only adds a text token. The vendored `MTLTokenizer.encode` prepends `[<id>]` to the text (`vendor/chatterbox/models/tokenizers/tokenizer.py:38-41`). It does not validate the id. The pip version rejects unknown ids (`mtl_tts.py:293`).
- Weights per candidate (sizes from `https://huggingface.co/api/models/<repo>/tree/main`):

| Language | Weights | New download |
|---|---|---|
| pt-BR (today) | pack `t3_pt_br.safetensors` 2.14 GB + `s3gen_v3.pt` 1.06 GB | none |
| Spanish (LatAm or Spain pack) | `t3_es_mx_latam.safetensors` / `t3_es_es.safetensors` 2.14 GB, plus the same `s3gen_v3.pt` (identical LFS sha256 `f7abce4b…` in all packs) | 2.14 GB |
| English, or any of the 23 through V3 | `t3_mtl23ls_v3.safetensors` 2.14 GB + `s3gen.pt` 1.06 GB (the V3 Space loads `s3gen.pt`, not `s3gen_v3.pt`: `chatterbox/src/chatterbox/tts.py:239-241` in https://huggingface.co/spaces/ResembleAI/Chatterbox-Multilingual-TTS-V3) | 3.2 GB (2.14 GB if V3 works with the already-cached `s3gen_v3.pt`, which the base repo also ships; untested) |

  The tokenizer `grapheme_mtl_merged_expanded_v1.json` is the same file in every repo (sha `d27fb3f2…`). `ve.pt` and `conds.pt` come from the base repo, which is already pinned.
- The vendored loader loads V3 and the es-mx pack unchanged. `from_local(base, "mps", t3_filename=<path>, s3gen_filename=<path>)` worked for both (`synth.py`; load 11.1 s each). One difference: the V3 Space tokenizer applies `text_preproc = "NFKD,fullcase"` (its `t3_config.py:5`), and the vendored one does not. `synth.py` applied NFKD before calling V3.
- Memory: one model per process. After load, the footprint is 5.8 GB. Once it has spoken, it is 10-11 GB (answer 5). Several languages served by one V3 model take one process. A pack per language takes another 2.14 GB T3 for each language. These could be swapped inside one process at ~11-13 s per load (the `loadS` lines in `ptbr.log`, `v3.log`, `esmx.log`), but swapping was not measured on its own.
- Quality measured by ASR round-trip on the full script (Qwen3-ASR with auto language; WER is against the shown text, lowercased, punctuation stripped):

| Model, language_id | ASR language | WER | Duration | faber similarity |
|---|---|---|---|---|
| pt-br pack, `pt` | Portuguese | 0.000 | 37.9 s | 0.955 |
| V3, `pt` | Portuguese | 0.010 | 34.9 s | 0.964 |
| pt-br pack, `en` | English | 0.009 | 34.8 s | 0.935 |
| V3, `en` | English | 0.000 | 31.9 s | 0.928 |
| V3, `en`, cfg 0 | English | 0.009 | 35.6 s | 0.933 |
| pt-br pack, `es` | **Portuguese** | **0.727** | 40.4 s | 0.958 |
| pt-br pack, `es`, cfg 0 | **Portuguese** | **0.664** | 45.3 s | 0.956 |
| es-mx pack, `es` | Spanish | 0.018 | 36.2 s | 0.950 |
| V3, `es` | Spanish | 0.000 | 36.1 s | 0.952 |

  The pt-br pack cannot speak Spanish. It reads Spanish text as Portuguese, e.g. "Sabes quando o tuo app se congelar enquanto descarga um arquivo" (`eval-all.log`). Its English is intelligible to the recogniser. V3 is intelligible in all three. "faber similarity" is the cosine between Chatterbox's own voice-encoder embedding of the output and of `faber.wav`.

## 2. Voice per language: faber's identity carries over; the accent needs ears

- Resemble's README: "Ensure that the reference clip matches the specified language tag. Otherwise, language transfer outputs may inherit the accent of the reference clip's language. To mitigate this, set the CFG weight to 0." (https://huggingface.co/ResembleAI/chatterbox; same text via Context7 `/resemble-ai/chatterbox` README "Original Chatterbox Tips").
- How the reference interacts with `language_id`: `prepare_conditionals` turns faber.wav into a speaker embedding, 150 speech-prompt tokens (first 6 s at 16 kHz) and an S3Gen reference (first 10 s) (`vendor/chatterbox/tts.py`, `prepare_conditionals`). `language_id` only touches the text tokens. So the speech prompt, which is Portuguese, conditions every language. That is the mechanism behind the accent warning.
- Measured: voice identity holds across languages, with faber similarity 0.92-0.96 for every full-script sample (table above). cfg 0 made English 12% longer (31.9 → 35.6 s) and slower to generate.
- An ASR cannot judge accent. Qwen3-ASR transcribed faber-English almost perfectly from both models, so a Brazilian accent, if present, does not hurt intelligibility. Whether it sounds acceptable is for the owner to decide by listening to `ptbr-en-*`, `v3-en-lang_en-cfg0.5.wav`, `v3-en-lang_en-cfg0.0.wav`, `v3-es-*` and `esmx-es-*`.
- Native CC0 reference voices per language were not sourced (see Unverified).

## 3. Alignment: 11 languages, and the word list is ours word for word in every space-separated one

- The pinned aligner's `config.json` lists `support_languages`: Chinese, Cantonese, English, German, Spanish, French, Italian, Portuguese, Russian, Korean, Japanese. Command: `python3 -c "…json.load(open(…/Qwen3-ForcedAligner-0.6B-8bit/snapshots/*/config.json))['support_languages']"`. Context7 `/blaizzy/mlx-audio` gives the same list (`mlx_audio/stt/models/qwen3_asr/README.md`).
- Chatterbox's 23 intersected with these 11 gives 10 languages that can be both spoken and timed: zh, en, de, es, fr, it, pt, ru, ko, ja.
- In the installed source, `language` only picks the word splitter. `ForceAlignProcessor.encode_timestamp` uses `tokenize_japanese`, `tokenize_korean` or `tokenize_chinese_mixed` for those three. Every other language goes to `tokenize_space_lang`: `text.split()`, keep letters, digits and `'`. `language` appears nowhere else in `generate` (`site-packages/mlx_audio/stt/models/qwen3_asr/qwen3_forced_aligner.py:139-147, 247-272, 680-697`). That is `alignerWords` in `packages/core/src/narration.ts`, with one exception: `tokenize_space_lang` also cuts out each CJK ideograph inside a token as its own word (`split_segment_with_chinese`, same file:118-137), and `alignerWords` does not. So for en, es, de, fr, it, ru and pt text with no CJK characters, the lists match by construction. Passing `"Portuguese"` for English audio would still split the same way.
- Measured: `alignMatch` was true for all 23 samples (`eval-all.log`), including the pt-br pack speaking English and Spanish. Short function words still get zero length (`a`, `the`, `un`, `de`, `el`), as in the v1 voice and TTS evaluation.
- Not safe: zh, ja and ko. Their splitters are not `alignerWords`, so `narrate()` would fail its word-list check twice and throw. Supporting them would need `alignerWords` to follow the same per-language split.

## 4. Pronunciation fixing per language

- Today: a script may write `{shown|spoken}`. Captions show `shown` and the voice says `spoken`. The Learner's `~/doomlearn/lexicon.json` maps shown term → spoken respelling. It is seeded from `packages/core/lexicon.default.json` (27 terms, all Brazilian-dev respellings or Portuguese letter names, e.g. `"thread": "tréd"`, `"API": "a pê í"`) (`packages/core/src/data.ts:48-56`). `narrate()` replaces lexicon terms, longest first, as whole words, ignoring case. It times each shown chunk by the span of its spoken words (`packages/core/src/narration.ts`). New `{shown|spoken}` terms from a script are added to the file (`newTerms` in `script.ts:67-78`, `pipeline.ts:389-406`).
- What assumes PT-BR: the prompts (`packages/agents/src/prompts/script.md:1,12,21`: "in Brazilian Portuguese", "a respelling a PT-BR voice reads right", "Portuguese letter names"; `verify.md:5`). Also the lexicon doc comment, `Media.speak` "Speaks `text` in PT-BR" (`packages/core/src/media.ts:49`), `language_id="pt"` in `tts/server.py` and `language="Portuguese"` in `align/server.py`.
- The engine offers nothing better:
  - No SSML: `generate()` takes plain text through `punc_norm` (`vendor/chatterbox/tts.py`).
  - Phonemes are not supported. The tokenizer vocab does contain an `[ipa]` token and IPA symbols (`ɪ ʊ ə θ ð ŋ ɹ ˈ ː` are all in `grapheme_mtl_merged_expanded_v1.json`). But nothing documents IPA input. A user on the tracker reports "the speech produced when using IPA is definitely not supported" (https://github.com/resemble-ai/chatterbox/issues/346), and IPA/phoneme input is an open feature request (https://github.com/resemble-ai/chatterbox/issues/550, opened 2026-08-15).
  - Measured: a full IPA sentence came back as "Three: Iselin a way execution instead of process." with `language_id="en"`, and as "Thread is a linear execution instead of processes." with `language_id="ipa"` (`v3-ipa_full-*`). Unusable.
- English voice and English tech terms are not a problem. V3 `en` with no respellings: thread, threads, app, race condition and mutex all came back exact (WER 0.000). What goes wrong instead:
  - Numbers: "The API returns 404…" came back "returns **44**" (`v3-en_hard-lang_en-cfg0.5.wav`). The same sentence in Spanish came back with "404" (`esmx-es_hard`).
  - Acronyms (API, CPU), percent, years and "Python 3.12" came back right in both. Whether an acronym was said as letters in the right language's letter names needs ears.
  - Code is already kept out of speech by `checkScript`'s `CODE` regex (`packages/core/src/script.ts`).
  - So an English lexicon would start almost empty and fix numbers-as-words cases. Respelling stays the tool, because it is the only input the engine has.
- Spanish: the es-mx pack read the bare English word "thread" and the respelling "tred". ASR heard "thread" both times (`esmx-es_short`, `esmx-es_resp`). A Spanish lexicon would be tuned by ear, like pt's.
- Limit of the objective check: Qwen3-ASR also heard "thread" for the un-respelled PT sentence, the respelled one and an inline IPA `θɹɛd` (`ptbr-pt_raw`, `ptbr-pt_resp`, `ptbr-pt_ipa`. Raw and respelled are WER 0 against the shown text. IPA is 0.091 only because its shown word is the IPA string itself: the transcript is the same "Uma thread é…"). The recogniser fills a term in from context, so it cannot rank respellings. Only the Learner's ear can, which is the method of the v1 voice evaluation.
- What a per-language lexicon needs, from the code paths above:
  1. Storage keyed by language: either `lexicon.json` → `{ "<lang>": { shown: spoken } }`, or one file per language. Each needs its own default file to seed it (pt = today's; en ~empty; es new).
  2. The Clip's language on the job and Clip. `narrate()`, `newTerms()` and the regenerate path (`pipeline.ts:279, 421-424`) then pick that language's lexicon.
  3. The prompts take the language: the "Brazilian Portuguese" lines, the respelling rule and the letter-name rule become per-language text. The `lexicon` key list given to the agent (`agent.ts:29-30`) is that language's.
  4. `tts.request.json` gains a language, and the server maps it to a model and a `language_id`. `align.request.json` gains a language name, which only matters for zh/ja/ko.
  5. `WORD_BUDGET` per language (answer 6).

## 5. Preview latency and memory

Same phrase through the real `packages/media/python/tts/server.py` protocol: "Uma tréd é uma linha de execução dentro de um processo." (11 words, ~3.5-4.5 s of audio). Command: `packages/media/python/tts/.venv/bin/python -I bench_preview.py <tts dir> <out>`, output `bench2.log`, rerun after the emulator had exited:

| Run | Spawn → ready | 1st request | Warm requests 2-4 |
|---|---|---|---|
| 1 | 16.12 s | 8.90 s | 6.80, 7.66, 6.80 s |
| 2 | 14.83 s | 8.04 s | 5.81, 5.98, 5.85 s |
| 3 | 14.74 s | 8.05 s | 6.50, 6.20, 5.86 s |

- Cold, from spawn to first audio: ~23-25 s. Warm: 5.8-7.7 s (RTF ~1.5-2.0, matching the v1 voice evaluation's 1.5-1.7). A Clip's ~38 s narration takes ~70-100 s.
- RAM of one TTS process (`footprint -p <pid>`): 5.8 GB after load, then 10-11 GB from the first generate on. `memprobe.py` explains why. `torch.mps.current_allocated_memory()` stays at 3.3 GiB, but `driver_allocated_memory()` rises from 3.6 to 8.6 GiB after the first `generate`. That growth is the MPS caching allocator. `torch.mps.empty_cache()` brought it back to 4.6 GiB (footprint 6.8 GB). `empty_cache` "Releases all unoccupied cached memory currently held by the caching allocator" (Context7 `/pytorch/pytorch`, `torch/mps/__init__.py`). `server.py` never calls it.
- A long multi-language run in one process (with the emulator beside it) had RTF fall to 11.5 (`ptbr.log`, `es` row). Its footprint and swap figures were not logged (see Unverified).
- Aligner process for comparison: ready in 1.5-1.7 s, 1.4 GB after load, 1.9 GB after aligning. Align times were 0.70-0.72 s the first time and 0.09-0.10 s after that (rechecked with a scratch `alignbench.py` spawning `align/server.py` on `preview-r0-0.wav`).
- A second TTS process beside the worker's does not fit. 2 × 10-11 GB is more than the 18 GB of RAM before the aligner, the server and the browser are counted.
- What the current TTS server keeps loaded: `serverTool("tts")` spawns `server.py` on the first `speak` and keeps it. The model (T3, S3Gen, voice encoder, tokenizer) and faber's conditionals stay in memory until the worker exits. `stop()` exists, but no app code calls it. `grep -rn "\.stop\b" apps packages --include='*.ts'` finds the `localMedia.stop` wrapper (`packages/media/src/local-media.ts:17-19`), which only `apps/server/src/smoke.test.ts:18` calls, plus unit-test and e2e server stops. See `packages/media/src/tools.ts:57-121` and `apps/server/src/worker.ts`. Its single stdin also serialises requests: one at a time, in order.
- What this means for a "hear it before regenerating" preview: a preview sent through the worker's warm process costs ~6-8 s. But it waits behind any narration in flight (up to ~1.5 min), so it needs a queue slot that runs ahead of jobs. Its own process costs ~23-25 s, and would swap unless the worker's TTS is idle and stopped.
- Correction: no path into the worker's warm TTS exists today, and a queued job cannot run ahead of a running one. Gap round 1, item 1 has the real queue and process model and the measured waits.

## 6. Script length per language

Spoken words (`alignerWords`) ÷ duration including the 150 ms gaps, faber 1.25× reference, cfg 0.5, seed 0, one sample each:

| Model, language | Words | Duration | Words/s | 85 words | 175 words |
|---|---|---|---|---|---|
| pt-br pack, pt | 106 | 37.9 s | 2.80 | 30 s | 62.5 s |
| V3, pt | 106 | 34.9 s | 3.04 | 28 s | 57.6 s |
| V3, en | 110 | 31.9 s | 3.45 | 25 s | 50.7 s |
| pt-br pack, en | 110 | 34.8 s | 3.16 | 27 s | 55.4 s |
| es-mx pack, es | 110 | 36.2 s | 3.04 | 28 s | 57.6 s |
| V3, es | 110 | 36.1 s | 3.05 | 28 s | 57.4 s |

- English runs ~20% faster per word than pt-BR. The same content took 31.9 s in English and 37.9 s in Portuguese. 175 English words fill only ~51 s, so an English budget could go to ~200 words for the same 60 s cap (`LIMIT.clipMs` in `pipeline.ts`).
- Spanish sits between the two. 175 words come to ~58 s, so today's budget fits.
- The pt-BR figure (2.80) is a little below the v1 voice evaluation's ~2.9. At 2.80, 175 words overruns 60 s by 2.5 s.

## Unverified

- **Accent.** No objective test separates a Brazilian accent in English or Spanish from a native one. ASR is accent-robust and fills terms from context. The wavs above are for the owner's ear, including the cfg 0 variants.
- **Native CC0 reference voices.** None were searched for or tested. Resemble's demo prompts (`storage.googleapis.com/chatterbox-demo-samples/...`) have no license stated in the Space code.
- **Variance.** Each words/s and WER figure is one seed-0 sample. Run-to-run spread was not measured.
- **Swapping a pack in one process.** The ~11-13 s full-model load was measured. Swapping only T3 while keeping S3Gen and the voice encoder was not.
- **Footprint with `empty_cache` in the loop.** The drop to 6.8 GB was measured once after five phrases. The long `synth.py` rerun with `empty_cache` per sentence still showed ~10 GB while generating. The steady state was not measured.
- **Timing noise.** The RTFs in answers 1-2 were measured while another agent's emulator and other sessions shared the Mac. Only answer 5's table comes from a quieter rerun.
- **zh/ja/ko.** Their alignment mismatch is argued from the source, not run.
- **English-only Chatterbox.** The original English model in the base repo (`t3_cfg`) is a third option for English beside V3 and was not loaded, timed or listened to. Whether the vendored loader takes it unchanged is also untested.
- **V3 with `s3gen_v3.pt`.** V3 was only run with `s3gen.pt`, as its Space does. If it works with the `s3gen_v3.pt` already cached for pt-br, English through V3 costs 2.14 GB, not 3.2 GB.
- **Peak footprint under load.** A 21 GB footprint and 20 GB of 20.5 GB swap during the long multi-language run, and a first benchmark (with the emulator up) showing 11-13 GB footprints, RSS ~0.3-0.5 GB and warm requests of 10-30 s, were observed but are not in any saved log. Only `bench2.log` exists.

## Gap round 1

### 1. How a preview reaches a warm TTS, and how long it waits

**The process model.** The server and the worker are separate processes. They share no TTS.
- `superviseWorker` starts the worker with `fork(file, { detached: true })` (`apps/server/src/supervisor.ts:42`). It only listens for `exit` and sends signals.
- The worker "reaches the server only through SQLite and `config.json`" (`apps/server/src/worker.ts:17`). Its only IPC use is `process.on("disconnect", quit)` (`worker.ts:32`).
- `grep -rnE '\.send\(|on\("message"|process\.send' apps packages --include='*.ts'` finds only `cdp.send` calls in `apps/web/e2e/feed.e2e.ts`. No app code sends or receives a message.
- `fork()` does open a channel. Node: fork "Spawns a new Node.js process and invokes a specified module with an IPC communication channel established that allows sending messages between parent and child", and `process.send()` delivers a `'message'` event on the parent's `ChildProcess` (Context7 `/nodejs/node`, `doc/api/child_process.md` and `doc/api/process.md`). A message path could be added without a new transport, but none exists today.
- The worker's TTS is `serverTool("tts")` (`packages/media/src/local-media.ts:6`), a module-level object inside the worker process. The server cannot call it.

**The queue.** `tick()` runs one stage of one job per call (`packages/core/src/pipeline.ts:506-595`).
- It picks the job with `orderBy(desc(status = 'running'), desc(priority), …)` (`pipeline.ts:525-530`). It sets the job to `running` at its first stage (`pipeline.ts:540`), and the job stays `running` until its finish tick sets it to `done`.
- So a Clip job, once started, wins every tick until it is done. That covers script, verify, narration, scene, render and the finish. A job of higher priority cannot start between its stages. Today that includes `regenerate`, the top priority (`JOB_PRIORITY = { regenerate: 3, new_angle: 2, new: 1, extract_chapter: 0 }`, `packages/core/src/schema.ts:19`).
- A gate rewrite (`rewrite()`, `pipeline.ts:309-321`) deletes `script.json`/`verify.json` and returns, and the job stays `running`. So two script rewrites and two duration rewrites (each one a new narration) all happen before the slot frees up.
- The slot frees early only when a stage throws. A `SceneFailed` or an `AgentFailed` sets the job back to `queued` (`pipeline.ts:571-585`), and a rate limit does the same (`pipeline.ts:563-569`).
- `tick()` returns `false` before it reads the queue while any gate holds: a Worker pause, outside the Run windows, a rate limit, or a usage threshold (`pipeline.ts:509-510`, `packages/core/src/status.ts:68-102`). At the daily cap, only `extract_chapter` and `regenerate` jobs are selectable (`pipeline.ts:521`). A media or agent preflight problem stops `tick()` from being called at all (`worker.ts:59`). As things stand, a preview job would be blocked by all of these, even though it costs no agent quota.
- When idle or gated, the worker polls every 5 s (`IDLE_POLL_MS`, `worker.ts:14, 59-60`). That adds up to 5 s even on an empty queue.

**The TTS call granularity.** A narration is one `speak` call for the whole text, then one `align` call, and the pair repeats on an alignment mismatch (`packages/core/src/narration.ts:91-94`). `server.py` reads stdin one line at a time (`packages/media/python/tts/server.py:43`). `serverTool`'s `ask` has no lock or queue of its own (`packages/media/src/tools.ts:94-117`). A second request written mid-call is only ordered by Python reading lines in turn.

**Measured waits.** These come from the 80 done Clip jobs on a DB copy (`sqlite3 ~/doomlearn/doomlearn.db "VACUUM INTO '<tmp>/doomlearn.db'"`), by R17's method: `agent_calls.at` is the call's start, and `clips.created_at` is the end. One job is excluded, because it ran 409464 s through a pause, which leaves 79. The scripts are `r16wait.py` and `r16stage.py` (`python3 -I <script> <tmp>/doomlearn.db`). The waits come from 200 000 arrivals spread uniformly over busy time, weighted by length, since longer jobs cover more of the clock.

```
whole job: median 332 p90 663 min 169            (first script call -> Clip insert, s)
narration: median 193 p90 357 min 86
scene+render: median 61 p90 71 max 86 min 46
wait if queued during a Clip job: median 191 p90 547 max 1847
wait if queued during narration: median 175 p90 340 max 543
stages 458; wait for the current stage to end: median 66 p90 253 max 475
share of busy time: script 5%, verify 3%, scene 11%, narration 71%, render 9%
```

The three options for the pronunciation preview, each with its real wait before the ~6-8 s warm synthesis (answer 5):

| Option | What it needs | Wait before it synthesises, while a Clip job runs | Cost |
|---|---|---|---|
| A. Preview as a top-priority job, today's `tick()` | A new job kind and priority. Exempt it from the gates and the cap, or it never runs in a pause, outside the Run windows or at the cap. | The rest of the running job: median **191 s**, p90 547 s, max seen 1847 s. During narration: median 175 s. | Warm TTS. Cold (~23-25 s) if the worker has not narrated since it started. |
| A'. Same, with `tick()` putting the preview ahead of `running` | A. plus an order change, e.g. a `kind = 'preview'` key first in `orderBy` (`pipeline.ts:525`). The interrupted Clip job resumes at its next stage file. | The rest of the current stage: median **66 s**, p90 253 s, max seen 475 s. Narration is 71% of busy time and dominates. | As A. |
| B. Worker serves previews between stages | A DB request table that the worker loop checks before `tick()`, or a new `process.on("message")` path through the fork channel. The loop must serve previews while gated, too. | Between stages, the same as A': median 66 s, p90 253 s. Handled in a message handler mid-stage, the request waits only for the `speak` call in flight. That call is the whole narration's TTS, ~70-100 s warm (answer 5), not split per beat. | Warm TTS. A concurrent `ask` needs a lock first (see Unverified). |
| C. Separate TTS in the server | Its own `serverTool("tts")` in the server process. | None from the queue. | ~23-25 s cold for each spawn. Kept warm, it is a second 6.8-11 GB process beside the worker's 10-11 GB on 18 GB of RAM (answer 5). Both also share one MPS GPU, which this round did not measure. |

- With the worker idle (empty queue), A and B wait ≤5 s for the next poll, then synthesise. A is still blocked by the gates.
- The R17 per-path figures (255-280 s) are how long a regenerate or remake takes once it starts. A `regenerate` queued after a preview waits behind the running job just as A does (median 191 s) before those 255 s start.
- So a preview that answers in seconds while the worker is busy needs C (paying cold start or memory), or B with a mid-stage path and a lock (paying up to one narration's TTS). A and A' answer in minutes.

## Unverified (Gap round 1)

- **Concurrent `ask` on one `serverTool`.** Two in-flight requests would share one readline async iterator, and each `next()` toggles `stdout.ref()/unref()` (`tools.ts:70-77`). Replies probably come back in order, but this was not run. The safe design is a lock around `ask`.
- **Busy-time share.** The waits above assume a preview arrives while a Clip job runs. How much of the day the worker is busy was not measured, and it depends on the buffer target and the Run windows.
- **Two TTS processes on one MPS GPU.** Throughput and memory with option C running beside a worker narration were not measured.
- **Stage times** are timestamp gaps, as in R17. The narration gap includes TTS redos after alignment mismatches and any duration rewrites.

## Gap round 2

### 1. Which of the 10 languages the burned-in text can draw

All 10 come out as real glyphs on this Mac. None is tofu. But only the Latin-script five plus English are drawn in Inter. Russian falls back to a **serif** font, and zh, ja and ko fall back to macOS system sans fonts.

**What Inter offers.** `@remotion/google-fonts` is pinned at 4.0.534 (`packages/media/package.json`). Its Inter metadata lists the subsets `cyrillic`, `cyrillic-ext`, `greek`, `greek-ext`, `latin`, `latin-ext` and `vietnamese` (`packages/media/node_modules/@remotion/google-fonts/dist/cjs/Inter.js:187-195`). It has no CJK subset. Each subset is an `@font-face` with its own `unicode-range`. `latin` is `U+0000-00FF, U+0131, U+0152-0153, …` and `cyrillic` is `U+0301, U+0400-045F, …` (same file, `unicodeRanges`). `loadFont` fetches only the subsets asked for (`dist/cjs/base.js:65-74`).

**What the harness asks for.** `loadFont("normal", { weights: ["500", "700", "800"], subsets: ["latin"] })` (`packages/media/remotion/harness.tsx:67`). `FONT` is the bare family `Inter` with no generic fallback. `Captions.tsx:25` and the scene contract (`remotion/api.md:34, 51`) use it.

- pt, es, fr, de, it and en need only Latin-1 plus `œ` (U+0153). All of that is in `latin`. So these six are drawn in Inter.
- ru needs U+0400-045F. That is not in `latin`, so Chrome falls back per character to a system font.
- zh, ja and ko have no Inter subset at all. They always fall back.

**The check.** It rendered one still through the real harness files (`index.ts`, `Root.tsx`, `Captions.tsx`, `harness.tsx`, `pages.ts`, copied as `render()` copies them, `packages/media/src/render.ts:31-33`). It used Remotion's `bundle` + `renderStill`, frame 15. The scene draws one label per language at weight 800. The caption words are Russian (`Поток выполнения внутри процесса.`). The script is `r16-glyphs/run.mjs` in the scratchpad (`node run.mjs <packages/media> <dir>`). The first run downloaded Remotion's Chrome Headless Shell 157.0.8080.0 for mac-arm64 (170.9 MB) into the worktree's `packages/media/node_modules/.remotion/`.

Results, by looking at the still and by pixel-comparing rows (PIL `ImageChops.difference(...).getbbox()`, `None` means identical):

| Lang | Today (`subsets: ["latin"]`) | Font drawn |
|---|---|---|
| pt, es, fr, de, it, en | Correct, all accents and `ß`, `Œ`, `¿` | Inter 800 |
| ru, scene label and caption | Readable, but a bold **serif**. It clashes with Inter on the same line, and the black caption stroke still applies. | A system serif. It is not pixel-identical to `Times` or `Times New Roman`, so the exact face is unnamed. |
| zh | Correct | `PingFang SC`, pixel-identical |
| ja | Correct, kana and kanji | `PingFang SC`, pixel-identical. So kanji take Chinese glyph forms, since nothing sets `lang="ja"`. |
| ko | Correct | A Korean system sans. It is not pixel-identical to `Apple SD Gothic Neo` or `AppleGothic`, so the exact face is unnamed. |

```
0 1 differs (61, 15, 684, 71)     ru FONT vs Times
0 2 differs (61, 16, 687, 71)     ru FONT vs Times New Roman
3 4 identical                     zh FONT vs PingFang SC
6 8 identical                     ja FONT vs PingFang SC
9 10 differs (61, 5, 591, 76)     ko FONT vs Apple SD Gothic Neo
```

**The fix for ru is one word.** The same render with `subsets: ["latin", "cyrillic"]` patched into the copied `harness.tsx` draws the Russian label and caption in Inter 800, matching the Latin lines. It costs three more woff2 fetches, one per weight. Stills:
- today: `r16-glyphs/still.png`
- fallback candidates: `r16-glyphs/v2/still.png`
- with cyrillic: `r16-glyphs/v3/still.png`

**What this means for a Clip's language.**
- The six languages that are already safe for alignment (en, es, de, fr, it, pt) are also drawn correctly in Inter today. The render does not shrink that list.
- ru is drawable but off-style until `cyrillic` is added to `loadFont`. That one-line change belongs in the spec if ru is offered.
- zh, ja and ko draw through macOS system fonts. They are already excluded by the alignment mismatch (answer 3 above). Captions would also be wrong for them for a second reason: `captionPages` joins words with a leading space (`remotion/pages.ts:24`), which puts spaces between CJK words. Offering them later would also need a CJK font choice (Inter has none) and `lang` for ja.

## Unverified (Gap round 2)

- **Fallback on another host.** The ru/zh/ja/ko fallbacks above are this Mac's system fonts. A render on Linux or in a container without CJK fonts could show tofu. doomlearn renders locally on the Mac today, but this was not checked elsewhere.
- **The exact ru and ko fallback faces** are unnamed. Pixel comparison ruled out only the candidates listed.
- Only a still was rendered, not a full Clip with audio and the ffmpeg mix. The text path is the same, because `renderMedia` and `renderStill` draw frames from the same bundle.
