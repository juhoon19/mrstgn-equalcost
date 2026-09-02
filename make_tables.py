#!/usr/bin/env python3
"""
Collect all experimental results into the manuscript tables and run the
paired significance tests.

Outputs (written to tables/):
    table1_overall.md      overall prediction performance
    table2_ablation.md     ablation over the relational graphs
    table3_sensitivity.md  graph-construction parameter sensitivity
    table4_calibration.md  probabilistic calibration
    significance.md        MR-STGN against each baseline, paired

Significance testing:
    For each baseline, the per-sample absolute errors on the SAME test samples
    are compared against MR-STGN with a paired Wilcoxon signed-rank test (no
    normality assumption) and a paired t-test, reported alongside Cliff's
    delta as the effect size. Multiple comparisons use Holm-Bonferroni.
"""

import os
import json
import glob
import argparse

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'tables')

# Printed values from the earlier version of the tables, shown side by side
PAPER_T1 = {
    'HA':     (35.20, 58.50, 85.2, 0.520),
    'ARIMA':  (28.50, 48.20, 72.4, 0.610),
    'SVR':    (25.80, 43.50, 65.3, 0.680),
    'LSTM':   (22.10, 38.20, 58.6, 0.780),
    'GRU':    (21.50, 36.80, 55.2, 0.800),
    'GCN':    (19.80, 34.50, 52.3, 0.840),
    'STGCN':  (17.20, 30.20, 45.8, 0.890),
    'ASTGCN': (15.80, 28.50, 42.1, 0.910),
    'DCRNN':  (14.20, 25.80, 40.2, 0.930),
    'MR-STGN': (11.54, 21.01, 36.15, 0.962),
}
PAPER_T2 = {
    'No Graph (GRU only)': (16.73, 30.46, '+45.0%'),
    'Geo Only':            (14.43, 26.28, '+25.0%'),
    'Flow Only':           (13.85, 25.23, '+20.0%'),
    'Sim Only':            (15.00, 27.32, '+30.0%'),
    'Geo + Flow':          (12.69, 23.12, '+10.0%'),
    'Geo + Sim':           (13.27, 24.17, '+15.0%'),
    'Flow + Sim':          (12.92, 23.53, '+12.0%'),
    'MR-STGN (Full)':      (11.54, 21.01, '—'),
}
ORDER = ['HA', 'ARIMA', 'SVR', 'LSTM', 'GRU', 'GCN', 'STGCN', 'ASTGCN',
         'DCRNN', 'GraphWaveNet', 'GMAN']


def load(path):
    return json.load(open(path, encoding='utf-8')) if os.path.exists(path) else []


def agg(rows, key):
    vals = [r[key] for r in rows if key in r]
    return (float(np.mean(vals)), float(np.std(vals)), len(vals)) if vals else (None, None, 0)


def cliffs_delta(a, b):
    """Effect size P(a>b) - P(a<b), subsampled to avoid an O(n^2) comparison."""
    rng = np.random.default_rng(0)
    n = min(len(a), 20000)
    ia = rng.choice(len(a), n, replace=False)
    ib = rng.choice(len(b), n, replace=False)
    x, y = a[ia], b[ib]
    return float((x > y).mean() - (x < y).mean())


