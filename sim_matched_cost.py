#!/usr/bin/env python3
"""
Equal-cost comparison: does the advantage of the risk-aware policy
(mu + z*sigma) come from dispatching more accurately or simply from
dispatching more?

Method: sweep the multiplicative factor c for the point-forecast policy
(tau = c*mu) and the safety coefficient z for the risk-aware policy
(tau = mu + z*sigma), record the resulting (vehicles moved per hour, unmet
demand rate) pair for each, and compare the two at the SAME movement volume.
If the curves coincide, sigma carries no information beyond the mean and the
advantage was pure aggressiveness; if the risk-aware curve sits lower, the
variance does supply something the point forecast does not.
"""

import os
import json
import argparse

import numpy as np
import scipy.io as sio

from simulate_rebalancing import simulate

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mat', default='dataset.mat')
    ap.add_argument('--mrstgn', default=os.path.join(HERE, 'out_paper', 'test_outputs.npz'))
    ap.add_argument('--baseline_dir', default=os.path.join(HERE, 'baseline_out'))
    ap.add_argument('--out', default=os.path.join(HERE, 'tables'))
    ap.add_argument('--quota_hours', type=float, default=5.0)
    ap.add_argument('--budget_frac', type=float, default=0.05)
    ap.add_argument('--pileup_hours', type=float, default=6.0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    m = sio.loadmat(args.mat)
    flow = m['flow_tensor'].astype(np.float64)
    dist = m['distance_matrix'].astype(np.float64)
    T_all, N, _ = flow.shape
    train_end, val_end = int(T_all * 0.7), int(T_all * 0.85)

    d = np.load(args.mrstgn)
    P, Y, V = d['preds'], d['targets'], d['vars']
    n = len(Y)
    abs_t = np.array([val_end + 24 + k for k in range(n)])
    x_out, x_in = flow[abs_t][:, :, 0], flow[abs_t][:, :, 1]
    hist_mean = flow[:train_end][:, :, 0].mean(axis=0)

    mu = np.maximum(P[:, :, 0], 0)
    sd = np.sqrt(np.maximum(V[:, :, 0], 0))

    gp = os.path.join(args.baseline_dir, 'GRU_s42_test.npz')
    gmu = np.maximum(np.load(gp)['preds'][:, :, 0], 0) if os.path.exists(gp) else None

    Q = args.quota_hours * x_out.sum(axis=1).mean()
    b0 = hist_mean / hist_mean.sum() * Q
    cap = np.maximum(args.pileup_hours * hist_mean, 30.0)

    def run(fn):
        return simulate(x_out, x_in, fn, dist, Q, args.budget_frac, cap, b0)

    curves = {}

    print(f"quota Q = {Q:,.0f} vehicles | movement budget {args.budget_frac*Q:,.0f} per hour\n")

    print("=== A. scaled point forecast, tau = c*mu ===")
    print(f"{'c':>6}{'Moved/h':>12}{'bike-km/h':>12}{'Unmet%':>11}{'Stockout%':>11}")
    curves['point_scaled'] = []
    for c in [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]:
        r = run(lambda t, c=c: c * mu[t])
        curves['point_scaled'].append({'param': c, **r})
        print(f"{c:>6.2f}{r['bikes_moved_per_hour']:>12.0f}{r['bike_km_per_hour']:>12.0f}"
              f"{r['unmet_rate_pct']:>11.3f}{r['stockout_region_hours_pct']:>11.2f}")

    print("\n=== B. risk-aware, tau = mu + z*sigma ===")
    print(f"{'z':>6}{'Moved/h':>12}{'bike-km/h':>12}{'Unmet%':>11}{'Stockout%':>11}")
    curves['risk'] = []
    for z in [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]:
        r = run(lambda t, z=z: mu[t] + z * sd[t])
        curves['risk'].append({'param': z, **r})
        print(f"{z:>6.2f}{r['bikes_moved_per_hour']:>12.0f}{r['bike_km_per_hour']:>12.0f}"
              f"{r['unmet_rate_pct']:>11.3f}{r['stockout_region_hours_pct']:>11.2f}")

    if gmu is not None:
        print("\n=== C. scaled graph-free GRU forecast, tau = c*mu_GRU ===")
        print(f"{'c':>6}{'Moved/h':>12}{'bike-km/h':>12}{'Unmet%':>11}{'Stockout%':>11}")
        curves['gru_scaled'] = []
        for c in [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]:
            r = run(lambda t, c=c: c * gmu[t])
            curves['gru_scaled'].append({'param': c, **r})
            print(f"{c:>6.2f}{r['bikes_moved_per_hour']:>12.0f}{r['bike_km_per_hour']:>12.0f}"
                  f"{r['unmet_rate_pct']:>11.3f}{r['stockout_region_hours_pct']:>11.2f}")

    print("\n=== D. no prediction at all: tau = c * training-period mean outflow ===")
    print("     (the decisive control: if this matches the predictive policies")
    print("      at equal cost, the gain came from dispatching more, not from"
          " forecasting)")
    print(f"{'c':>6}{'Moved/h':>12}{'bike-km/h':>12}{'Unmet%':>11}{'Stockout%':>11}")
    curves['static_scaled'] = []
    for c in [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0]:
        r = run(lambda t, c=c: c * hist_mean)
        curves['static_scaled'].append({'param': c, **r})
        print(f"{c:>6.2f}{r['bikes_moved_per_hour']:>12.0f}{r['bike_km_per_hour']:>12.0f}"
              f"{r['unmet_rate_pct']:>11.3f}{r['stockout_region_hours_pct']:>11.2f}")

    # Interpolate every curve to a common movement volume
    print("\n=== equal-cost comparison (linear interpolation on vehicles/hour) ===")
    def interp(curve, xs):
        mv = np.array([r['bikes_moved_per_hour'] for r in curve])
        um = np.array([r['unmet_rate_pct'] for r in curve])
        o = np.argsort(mv)
        return np.interp(xs, mv[o], um[o], left=np.nan, right=np.nan)

    names = [('static_scaled', 'No prediction'), ('point_scaled', 'MR-STGN μ'),
             ('risk', 'MR-STGN μ+zσ'), ('gru_scaled', 'Graph-free GRU')]
    names = [(k, n) for k, n in names if k in curves]
    lo = max(min(r['bikes_moved_per_hour'] for r in curves[k]) for k, _ in names)
    hi = min(max(r['bikes_moved_per_hour'] for r in curves[k]) for k, _ in names)
    grid = np.linspace(lo, hi, 6)
    cols = {k: interp(curves[k], grid) for k, _ in names}

    hdr = f"{'Moved/h':>12}" + ''.join(f"{n:>16}" for _, n in names)
    print(hdr)
    for i, g in enumerate(grid):
        line = f"{g:>12.0f}" + ''.join(f"{cols[k][i]:>16.3f}" for k, _ in names)
        print(line)

    json.dump(curves, open(os.path.join(args.out, 'matched_cost.json'), 'w', encoding='utf-8'),
              indent=2, ensure_ascii=False)
    print(f"\nresults: {args.out}/matched_cost.json")


if __name__ == '__main__':
    main()
