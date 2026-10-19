"""Voice enhancement for one mono WAV, following the approved recipe
(mejorar_voz.py): Resemble Enhance (nfe=128, midpoint, lambd=0.9, tau=0.1),
chunked exactly like resemble_enhance.inference so progress can be reported.

- Several passes (--passes): each pass of the model comes out different, so it
  can run N times and keep the one closest to the original (fidelidad.py).
- --clean also writes Resemble's clean-only version (denoise, no
  reconstruction): it sounds natural, and fix.py blends it into a word that
  came out robotic (palabra.py).
- Afterwards it looks for steady high-pitched tones (whines) in the result and
  reports them; the server notches the known ~14.7 kHz one always, and others
  only when they clearly stand out.

Audio is read and written with soundfile.
Progress: JSON lines {"stage":"voice","done":n,"total":m} on stdout.
"""

import argparse
import time

import numpy as np
import soundfile as sf
import torch

from common import RESEMBLE_RUN_DIR, emit, load_voice_enhancer, pick_device

CHUNK_S = 30.0
OVERLAP_S = 1.0


def find_whines(wav, sr, max_tones=3):
    """Steady tones above 2 kHz: bins whose median level over time stands well
    above the surrounding spectrum (speech moves, a whine stays put)."""
    from scipy.ndimage import median_filter
    from scipy.signal import find_peaks, stft

    if len(wav) < sr:  # too short to tell a tone from speech
        return []
    f, _, z = stft(wav, sr, nperseg=8192, noverlap=6144)
    mag = 20 * np.log10(np.abs(z) + 1e-10)
    steady = np.median(mag, axis=1)  # level a tone keeps most of the time
    bin_hz = f[1] - f[0]
    baseline = median_filter(steady, size=int(400 / bin_hz) | 1)
    excess = steady - baseline
    loud_floor = steady.max() - 70
    band = (f > 2000) & (f < 16000)
    peaks, _ = find_peaks(np.where(band, excess, 0), height=10, distance=int(50 / bin_hz))
    peaks = [p for p in peaks if steady[p] > loud_floor]
    peaks.sort(key=lambda p: -excess[p])
    return [{"hz": round(float(f[p]), 1), "excess_db": round(float(excess[p]), 1)} for p in peaks[:max_tones]]


def fidelity(ref, ref_sr, y, y_sr):
    """fidelidad.py: distance between the 100 Hz-4 kHz mel spectrograms of the
    original and an enhanced version (where the original does carry
    information), and the 4 worst moments. A moment far above the rest (e.g. 20
    when the usual is 5-10) is usually an invented or distorted syllable."""
    import librosa

    a16 = librosa.resample(ref, orig_sr=ref_sr, target_sr=16000)
    b16 = librosa.resample(y, orig_sr=y_sr, target_sr=16000)
    n = min(len(a16), len(b16))
    mel = lambda z: librosa.power_to_db(
        librosa.feature.melspectrogram(y=z[:n], sr=16000, n_fft=1024, hop_length=160, n_mels=64, fmin=100, fmax=4000), ref=1.0
    )
    a, b = mel(a16), mel(b16)
    a -= a.mean()
    b -= b.mean()
    d = np.abs(a - b).mean(0)
    voice = a.max(0) > np.percentile(a.max(0), 40)
    w = np.convolve(d * voice, np.ones(20) / 20, mode="same")
    picks = []
    for i in np.argsort(w)[::-1]:
        if all(abs(i - j) > 50 for j in picks):
            picks.append(i)
        if len(picks) == 4:
            break
    distance = float(d[voice].mean()) if voice.any() else 0.0
    return round(distance, 2), [{"t": round(i / 100, 2), "score": round(float(w[i]), 1)} for i in sorted(picks)]


@torch.inference_mode()
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--passes", type=int, default=1)
    ap.add_argument("--clean")  # where to write the clean-only (denoise) version
    a = ap.parse_args()
    passes = max(1, min(5, a.passes))

    device = pick_device()
    emit(stage="voice", status="loading", device=device.type)
    model = load_voice_enhancer(device)
    model.configurate_(nfe=128, solver="midpoint", lambd=0.9, tau=0.1)

    from resemble_enhance.inference import inference_chunk, merge_chunks, remove_weight_norm_recursively
    from torchaudio.functional import resample

    remove_weight_norm_recursively(model)
    data, sr_in = sf.read(a.input, dtype="float32", always_2d=True)
    ref = data.mean(axis=1)
    dwav = torch.from_numpy(ref)
    sr = model.hp.wav_rate
    if sr_in != sr:
        # Same resampler settings as resemble_enhance.inference.inference (what enhance() uses).
        dwav = resample(dwav, orig_freq=sr_in, new_freq=sr, lowpass_filter_width=64, rolloff=0.9475937167399596,
                        resampling_method="sinc_interp_kaiser", beta=14.769656459379492)

    chunk = int(sr * CHUNK_S)
    hop = chunk - int(sr * OVERLAP_S)
    starts = list(range(0, dwav.shape[-1], hop))
    total = len(starts) * (passes + (1 if a.clean else 0))
    done = 0
    t0 = time.perf_counter()
    emit(stage="voice", done=0, total=total)

    def run(net):
        nonlocal done
        chunks = []
        for s in starts:
            chunks.append(inference_chunk(net, dwav[s : s + chunk], sr, device))
            done += 1
            emit(stage="voice", done=done, total=total, elapsed=round(time.perf_counter() - t0, 2))
        return merge_chunks(chunks, chunk, hop, sr=sr, length=dwav.shape[-1]).numpy()

    results = []
    best = None
    for p in range(passes):
        out = run(model)
        dist, worst = fidelity(ref, sr_in, out, sr)
        results.append({"distance": dist, "worst": worst})
        emit(stage="voice", pass_done=p + 1, distance=dist)
        if best is None or dist < results[best[0]]["distance"]:
            best = (p, out)
    chosen, out = best
    # 16-bit intermediates, as in the approved recipe.
    sf.write(a.output, out, sr, subtype="PCM_16")
    if a.clean:
        sf.write(a.clean, run(model.denoiser), sr, subtype="PCM_16")
    emit(stage="voice", finished=True, sr=sr, passes=results, chosen=chosen, whines=find_whines(out, sr), elapsed=round(time.perf_counter() - t0, 2))


if __name__ == "__main__":
    main()
