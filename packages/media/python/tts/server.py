"""
TTS runtime: Chatterbox on PyTorch MPS, cloning the CC0 speaker faber (Nabu Casa pt_BR, OHF-Voice/voice-datasets).
faber.wav is utterances 2-4 concatenated (~18 s) and sped 1.25x with ffmpeg atempo.
Each request names its voice: the Brazilian Portuguese pack (`pt-br`) or Multilingual V3 (`v3`, every other
Language), with its language_id. One model is in memory at a time: a request for another checkpoint loads it in place
of the current one (about 11-13 s).

The pip package has no loader for the single-language packs, so vendor/chatterbox is the
package vendored from Resemble's demo Space ResembleAI/Chatterbox-Multilingual-TTS-pt-br
at commit 9e515821e826e207cd617a0fdd0223899ed108ea (MIT, see vendor/chatterbox/LICENSE), its loader
changed to read the pinned snapshot folders from weights.py. It loads V3 unchanged.

Protocol (packages/media/contracts/tts.*.json): once the pt-br model has loaded, one ready line
{"ready": true, "backend"}, or {"error"} and exit if it failed to load. Then one JSON request per
stdin line, {"text", "out", "language": {"checkpoint", "languageId", "nfkd"}}; writes the wav to `out` and answers
{"durationMs"}, measured from the written audio, or {"error"}, on one stdout line.
"""
import gc
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

HERE = Path(__file__).parent
# The vendored package must shadow the pip-installed `chatterbox`.
sys.path.insert(0, str(HERE / "vendor"))
from chatterbox.tts import ChatterboxTTS  # noqa: E402
from weights import BASE, CHECKPOINTS, snapshot  # noqa: E402

# Library prints must not corrupt the protocol.
protocol, sys.stdout = sys.stdout, sys.stderr


def load(checkpoint):
    """Chatterbox with `checkpoint`'s T3 and S3Gen (CHECKPOINTS in weights.py) and the base repo's rest, cloning faber."""
    repo, commit, (t3, s3gen) = CHECKPOINTS[checkpoint]
    folder = snapshot(repo, commit, [t3, s3gen])
    loaded = ChatterboxTTS.from_local(snapshot(*BASE), "mps", t3_filename=folder / t3, s3gen_filename=folder / s3gen)
    loaded.prepare_conditionals(str(HERE / "faber.wav"), exaggeration=0.5)
    return loaded


checkpoint = "pt-br"
try:
    model = load(checkpoint)
except Exception as error:
    print(json.dumps({"error": repr(error)}), file=protocol, flush=True)
    sys.exit(1)
print(json.dumps({"ready": True, "backend": "chatterbox-mps"}), file=protocol, flush=True)

for line in sys.stdin:
    try:
        request = json.loads(line)
        voice = request["language"]
        if voice["checkpoint"] != checkpoint:
            # The current model goes first, so two never share the memory. Cleared before the load, so a failed one
            # is retried on the next request.
            model = checkpoint = None
            gc.collect()
            torch.mps.empty_cache()
            model = load(voice["checkpoint"])
            checkpoint = voice["checkpoint"]
        text = request["text"].strip()
        # As V3's own tokenizer does (`text_preproc` in its Space); the vendored one doesn't.
        if voice["nfkd"]:
            text = unicodedata.normalize("NFKD", text)
        # 150 ms of silence after each sentence.
        gap = np.zeros(int(0.15 * model.sr), dtype=np.float32)
        parts = []
        # Sentence by sentence: Chatterbox degrades on long single prompts.
        for sentence in re.split(r"(?<=[.?!:])\s+", text):
            wav = model.generate(sentence, exaggeration=0.5, cfg_weight=0.5, language_id=voice["languageId"])
            parts += [wav.squeeze(0).numpy(), gap]
        sf.write(request["out"], np.concatenate(parts), model.sr)
        reply = {"durationMs": round(sf.info(request["out"]).duration * 1000)}
    except Exception as error:
        reply = {"error": repr(error)}
    print(json.dumps(reply), file=protocol, flush=True)
