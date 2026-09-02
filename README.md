# Equal-Cost Evaluation of Shared-Bicycle Demand Prediction

Code and results for *"Does Multi-Relational Graph Structure Improve Shared-Bicycle
Dispatching? An Equal-Cost Evaluation Protocol and Cross-City Evidence."*

The repository contains everything needed to reproduce the paper: the predictive
model, all eleven baselines, the ablation and sensitivity studies, the
quota-constrained rebalancing simulation, the equal-cost protocol, and the
scripts that generate every table and figure in the manuscript.

The Chicago results reproduce end to end from public data. The Shenzhen and
Shanghai results require datasets that are not redistributable here (see
[Data](#data)).

---

## What the paper finds

Under a protocol that holds dispatching cost constant:

| Question | Answer |
|---|---|
| Does prediction improve fleet rebalancing? | **Yes** — unmet demand falls 32% (Shenzhen) and 35% (Chicago) at equal vehicle-movement effort |
| Does multi-relational graph structure improve it further? | **No consistent gain** — 8.9% (Shenzhen) / 7.7% (Shanghai) / 2.1% (Chicago) MAE improvement over a graph-free variant does not translate into operational benefit |
| Does heteroscedastic variance help risk-aware buffering? | **Only in sparse demand** — clear benefit in Chicago, none in Shenzhen |

Without cost matching, the variance-aware policy *appears* to cut stockout
region-hours by 44% in Shenzhen. That advantage disappears entirely once
dispatching effort is equalized. This is the reason the protocol exists.

---

## Installation

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Tested with Python 3.11 on CPU. A GPU is optional; set `--device cuda` if
available. Every experiment in the paper was run on CPU (20 cores); a full
sweep takes roughly a day.

---

## Data

### Chicago (public — fully reproducible)

Download five months of Divvy trip data and build the tensors:

```bash
mkdir -p data_chicago && cd data_chicago
for m in 202104 202105 202106 202107 202108; do
  curl -O "https://divvy-tripdata.s3.amazonaws.com/${m}-divvy-tripdata.zip"
  unzip -o "${m}-divvy-tripdata.zip" -x "__MACOSX/*" && rm "${m}-divvy-tripdata.zip"
done
cd ..
python preprocess_chicago.py --data_dir data_chicago --out chicago_data.npz
```

This produces `chicago_data.npz` containing the hourly flow tensor
`(3672, 200, 2)`, the great-circle distance matrix, grid centroids, and — the
point of using this dataset — **origin–destination counts restricted to the
training period**, which is what makes the flow graph leakage-free.

Convert to the `.mat` layout the experiment scripts expect:

```python
import numpy as np, scipy.io as sio
d = np.load('chicago_data.npz')
sio.savemat('chicago.mat', {
    'flow_tensor': d['flow_tensor'], 'distance_matrix': d['distance_matrix'],
    'grid_centers': d['grid_centers'], 'od_train': d['od_train'],
    'adj_flow': d['od_train'], 'od_full': d['od_full']}, do_compression=True)
```

### Shanghai (restricted — predictive comparison only)

A second dockless Chinese system, used to check that the ablation result is not
tied to one system form or national context. The raw records are lock/unlock
events rather than trips, so `preprocess_shanghai.py` reconstructs each trip by
pairing an unlock with the next lock of the same bicycle:

```bash
python preprocess_shanghai.py --zip /path/to/shanghai_trajectories.zip \
       --out shanghai_data.npz
```

The window is 14 days (336 hourly steps), which supports the predictive
comparison and the ablation but **not** the operational simulation; the paper
reports Shanghai for the former only. Convert to `.mat` exactly as for Chicago,
substituting `shanghai_data.npz`.

### Shenzhen (proprietary)

The raw order records are held under a research-use agreement and cannot be
redistributed. The processed tensors are available from the corresponding author
on reasonable request. The scripts read a `.mat` file
with keys `flow_tensor (T,N,2)`, `distance_matrix (N,N)`, `grid_centers (N,2)`
and either `od_train (N,N)` (preferred, leakage-free) or `adj_flow (N,N)`.
Any dataset in that layout will run.

Trip-level Shenzhen records are not redistributable, which is why the flow graph
for Shenzhen cannot be restricted to the training period and why grid resolution
cannot be varied there. Both limitations are stated in the paper.

---

## Reproducing the paper

Order matters only in that tables and figures need the runs to exist first.

```bash
# 1. Main model (Table 1 row, Table 4 calibration, Figures 4-6, 9-10)
python mrstgn_paper.py --delta_s 0.95 --epochs 100 --out ./out_paper

# 2. Baselines (Table 1). One model at a time; results accumulate.
python baselines.py --models HA ARIMA SVR --out ./baseline_out
for M in LSTM GRU GCN STGCN ASTGCN DCRNN GraphWaveNet GMAN; do
  python baselines.py --models $M --seeds 42 --epochs 100 --out ./baseline_out
done

# 3. Ablation (Table 2)
python run_ablation.py --delta_s 0.95 --variants all --seeds 42 --out ./ablation_out

# 4. Graph-construction sensitivity (Table 3)
python sweep_graph_params.py --epochs 40 --patience 10 --out ./sweep_out

# 5. Cross-city (Table 2 right half)
python mrstgn_paper.py --mat chicago.mat --delta_s 0.9809 --out ./out_chicago
python run_ablation.py --mat chicago.mat --delta_s 0.9809 --variants key \
       --out ./ablation_chicago
python baselines.py --mat chicago.mat --models GRU HA --out ./baseline_chicago

# Shanghai: predictive comparison and ablation only (14-day window)
bash queue_shanghai.sh

# 6. Operational evaluation (Tables 6-7, Figure 11)
python simulate_rebalancing.py --out ./tables
python sim_matched_cost.py --out ./tables

# 7. Assemble tables and figures
python make_tables.py
python make_figures.py
```

`scripts/` holds the shell queues used to run these sequentially on one machine.

### Multi-seed runs

Significance testing in the paper uses three seeds for the headline
comparisons:

```bash
python run_ablation.py --delta_s 0.95 --variants headline --seeds 7 2026 \
       --out ./ablation_out
for M in GRU LSTM; do
  python baselines.py --models $M --seeds 7   --out ./baseline_out
  python baselines.py --models $M --seeds 2026 --out ./baseline_out
done
```

---

## Code map

| File | Purpose |
|---|---|
| `mrstgn_paper.py` | The predictive model, exactly as specified in Section 3.2 of the paper. Graph construction (Eqs. 4–6), summed input encoding (Eq. 8), single-layer GRU, relational attention, log-variance head, Gaussian NLL + MAE loss (Eq. 16). Supports arbitrary subsets of the three relations via `relations=`, which is what the ablation uses. |
| `baselines.py` | All eleven baselines: HA, ARIMA, SVR, LSTM, GRU, GCN, STGCN, ASTGCN, DCRNN, Graph WaveNet, GMAN. Every deep baseline shares one training loop, optimizer, scheduler and early-stopping rule with the main model. |
| `run_ablation.py` | The eight relational variants. `--variants all\|key\|headline` selects a subset. |
| `sweep_graph_params.py` | Sensitivity to κ, K_f and δ_s, one parameter at a time. |
| `simulate_rebalancing.py` | Quota-constrained hourly rebalancing simulation. Targets are *minimum holding levels*, not allocation shares — see the note in the source, since the distinction determines whether the simulation behaves sensibly. |
| `sim_matched_cost.py` | The equal-cost protocol: sweeps each policy's aggressiveness and compares at equal vehicles moved per hour. |
| `preprocess_chicago.py` | Divvy → gridded tensors, with training-period-only OD. |
| `make_tables.py` | Builds Tables 1–5 and runs the paired significance tests (Wilcoxon + Holm–Bonferroni + Cliff's δ). |
| `make_figures.py` | Regenerates every figure from saved predictions. |

### A note on baseline fairness

Our first implementations of STGCN, ASTGCN and GCN omitted residual
connections and produced implausibly weak results — STGCN at MAE 27.17, worse
than a per-region LSTM by more than a factor of two. Row-normalized
propagation over κ+1 neighbours dilutes a node's own signal to roughly
1/(κ+1), which is destructive when regional flow levels span two orders of
magnitude, and the original STGCN formulation includes a residual in its
ST-Conv block for exactly this reason. After adding residual connections
STGCN improves to 13.12. The corrected implementations are what this
repository ships; the comments in `baselines.py` mark the relevant lines.

An omitted residual is an easy way to produce a favourable-looking comparison.
We mention it because the paper's argument depends on the baselines being
strong.

---

## Results

`results/` contains the JSON and Markdown summaries behind every number in the
paper — per-run metrics, the sensitivity sweep, the simulation curves, and the
generated tables. Raw prediction tensors (`*_test.npz`, ~60 MB) are not
included; rerunning the scripts regenerates them.

If you rerun and want to rebuild the summary files from prediction tensors
alone, `make_tables.py` reads whatever is present.

---

## Citation

```bibtex
@article{TODO,
  title  = {Does Multi-Relational Graph Structure Improve Shared-Bicycle
            Dispatching? An Equal-Cost Evaluation Protocol and Cross-City Evidence},
  author = {TODO},
  year   = {2026}
}
```

## License

Released under the MIT License; see [LICENSE](LICENSE).
