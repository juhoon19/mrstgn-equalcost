#!/usr/bin/env bash
# Two extra seeds for DCRNN, the second-strongest baseline.
#
# Why only DCRNN: its two existing runs differed by 54% (17.58 vs 11.39), so a
# single run cannot be reported responsibly. Graph WaveNet sits fourth and has
# shown no such instability, so it stays single-seed with a note in the table.
#
# Resumable: baselines.py skips any (model, seed) pair whose record already
# exists, and each finished run is written to its own run_*.json before the
# next one starts. Re-running this script after an interruption picks up where
# it left off rather than starting over.
#
# --mat must be passed explicitly; the default was changed to a neutral
# 'dataset.mat' when the code was prepared for release.
set -u
PY="${PYTHON:-/c/Users/Administrator/AppData/Local/Programs/Python/Python311/python.exe}"
export OMP_NUM_THREADS=16 MKL_NUM_THREADS=16
cd "$(dirname "$0")"
MAT=../output_v5/all_data.mat

for SEED in 7 2026; do
  echo "======================================================================"
  echo "[$(date '+%F %T')] DCRNN seed=$SEED"
  echo "======================================================================"
  "$PY" baselines.py --mat "$MAT" --models DCRNN --seeds "$SEED" \
        --epochs 100 --patience 20 --device cpu
  echo "[$(date '+%F %T')] seed $SEED finished and written to disk"
done

echo "[$(date '+%F %T')] rebuilding the summary from the per-run files"
"$PY" rebuild_results.py
echo "[$(date '+%F %T')] Queue done"
