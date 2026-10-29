"""
The alignment runtime's Hugging Face weights, pinned to one commit, in the default HF cache.
`python weights.py` downloads what is missing (run by `pnpm bootstrap`); `--check` only looks in the cache and
fails when a file is missing. A pinned commit that is cached makes no HTTP call.
"""
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

ALIGNER = ("mlx-community/Qwen3-ForcedAligner-0.6B-8bit", "0e1a68e91d815300c7c9754b2a7639378b23db15",
           ["config.json", "generation_config.json", "chat_template.json", "preprocessor_config.json",
            "tokenizer_config.json", "vocab.json", "merges.txt", "model.safetensors", "model.safetensors.index.json"])


def snapshot(repo, commit, files, local_files_only=False):
    """The snapshot folder holding `files` of `repo` at `commit`, downloading the missing ones."""
    for file in files:
        path = hf_hub_download(repo, file, revision=commit, local_files_only=local_files_only)
    return Path(path).parent


if __name__ == "__main__":
    snapshot(*ALIGNER, local_files_only="--check" in sys.argv)