def significance(mrstgn_npz, baseline_dir, out_path):
    from scipy import stats
    if not os.path.exists(mrstgn_npz):
        return None
    d = np.load(mrstgn_npz)
    err_ours = np.abs(d['preds'] - d['targets']).reshape(len(d['preds']), -1).mean(axis=1)

    rows = []
    for f in sorted(glob.glob(os.path.join(baseline_dir, '*_test.npz'))):
        name = os.path.basename(f).replace('_test.npz', '')
        b = np.load(f)
        if b['targets'].shape != d['targets'].shape:
            continue
        err_b = np.abs(b['preds'] - b['targets']).reshape(len(b['preds']), -1).mean(axis=1)
        try:
            w_stat, w_p = stats.wilcoxon(err_ours, err_b)
        except Exception:
            w_stat, w_p = float('nan'), float('nan')
        t_stat, t_p = stats.ttest_rel(err_ours, err_b)
        rows.append({'baseline': name,
                     'mean_err_ours': float(err_ours.mean()),
                     'mean_err_base': float(err_b.mean()),
                     'wilcoxon_p': float(w_p), 't_p': float(t_p),
                     'cliffs_delta': cliffs_delta(err_b, err_ours)})

    # Holm-Bonferroni correction
    rows.sort(key=lambda r: r['wilcoxon_p'])
    m = len(rows)
    for i, r in enumerate(rows):
        r['holm_p'] = min(1.0, r['wilcoxon_p'] * (m - i))

    lines = ['# Paired significance tests: MR-STGN against each baseline', '',
             'Each test sample (526 time steps) contributes its network-mean absolute',
             'error, paired with MR-STGN. Cliff\'s delta > 0 favours MR-STGN.',
             'Multiple comparisons are corrected with Holm-Bonferroni.', '',
             '| Baseline | Baseline mean error | MR-STGN mean error | Wilcoxon p | Holm p | Paired t p | Cliff\'s delta |',
             '|---|---|---|---|---|---|---|']
    for r in rows:
        lines.append(f"| {r['baseline']} | {r['mean_err_base']:.3f} | {r['mean_err_ours']:.3f} | "
                     f"{r['wilcoxon_p']:.3e} | {r['holm_p']:.3e} | {r['t_p']:.3e} | "
                     f"{r['cliffs_delta']:+.3f} |")
    open(out_path, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paper_run', default=os.path.join(HERE, 'out_paper'))
    ap.add_argument('--baseline_dir', default=os.path.join(HERE, 'baseline_out'))
    ap.add_argument('--ablation_dir', default=os.path.join(HERE, 'ablation_out'))
    ap.add_argument('--sweep_dir', default=os.path.join(HERE, 'sweep_out'))
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    base = load(os.path.join(args.baseline_dir, 'results.json'))
    abl = load(os.path.join(args.ablation_dir, 'results.json'))
    swp = load(os.path.join(args.sweep_dir, 'results.json'))
    paper_metrics = (json.load(open(os.path.join(args.paper_run, 'metrics.json'), encoding='utf-8'))
                     if os.path.exists(os.path.join(args.paper_run, 'metrics.json')) else None)

    # ---------------- Table 1 ----------------
    L = ['# Table 1: overall prediction performance', '',
         'The Measured column reports the result of re-implementing and retraining',
         'each model on the same data, the same chronological split and the same',
         'training-set standardization. Graph WaveNet and GMAN run on exactly the',
         'same gridded input as MR-STGN, with no special adaptation.', '',
         '| Method | Prev. MAE | Measured MAE | Prev. RMSE | Measured RMSE | WMAPE% | Prev. Corr | Measured Corr | Seeds |',
         '|---|---|---|---|---|---|---|---|---|']
    for nm in ORDER:
        rs = [r for r in base if r['model'] == nm]
        p = PAPER_T1.get(nm)
        # Models excluded from the earlier table have no printed counterpart
        pm = f"{p[0]:.2f}" if p else "not reported"
        pr = f"{p[1]:.2f}" if p else "—"
        pc = f"{p[3]:.3f}" if p else "—"
        if not rs:
            L.append(f"| {nm} | {pm} | — | {pr} | — | — | {pc} | — | 0 |")
            continue
        mae, mae_sd, n = agg(rs, 'MAE')
        rmse, _, _ = agg(rs, 'RMSE')
        wm, _, _ = agg(rs, 'WMAPE')
        cr, _, _ = agg(rs, 'Corr')
        sd = f" ±{mae_sd:.2f}" if n > 1 else ""
        L.append(f"| {nm} | {pm} | **{mae:.2f}**{sd} | {pr} | {rmse:.2f} | "
                 f"{wm:.2f} | {pc} | {cr:.3f} | {n} |")
    if paper_metrics:
        t = paper_metrics['test']
        L.append(f"| **MR-STGN** | 11.54 | **{t['MAE']:.2f}** | 21.01 | "
                 f"{t['RMSE']:.2f} | {t['WMAPE']:.2f} | 0.962 | {t['Corr']:.3f} | 1 |")
    open(os.path.join(OUT, 'table1_overall.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')

    # ---------------- Table 2 ----------------
    L = ['# Table 2: ablation over the relational graphs', '',
         'Every variant below was implemented and trained for this study.', '',
         '| Variant | Prev. MAE | Measured MAE | Prev. RMSE | Measured RMSE | Prev. Rel.dMAE | Measured Rel.dMAE | NLL | PICP95% | Seeds |',
         '|---|---|---|---|---|---|---|---|---|---|']
    full = [r for r in abl if r['variant'] == 'MR-STGN (Full)']
    fbase = np.mean([r['MAE'] for r in full]) if full else None
    for nm, p in PAPER_T2.items():
        rs = [r for r in abl if r['variant'] == nm]
        if not rs:
            L.append(f"| {nm} | {p[0]:.2f} | — | {p[1]:.2f} | — | {p[2]} | — | — | — | 0 |")
            continue
        mae, sd, n = agg(rs, 'MAE')
        rmse, _, _ = agg(rs, 'RMSE')
        nll, _, _ = agg(rs, 'NLL')
        pic, _, _ = agg(rs, 'PICP95')
        rel = f"{(mae/fbase-1)*100:+.1f}%" if fbase else '—'
        s = f" ±{sd:.2f}" if n > 1 else ""
        L.append(f"| {nm} | {p[0]:.2f} | **{mae:.2f}**{s} | {p[1]:.2f} | {rmse:.2f} | "
                 f"{p[2]} | {rel} | {nll:.3f} | {pic:.1f} | {n} |")
    open(os.path.join(OUT, 'table2_ablation.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')

    # ---------------- Table 3: sensitivity ----------------
    L = ['# Table 3: graph-construction parameter sensitivity', '',
         'One parameter is varied at a time, the others held at their defaults',
         '(kappa=8, K_f=15, delta_s=0.7). Note that delta_s=0.7 leaves the',
         'similarity graph at about 94% density, i.e. near-complete.', '',
         '| Setting | MAE | RMSE | WMAPE% | Corr | NLL | PICP95% | Geo density% | Flow density% | Sim density% |',
         '|---|---|---|---|---|---|---|---|---|---|']
    for r in swp:
        d = r['density_pct']
        L.append(f"| {r['tag']} | {r['MAE']:.3f} | {r['RMSE']:.3f} | {r['WMAPE']:.2f} | "
                 f"{r['Corr']:.4f} | {r['NLL']:.3f} | {r['PICP95']:.1f} | "
                 f"{d['geo']:.2f} | {d['flow']:.2f} | {d['sim']:.2f} |")
    open(os.path.join(OUT, 'table3_sensitivity.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')

    # ---------------- Table 4: calibration ----------------
    L = ['# Table 4: uncertainty calibration', '',
         'Probabilistic metrics over the full test set and all regions.',
         'PICP is empirical coverage (ideally equal to the nominal level); MPIW is',
         'mean prediction interval width; NLL and CRPS are lower-is-better.', '',
         '| Model | NLL | CRPS | PICP50% | PICP90% | PICP95% | MPIW50 | MPIW90 | MPIW95 |',
         '|---|---|---|---|---|---|---|---|---|']
    src = []
    if paper_metrics and 'prob' in paper_metrics:
        src.append(('MR-STGN', paper_metrics['prob']))
    for r in abl:
        if r['variant'] == 'MR-STGN (Full)':
            src.append((f"MR-STGN (Full, seed {r['seed']})", r))
    for nm, p in src:
        L.append(f"| {nm} | {p['NLL']:.3f} | {p['CRPS']:.3f} | {p['PICP50']:.1f} | "
                 f"{p['PICP90']:.1f} | {p['PICP95']:.1f} | {p['MPIW50']:.2f} | "
                 f"{p['MPIW90']:.2f} | {p['MPIW95']:.2f} |")
    L += ['', 'Ideal coverage is PICP50 = 50, PICP90 = 90, PICP95 = 95.',
          'The further from those values, the worse the variance is calibrated.']
    open(os.path.join(OUT, 'table4_calibration.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')

    # ---------------- significance ----------------
    ours = os.path.join(args.paper_run, 'test_outputs.npz')
    significance(ours, args.baseline_dir, os.path.join(OUT, 'significance.md'))

    print(f"tables written to: {OUT}")
    for f in sorted(os.listdir(OUT)):
        print('  ', f)


if __name__ == '__main__':
    main()
