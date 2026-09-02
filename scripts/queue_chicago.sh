#!/usr/bin/env bash
# Queue D: Chicago (Divvy) cross-city validation
#   - the flow graph uses training-period OD only
#   - delta_s=0.9809 is chosen to hit a 19.6% edge density, matching the
#     sparsity of the best Shenzhen configuration. A fixed 0.7 threshold
#     would give 98.3% density here, i.e. it does not transfer.
set -u
PY="${PYTHON:-python}"   # override with e.g. PYTHON=python3.11
export OMP_NUM_THREADS=4 MKL_NUM_THREADS=4
cd "$(dirname "$0")"

DS=0.9809
MAT=chicago.mat

echo "[$(date '+%F %T')] === Chicago: MR-STGN main model ==="
"$PY" mrstgn_paper.py --mat $MAT --delta_s $DS --epochs 100 --patience 20 \
      --out ./out_chicago --device cpu

echo "[$(date '+%F %T')] === Chicago: graph-free GRU baseline ==="
"$PY" baselines.py --mat $MAT --models GRU --seeds 42 --epochs 100 --patience 20 \
      --out ./baseline_chicago --device cpu

echo "[$(date '+%F %T')] === Chicago: HA baseline (needed by the simulation) ==="
"$PY" baselines.py --mat $MAT --models HA --out ./baseline_chicago --device cpu

echo "[$(date '+%F %T')] === Chicago: four ablation variants ==="
"$PY" run_ablation.py --mat $MAT --delta_s $DS --epochs 100 --patience 20 \
      --seeds 42 --out ./ablation_chicago --device cpu

echo "[$(date '+%F %T')] Queue D done"
