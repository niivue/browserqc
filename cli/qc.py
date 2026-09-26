#!/usr/bin/env python3
"""BrowserQC without a browser: the page's pipeline on the native executables, which
must be on PATH (or in $BROWSERQC_BIN). Standard library only, Python 3.8+.
  brainchop-<model>  https://github.com/neuroneural/brainchopC/releases
  niimath            https://pypi.org/project/niimath/  (--qc --pve needs v1.0.20260926+)

  python3 cli/qc.py --in T1.nii[.gz] --out qc.json [--model 16chan18cls|mindmap|mindsnap|mindmap-pve] [--bids sidecar.json]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = json.loads((ROOT / "src" / "models.json").read_text())
TEMPLATE = ROOT / "public" / "avg152T1.nii.gz"


def run(exe, *args, path):
    found = shutil.which(exe, path=path)
    if not found:
        raise RuntimeError(f"{exe} not found: put it on PATH or in $BROWSERQC_BIN")
    if subprocess.run([found, *map(str, args)], stdout=subprocess.DEVNULL).returncode:
        raise RuntimeError(f"{exe} failed")


def main():
    parser = argparse.ArgumentParser(description="MRIQC-style QC of a T1 image with brainchop + niimath.")
    parser.add_argument("--in", dest="input", required=True, help="T1.nii[.gz]")
    parser.add_argument("--out", required=True, help="report JSON")
    parser.add_argument("--model", default="16chan18cls", choices=list(MODELS))
    parser.add_argument("--bids", help="BIDS sidecar to embed as bids_meta")
    args = parser.parse_args()
    path = os.pathsep.join(filter(None, [os.environ.get("BROWSERQC_BIN"), os.environ.get("PATH")]))
    model = MODELS[args.model]
    t1 = os.path.abspath(args.input)  # a leading '-' must not read as an option
    with tempfile.TemporaryDirectory(prefix="browserqc-") as tmp:
        tmp = Path(tmp)
        if model.get("pve"):
            run(f"brainchop-{model['pve']}", t1, "--pve", "-o", tmp / "pve.nii", path=path)  # writes pve_{gm,wm,csf}.nii
            tissues = ["--pve", *(tmp / f"pve_{t}.nii" for t in ("csf", "gm", "wm"))]
        else:
            run(f"brainchop-{args.model}", t1, "-o", tmp / "seg.nii", path=path)
            tissues = ["--seg", tmp / "seg.nii", "--csf", ",".join(map(str, model["csf"])),
                       "--wm", ",".join(map(str, model["wm"]))]
        run("niimath", "--qc", t1, *tissues, "--air", TEMPLATE, "--json", tmp / "qc.json", path=path)
        report = json.loads((tmp / "qc.json").read_text())
    # Match the page's report: its provenance and bids_meta, and the template's bare name.
    report["provenance"]["air_template"] = TEMPLATE.name
    report["provenance"]["segmentation"] = f"brainchop {args.model} ({model['label']})"
    if args.bids:
        report["bids_meta"] = json.loads(Path(args.bids).read_text())
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as err:  # ValueError: a malformed --bids sidecar
        sys.exit(f"error: {err}")
