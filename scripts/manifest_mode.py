#!/usr/bin/env python3
from pathlib import Path
import json
import sys

root = Path(__file__).resolve().parents[1]
prod = root / "manifest.prod.json"
manifest = root / "manifest.json"
test = root / "manifest.test.json"

mode = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
if mode not in {"test", "prod"}:
    raise SystemExit("Usage: python3 scripts/manifest_mode.py [test|prod]")

if mode == "test":
    if not prod.exists():
        prod.write_text(manifest.read_text())
    manifest.write_text(test.read_text())
    print("Switched manifest.json to TEST mode (localhost:4173 enabled).")
else:
    if prod.exists():
        manifest.write_text(prod.read_text())
    else:
        data = json.loads(manifest.read_text())
        data["name"] = "TTD FastFill"
        data["host_permissions"] = ["https://ttdevasthanams.ap.gov.in/*"]
        data["content_scripts"][0]["matches"] = ["https://ttdevasthanams.ap.gov.in/*"]
        manifest.write_text(json.dumps(data, indent=2) + "\n")
    print("Switched manifest.json to PROD mode.")
