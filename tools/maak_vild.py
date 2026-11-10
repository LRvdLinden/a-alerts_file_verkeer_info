#!/usr/bin/env python3
"""VILD location table of the NDW (open data, https://opendata.ndw.nu/VILD*.zip) → data/vild.json.
Per location code: kind (P point / L line), description, road number, first and second name, exit number,
the line it lies on, and its neighbours. Used to describe traffic as "A1 richting Amersfoort, tussen … en …".
Usage: python3 tools/maak_vild.py <VILD….dbf> [versie]"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from dbf import lees
_, rijen = lees(sys.argv[1])
uit = {}
for r in rijen:
    t = r["LOC_TYPE"][:1]
    if t not in ("P", "L"): continue
    uit[r["LOC_NR"]] = [t, r["LOC_DES"], r["ROADNUMBER"], r["FIRST_NAME"], r["SECND_NAME"], r["EXIT_NR"], r["LIN_REF"], r["NEG_OFF"], r["POS_OFF"]]
pad = os.path.join(os.path.dirname(__file__), "..", "data", "vild.json")
json.dump({"versie": sys.argv[2] if len(sys.argv) > 2 else "", "locaties": uit}, open(pad, "w"), ensure_ascii=False, separators=(",", ":"))
print(len(uit), "locaties", os.path.getsize(pad), "bytes")
