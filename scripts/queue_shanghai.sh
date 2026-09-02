#!/usr/bin/env bash
# Queue S: Shanghai (2018-08-26 to 2018-09-08) restricted validation.
#   Only predictive accuracy, the ablation ordering and the attention pattern.
#   The 14-day window is too short for the rebalancing simulation.
#   delta_s = 0.9671 targets the same 19.6% similarity-graph density as the
#   other two cities; a fixed threshold does not transfer across cities.
set -u
PY="${PYTHON:-/c/Users/Administrator/AppData/Local/Programs/Python/Python311/python.exe}"
export OMP_NUM_THREADS=8 MKL_NUM_THREADS=8
cd "$(dirname "$0")"
DS=0.9671
echo "[$(date '+%F %T')] === Shanghai: MR-STGN main model ==="
"$PY" mrstgn_paper.py --mat shanghai.mat --delta_s $DS --epochs 100 --patience 20 \
      --out ./out_shanghai --device cpu
echo "[$(date '+%F %T')] === Shanghai: ablation, key subset ==="
"$PY" run_ablation.py --mat shanghai.mat --delta_s $DS --epochs 100 --patience 20 \
      --seeds 42 --variants key --out ./ablation_shanghai --device cpu
echo "[$(date '+%F %T')] === Shanghai: graph-free GRU baseline ==="
"$PY" baselines.py --mat shanghai.mat --models GRU --seeds 42 --epochs 100 \
      --patience 20 --out ./baseline_shanghai --device cpu
echo "[$(date '+%F %T')] Queue S done"
