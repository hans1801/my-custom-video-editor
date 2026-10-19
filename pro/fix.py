"""Fix words that came out robotic (palabra.py): inside each chosen range,
blend the enhanced voice with Resemble's clean-only version (natural, without
reconstructed highs). The clean version is level-matched to the enhanced one
over that range, with 60 ms fades at both ends. mix=1 uses only the clean
version, 0.5 half and half. Ranges are applied one after another.

Usage: fix.py enhanced.wav clean.wav out.wav '[{"start":2.78,"end":3.75,"mix":1.0}]'
"""

import json
import sys

import numpy as np
import soundfile as sf

FADE_S = 0.06


def main():
    a, sr = sf.read(sys.argv[1])
    d, sr2 = sf.read(sys.argv[2])
    if sr2 != sr:
        import librosa

        d = librosa.resample(d, orig_sr=sr2, target_sr=sr)
    d = np.pad(d, (0, max(0, len(a) - len(d))))[: len(a)]
    f = int(FADE_S * sr)
    for fix in json.loads(sys.argv[4]):
        i0 = max(0, min(len(a), int(float(fix["start"]) * sr)))
        i1 = max(i0, min(len(a), int(float(fix["end"]) * sr)))
        mix = max(0.0, min(1.0, float(fix["mix"])))
        if i1 - i0 < f // 2 or mix == 0:
            continue
        g = np.sqrt((a[i0:i1] ** 2).mean() / ((d[i0:i1] ** 2).mean() + 1e-12))
        m = np.zeros(len(a))
        m[i0:i1] = 1
        lead = min(f, i0)
        m[i0 - lead : i0] = np.linspace(0, 1, lead, endpoint=False)
        tail = min(f, len(a) - i1)
        m[i1 : i1 + tail] = np.linspace(1, 0, tail)
        m *= mix
        a = a * (1 - m) + d * g * m
    sf.write(sys.argv[3], a, sr, subtype="PCM_16")


if __name__ == "__main__":
    main()
