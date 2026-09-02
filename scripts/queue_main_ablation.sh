#!/usr/bin/env bash
# Queue C: main model plus the eight ablation variants
# delta_s = 0.95 comes from the sensitivity sweep; 0.7 would leave the
# similarity graph at 94% density, i.e. near-complete.
set -u
PY="${PYTHON:-python}"   # override with e.g. PYTHON=python3.11
export OMP_NUM_THREADS=6 MKL_NUM_THREADS=6
cd "$(dirname "$0")"

echo "======================================================================"
echo "[$(date '+%F %T')] main model (delta_s=0.95, 100 epochs)"
echo "======================================================================"
"$PY" mrstgn_paper.py --delta_s 0.95 --epochs 100 --patience 20 --device cpu

echo "======================================================================"
echo "[$(date '+%F %T')] eight ablation variants (delta_s=0.95, 100 epochs, seed 42)"
echo "======================================================================"
"$PY" run_ablation.py --delta_s 0.95 --epochs 100 --patience 20 --seeds 42 --device cpu

echo "======================================================================"
echo "[$(date '+%F %T')] extra ablation seeds (7, 2026) for significance testing"
echo "======================================================================"
"$PY" run_ablation.py --delta_s 0.95 --epochs 100 --patience 20 --seeds 7 2026 --device cpu

echo "[$(date '+%F %T')] Queue C done"
