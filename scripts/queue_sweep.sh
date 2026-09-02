#!/usr/bin/env bash
# Queue A: graph-construction parameter sensitivity sweep
# Results are appended to sweep_out/results.json; a re-run skips configurations
# that already completed.
set -u
PY="${PYTHON:-python}"   # override with e.g. PYTHON=python3.11
export OMP_NUM_THREADS=7 MKL_NUM_THREADS=7
cd "$(dirname "$0")"

for P in delta_s k_geo K_f; do
  echo "======================================================================"
  echo "[$(date '+%F %T')] sweeping parameter: $P"
  echo "======================================================================"
  "$PY" sweep_graph_params.py --only "$P" --epochs 40 --patience 10 --device cpu
done

echo "[$(date '+%F %T')] Queue A done"
