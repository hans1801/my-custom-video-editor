"""Face restoration for one clip range: FFmpeg decodes frames (after the optional
deflicker chain), GFPGAN v1.4 restores the center face, the result is mixed
60 % restored / 40 % original and FFmpeg encodes it with the finishing chain.

Progress: JSON lines {"stage":"face","done":n,"total":m} on stdout.
"""

import argparse
import subprocess
import sys
import time

import cv2
import numpy as np

from common import emit, load_face_restorer, pick_device

WEIGHT = 0.4  # GFPGAN fidelity weight
BLEND = 0.6  # share of the restored frame in the final mix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--fps", required=True)  # rational, e.g. 30000/1001
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--frames", type=int, required=True)
    ap.add_argument("--pre", default="")  # filters before restoration (deflicker)
    ap.add_argument("--post", required=True)  # filters after the mix
    a = ap.parse_args()

    device = pick_device()
    emit(stage="face", status="loading", device=device.type)
    restorer = load_face_restorer(device)

    w, h = a.width, a.height
    pre = ",".join(f for f in [a.pre, f"fps={a.fps}", f"scale={w}:{h}:flags=bicubic", "format=bgr24"] if f)
    dec = subprocess.Popen(
        [a.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", f"{a.start:.6f}", "-t", f"{a.duration:.6f}", "-i", a.input,
         "-an", "-vf", pre, "-frames:v", str(a.frames), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE,
    )
    enc = subprocess.Popen(
        [a.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-r", a.fps, "-i", "-", "-vf", f"{a.post},format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "15",
         "-movflags", "+faststart", a.output],
        stdin=subprocess.PIPE,
    )

    size = w * h * 3
    done = 0
    faces = 0
    t0 = time.perf_counter()
    last = 0.0
    while True:
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        _, restored_faces, restored = restorer.enhance(frame, has_aligned=False, only_center_face=True, paste_back=True, weight=WEIGHT)
        if restored is not None and restored_faces:
            faces += 1
            if restored.shape != frame.shape:
                restored = cv2.resize(restored, (w, h), interpolation=cv2.INTER_AREA)
            frame = cv2.addWeighted(restored, BLEND, frame, 1 - BLEND, 0)
        enc.stdin.write(np.ascontiguousarray(frame).tobytes())
        done += 1
        now = time.perf_counter()
        if now - last > 0.25:
            emit(stage="face", done=done, total=a.frames, faces=faces, elapsed=round(now - t0, 2))
            last = now

    dec.wait()
    enc.stdin.close()
    if enc.wait() != 0 or dec.returncode != 0:
        sys.exit("FFmpeg falló al leer o escribir los cuadros")
    if done == 0:
        sys.exit("No se leyó ningún cuadro del clip")
    emit(stage="face", done=done, total=a.frames, faces=faces, elapsed=round(time.perf_counter() - t0, 2), finished=True)


if __name__ == "__main__":
    main()
