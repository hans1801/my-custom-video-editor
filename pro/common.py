"""Shared helpers for the Mejoras Pro workers (local only, no cloud).

Models live in pro/models (downloaded once by prepare.py).
"""

import json
import os
import sys
import types
from pathlib import Path

PRO_DIR = Path(__file__).resolve().parent
MODELS = PRO_DIR / "models"
GFPGAN_PATH = MODELS / "GFPGANv1.4.pth"
RESEMBLE_DIR = MODELS / "resemble-enhance"
RESEMBLE_RUN_DIR = RESEMBLE_DIR / "enhancer_stage2"

# Ops that MPS lacks fall back to the CPU instead of failing.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def stub_deepspeed():
    """resemble-enhance imports deepspeed for training only. Register an empty
    stand-in (any attribute is an inert placeholder class) so inference imports."""
    if "deepspeed" in sys.modules:
        return

    class Stub(types.ModuleType):
        def __getattr__(self, name):
            if name.startswith("__"):
                raise AttributeError(name)
            placeholder = type(name, (), {})
            setattr(self, name, placeholder)
            return placeholder

    for name in ["deepspeed", "deepspeed.accelerator", "deepspeed.runtime", "deepspeed.runtime.engine", "deepspeed.runtime.utils"]:
        sys.modules[name] = Stub(name)


def pick_device():
    import torch

    forced = os.environ.get("MYEDITOR_PRO_DEVICE")  # cpu / mps / cuda, to compare or work around a backend
    if forced:
        return torch.device(forced)

    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def load_face_restorer(device):
    """GFPGAN v1.4, face only (no background upsampler)."""
    from gfpgan import GFPGANer

    # facexlib fetches its detector/parser weights into ./gfpgan/weights on first use.
    os.chdir(MODELS)
    return GFPGANer(model_path=str(GFPGAN_PATH), upscale=1, arch="clean", channel_multiplier=2, bg_upsampler=None, device=device)


def load_voice_enhancer(device):
    stub_deepspeed()
    from resemble_enhance.enhancer.inference import load_enhancer

    model = load_enhancer(RESEMBLE_RUN_DIR, device)
    if device.type == "mps" and os.environ.get("MYEDITOR_PRO_MPS_VOCODER") != "1":
        keep_vocoder_on_cpu(model, device)
    return model


def keep_vocoder_on_cpu(model, device):
    """On Apple GPUs (MPS, torch 2.14) the UnivNet vocoder returns wrong audio:
    near-silence plus steady tones at 44100/3, /6 and /12 Hz, while every other
    part matches the CPU exactly. Run only the vocoder on the CPU; the heavy
    part (the CFM with nfe=128) stays on the GPU."""
    vocoder = model.vocoder
    if getattr(vocoder, "_on_cpu", False):
        return
    vocoder.to("cpu")
    forward = vocoder.forward

    def cpu_forward(x, y=None, npad=10):
        out = forward(x.to("cpu"), None if y is None else y.to("cpu"), npad)
        return out.to(device)

    vocoder.forward = cpu_forward
    vocoder._on_cpu = True


def emit(**kw):
    """One JSON line on stdout; the Node server reads these for progress."""
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()
