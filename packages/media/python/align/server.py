"""
Alignment runtime: Qwen3-ForcedAligner-0.6B-8bit through mlx-audio.

Protocol (packages/media/contracts/align.*.json): once the model has loaded, one ready line
{"ready": true, "backend"}, or {"error"} and exit if it failed to load. Then one JSON request per
stdin line, {"audio", "text", "language"}; answers {"words": [{"word", "startMs", "endMs"}]}, or {"error"},
on one stdout line.
"""
import json
import sys

from mlx_audio.stt import load

from weights import ALIGNER, snapshot

# Library prints must not corrupt the protocol.
protocol, sys.stdout = sys.stdout, sys.stderr

try:
    aligner = load(str(snapshot(*ALIGNER)))
except Exception as error:
    print(json.dumps({"error": repr(error)}), file=protocol, flush=True)
    sys.exit(1)
print(json.dumps({"ready": True, "backend": "qwen3-aligner-mlx"}), file=protocol, flush=True)

for line in sys.stdin:
    try:
        request = json.loads(line)
        # The language only picks the word splitter.
        items = aligner.generate(request["audio"], text=request["text"], language=request["language"])
        words = [{"word": i.text, "startMs": round(i.start_time * 1000), "endMs": round(i.end_time * 1000)} for i in items]
        reply = {"words": words}
    except Exception as error:
        reply = {"error": repr(error)}
    print(json.dumps(reply), file=protocol, flush=True)
