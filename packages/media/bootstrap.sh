#!/bin/sh
# Builds every media environment from its lock, explicitly (never from `pnpm start`): the repo-local uv in .uv/
# (installed with the system python3, the only use of it), one venv per tool under python/ (on uv's own Python 3.12),
# the pinned model weights (size in the README, in the default HF cache) and Remotion's headless
# browser. Run it after cloning and whenever the server says to.
set -e
cd "$(dirname "$0")"
[ -x .uv/bin/python ] || python3 -m venv .uv
.uv/bin/pip install --quiet --disable-pip-version-check -r python/requirements-uv.txt
for project in python/*/; do
  .uv/bin/uv sync --locked --project "$project"
  [ ! -f "$project/weights.py" ] || "$project/.venv/bin/python" "$project/weights.py"
done
pnpm exec remotion browser ensure
