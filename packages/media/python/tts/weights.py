"""
The TTS runtime's Hugging Face weights, pinned to the commits the voice was judged on, in the default HF cache.
`python weights.py` downloads what is missing (run by `pnpm bootstrap`); `--check` only looks in the cache and
fails when a file is missing: the pt-br pack and the base model, or with `--check <checkpoint>` (e.g. `v3`), that
checkpoint alone.
A pinned commit that is cached makes no HTTP call.
"""
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

# The Brazilian Portuguese pack. s3gen_v3.safetensors (1 GB) is the same model as s3gen_v3.pt and is never fetched.
PT_BR = ("ResembleAI/Chatterbox-Multilingual-pt-br", "b3952f18bc2eaa72b9bd7c17d2c4653bcad4770d",
         ["t3_pt_br.safetensors", "s3gen_v3.pt"])
# The base model: voice encoder, tokenizer and built-in conditionals.
BASE = ("ResembleAI/chatterbox", "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18",
        ["ve.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt"])
# Multilingual V3, the voice of English and Spanish: its T3 and the S3Gen its Space loads, from the base repo.
V3 = ("ResembleAI/chatterbox", "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18",
      ["t3_mtl23ls_v3.safetensors", "s3gen.pt"])
# Each TTS checkpoint a Language names (`tts.checkpoint` in packages/core/src/languages.ts): its T3, then its S3Gen.
CHECKPOINTS = {"pt-br": PT_BR, "v3": V3}


def snapshot(repo, commit, files, local_files_only=False):
    """The snapshot folder holding `files` of `repo` at `commit`, downloading the missing ones."""
    for file in files:
        path = hf_hub_download(repo, file, revision=commit, local_files_only=local_files_only)
    return Path(path).parent


if __name__ == "__main__":
    if "--check" not in sys.argv:
        for pinned in (PT_BR, BASE, V3):
            snapshot(*pinned)
    else:
        # `--check <checkpoint>` looks for that checkpoint alone; a bare `--check`, for the pt-br pack and the base model.
        rest = sys.argv[sys.argv.index("--check") + 1:]
        checkpoint = rest[0] if rest else "pt-br"
        for pinned in (PT_BR, BASE) if checkpoint == "pt-br" else (CHECKPOINTS[checkpoint],):
            snapshot(*pinned, local_files_only=True)
