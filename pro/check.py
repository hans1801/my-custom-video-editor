"""Load both models on the best device and time one synthetic pass of each
(random noise / a blank frame, no user media). Writes models/status.json,
which the server uses for availability and time estimates."""

import json
import platform
import time

import numpy as np
import torch

from common import MODELS, RESEMBLE_RUN_DIR, emit, load_face_restorer, load_voice_enhancer, pick_device


def sync(device):
    if device.type == "mps":
        torch.mps.synchronize()
    elif device.type == "cuda":
        torch.cuda.synchronize()


def main():
    device = pick_device()
    status = {"device": device.type, "torch": torch.__version__, "machine": platform.machine(), "ok": False}

    t = time.perf_counter()
    restorer = load_face_restorer(device)
    status["face_load_s"] = round(time.perf_counter() - t, 2)
    # Detection on a 1080p frame plus one 512x512 restoration ≈ the per-frame cost with one face.
    frame = np.zeros((1080, 1920, 3), np.uint8)
    face = torch.rand(1, 3, 512, 512, device=device) * 2 - 1
    for i in range(3):  # first pass warms up
        t = time.perf_counter()
        restorer.face_helper.clean_all()
        restorer.face_helper.read_image(frame)
        restorer.face_helper.get_face_landmarks_5(only_center_face=True, eye_dist_threshold=5)
        with torch.no_grad():
            restorer.gfpgan(face, return_rgb=False, weight=0.4)
        sync(device)
        per_frame = time.perf_counter() - t
    status["face_s_per_frame"] = round(per_frame, 3)
    emit(stage="face", loaded=True, s_per_frame=status["face_s_per_frame"])

    t = time.perf_counter()
    load_voice_enhancer(device)
    status["voice_load_s"] = round(time.perf_counter() - t, 2)
    from resemble_enhance.enhancer.inference import enhance

    # Synthetic voice-like sound (harmonics of a gliding 140 Hz, syllable-like
    # bursts) followed by silence. A correct result keeps the loud part's level
    # and leaves the silence silent; a broken backend gives near-silence or tones.
    sr_in = 44100
    seconds = 3.0
    n = int(sr_in * seconds)
    t_ax = torch.arange(n) / sr_in
    f0 = 140 + 20 * torch.sin(2 * torch.pi * 0.7 * t_ax)
    phase = 2 * torch.pi * torch.cumsum(f0, 0) / sr_in
    voiced = sum(torch.sin(k * phase) / k for k in range(1, 25))
    bursts = (torch.sin(2 * torch.pi * 3 * t_ax).clamp(min=0) ** 0.5)
    signal = 0.1 * voiced * bursts
    signal[int(sr_in * 2.0):] = 0
    signal += torch.randn(n) * 1e-4
    t = time.perf_counter()
    out, sr = enhance(signal, sr_in, device, nfe=128, solver="midpoint", lambd=0.9, tau=0.1, run_dir=RESEMBLE_RUN_DIR)
    sync(device)
    status["voice_s_per_s"] = round((time.perf_counter() - t) / seconds, 3)
    status["voice_out_sr"] = sr
    rms = lambda x: 20 * torch.log10(x.pow(2).mean().sqrt() + 1e-12).item()
    loud_in, loud_out = rms(signal[: int(sr_in * 1.8)]), rms(out[: int(sr * 1.8)])
    quiet_out = rms(out[int(sr * 2.3):])
    status["voice_check"] = {"loud_in_db": round(loud_in, 1), "loud_out_db": round(loud_out, 1), "silence_out_db": round(quiet_out, 1)}
    if abs(loud_out - loud_in) > 12 or loud_out - quiet_out < 30:
        (MODELS / "status.json").write_text(json.dumps(status, indent=2))
        raise SystemExit(f"La mejora de voz da un resultado incorrecto en {device.type}: {status['voice_check']}")
    emit(stage="voice", loaded=True, s_per_s=status["voice_s_per_s"], check=status["voice_check"])

    status["ok"] = True
    (MODELS / "status.json").write_text(json.dumps(status, indent=2))
    print(json.dumps(status, indent=2))


if __name__ == "__main__":
    main()
