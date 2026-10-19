"""Patch the installed packages and download the models (idempotent).

Run with the pro/.venv interpreter; setup.sh calls it after pip install.
"""

import sys
import sysconfig
import urllib.request
from pathlib import Path

from common import GFPGAN_PATH, MODELS, RESEMBLE_DIR, RESEMBLE_RUN_DIR

GFPGAN_URL = "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth"
SITE = Path(sysconfig.get_paths()["purelib"])

PATCHES = [
    # scipy returns an array; float() of a 1-element array is deprecated/broken.
    (
        "resemble_enhance/enhancer/lcfm/cfm.py",
        "float(scipy.optimize.fsolve(lambda a: h(1 / n, a) - 0.5, x0=0))",
        "float(scipy.optimize.fsolve(lambda a: h(1 / n, a) - 0.5, x0=0)[0])",
    ),
    # torchvision removed functional_tensor.
    (
        "basicsr/data/degradations.py",
        "from torchvision.transforms.functional_tensor import rgb_to_grayscale",
        "from torchvision.transforms.functional import rgb_to_grayscale",
    ),
]


def patch():
    for rel, old, new in PATCHES:
        path = SITE / rel
        text = path.read_text()
        if new in text:
            print(f"ya parcheado: {rel}")
        elif old in text:
            path.write_text(text.replace(old, new))
            print(f"parcheado: {rel}")
        else:
            sys.exit(f"no encuentro el texto a parchear en {rel}")


def download():
    MODELS.mkdir(parents=True, exist_ok=True)
    if not GFPGAN_PATH.exists():
        print("bajando GFPGANv1.4.pth…")
        tmp = GFPGAN_PATH.with_suffix(".part")
        urllib.request.urlretrieve(GFPGAN_URL, tmp)
        tmp.rename(GFPGAN_PATH)
    print(f"GFPGAN: {GFPGAN_PATH.stat().st_size / 1e6:.0f} MB")

    from huggingface_hub import snapshot_download

    snapshot_download("ResembleAI/resemble-enhance", allow_patterns=["enhancer_stage2/*"], local_dir=RESEMBLE_DIR)
    size = sum(p.stat().st_size for p in RESEMBLE_RUN_DIR.rglob("*") if p.is_file())
    print(f"Resemble Enhance: {size / 1e6:.0f} MB en {RESEMBLE_RUN_DIR}")


if __name__ == "__main__":
    patch()
    download()
