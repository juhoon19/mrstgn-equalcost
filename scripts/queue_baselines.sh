#!/usr/bin/env bash
# Queue B: deep-learning baselines
# One invocation per model; results are appended to baseline_out/results.json,
# and a re-run skips any (model, seed) pair already completed.
set -u
PY="${PYTHON:-python}"   # override with e.g. PYTHON=python3.11
export OMP_NUM_THREADS=7 MKL_NUM_THREADS=7
cd "$(dirname "$0")"

# seed 42 first for the headline numbers, then extra seeds for significance
# The three classical baselines are deterministic, so they run once and
# outside the seed loop.
"$PY" baselines.py --models HA ARIMA SVR --device cpu

for SEED in 42 7 2026; do
  for M in GRU LSTM GCN STGCN ASTGCN DCRNN GraphWaveNet GMAN; do
    echo "======================================================================"
    echo "[$(date '+%F %T')] baseline: $M  seed=$SEED"
    echo "======================================================================"
    "$PY" baselines.py --models "$M" --seeds "$SEED" --epochs 100 --patience 20 --device cpu
  done
done

echo "[$(date '+%F %T')] Queue B done"
