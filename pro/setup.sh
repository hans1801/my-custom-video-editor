#!/bin/sh
# Installs the local Mejoras Pro environment: Python 3.11 venv, packages,
# patches and models (~4 GB). Safe to run again.
set -e
cd "$(dirname "$0")"

PY=${PYTHON311:-$(command -v python3.11 || true)}
[ -n "$PY" ] || { echo "Falta Python 3.11 (brew install python@3.11)"; exit 1; }

[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
# resemble-enhance pins old torch/deepspeed: install it alone, then its real needs.
.venv/bin/pip install -q --no-deps resemble-enhance
.venv/bin/pip install -q celluloid omegaconf ptflops rich resampy tabulate torch torchaudio matplotlib pandas librosa soundfile gfpgan huggingface_hub

.venv/bin/python prepare.py
.venv/bin/python check.py
