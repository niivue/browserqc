#!/usr/bin/env bash
# BrowserQC from the command line: the pipeline the web page runs, on two native
# executables that must be on PATH.
#   brainchop-16chan18cls  https://github.com/neuroneural/brainchopC/releases
#   niimath                https://pypi.org/project/niimath/  (needs --air/--json)
#
#   ./browserqc.sh T1.nii[.gz] qc.json
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <input.nii[.gz]> <output.json>" >&2
  exit 1
fi
in=$1
out=$2
template=$(cd "$(dirname "$0")" && pwd)/public/avg152T1.nii.gz

# The segmentation is scratch: its own directory, removed on any exit.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

brainchop-16chan18cls "$in" -o "$tmp/seg.nii"
niimath --qc "$in" --seg "$tmp/seg.nii" --csf 3,4,11,12 --wm 1,5 --air "$template" --json "$out"
