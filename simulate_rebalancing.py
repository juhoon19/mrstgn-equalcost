#!/usr/bin/env python3
"""
Rebalancing simulation under a fixed fleet quota.

This connects the forecast to an actual dispatching decision and reports four
families of quantitative indicators:
    shortage  unmet demand rate, stockout region-hours
    pile-up   region-hours where inventory exceeds the public-space capacity
    cost      vehicles moved (bike-moves) and distance travelled (bike-km)
    service   demand satisfaction rate

──────────────────────────────────────────────────────────────────────
Simulation
──────────────────────────────────────────────────────────────────────
State: b_i(t) is the number of vehicles available in region i at the start of
hour t, with sum_i b_i = Q held constant at the quota.

Each hour proceeds in three stages:
    1. dispatch  a target holding level tau_i is set from the forecast for
                 hour t, and vehicles move from surplus to deficit regions
                 within a movement budget M (greedy nearest-first matching,
                 total vehicle count conserved)
    2. realize   served_i(t) = min(x_out_i(t), b_i(t)),
                 unmet_i(t)  = x_out_i(t) - served_i(t)
    3. return    b_i(t+1) = b_i(t) - served_i(t) + x_in_i(t) + r_i(t)

Policies compared:
    static   no forecast; targets proportional to the training-period mean
             outflow, i.e. current practice
    ha       driven by the HA forecast
    gru      driven by the graph-free GRU baseline
    point    driven by the MR-STGN predictive mean mu
    risk     driven by mu + z*sigma, a variance-scaled safety buffer
    oracle   perfect foresight, an upper bound on attainable performance

──────────────────────────────────────────────────────────────────────
Simplifications, all stated in the paper
──────────────────────────────────────────────────────────────────────
1. Arrivals x_in are exogenous: constraining departures by inventory does not
   feed back into downstream arrivals, which would require time-resolved OD
   flows. Since the observed data come from systems in which demand was
   largely met, the approximation is conservative.
2. Rebalancing is instantaneous, with no vehicle travel time and no capacity
   constraint on the rebalancing vehicle.
3. Greedy nearest-first matching approximates the underlying transportation
   problem rather than solving it, but it is applied identically to every
   policy, so comparisons between policies are unaffected.
"""

import os
import json
import argparse

import numpy as np
import scipy.io as sio

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)


def greedy_rebalance(b, tau, dist, budget):
    """Move vehicles from surplus to deficit regions, nearest first, within
    the movement budget.

    Returns (net change vector r, vehicles moved, bike-km travelled).
    """
    N = len(b)
    deficit = np.maximum(tau - b, 0.0)
    surplus = np.maximum(b - tau, 0.0)
    r = np.zeros(N)
    moved = 0.0
    km = 0.0
    if deficit.sum() <= 0 or surplus.sum() <= 0 or budget <= 0:
        return r, moved, km

    # Largest deficits are served first
    order = np.argsort(-deficit)
    surp = surplus.copy()
    for i in order:
        need = deficit[i]
        if need <= 1e-9 or moved >= budget:
            break
        # Draw from the nearest surplus region
        cand = np.argsort(dist[i])
        for j in cand:
            if j == i or surp[j] <= 1e-9:
                continue
            take = min(need, surp[j], budget - moved)
            if take <= 1e-9:
                break
            surp[j] -= take
            r[i] += take
            r[j] -= take
            moved += take
            km += take * dist[i, j]
            need -= take
            if need <= 1e-9 or moved >= budget:
                break
    return r, moved, km


def simulate(x_out, x_in, targets_fn, dist, Q, budget_frac, cap, b0):
    """Run one simulation and return the operational indicators."""
    T, N = x_out.shape
    b = b0.copy()
    budget = budget_frac * Q

    tot_demand = 0.0
    tot_unmet = 0.0
    stockout_rh = 0
    pileup_rh = 0
    moved_all = 0.0
    km_all = 0.0

    for t in range(T):
        # tau is a MINIMUM HOLDING LEVEL, not an allocation share. Regions
        # below tau are deficit regions; only the amount above tau counts as
        # drawable surplus. There is deliberately no forced redistribution of
        # the whole fleet: a policy that reallocates everything in proportion
        # to instantaneous predicted demand thrashes, and ends up worse than a
        # static allocation even under perfect foresight.
        tau = targets_fn(t)

        r, moved, km = greedy_rebalance(b, tau, dist, budget)
        b = b + r
        moved_all += moved
        km_all += km

        served = np.minimum(x_out[t], b)
        unmet = x_out[t] - served
        tot_demand += x_out[t].sum()
        tot_unmet += unmet.sum()
        stockout_rh += int((unmet > 0.5).sum())
        pileup_rh += int((b > cap).sum())

        b = b - served + x_in[t]
        b = np.maximum(b, 0.0)

    RH = T * N
    return {
        'unmet_rate_pct': float(tot_unmet / tot_demand * 100),
        'service_level_pct': float((1 - tot_unmet / tot_demand) * 100),
        'stockout_region_hours_pct': float(stockout_rh / RH * 100),
        'pileup_region_hours_pct': float(pileup_rh / RH * 100),
        'bikes_moved_per_hour': float(moved_all / T),
        'bike_km_per_hour': float(km_all / T),
        'bike_km_total': float(km_all),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mat', default='dataset.mat')
    ap.add_argument('--mrstgn', default=os.path.join(HERE, 'out_paper', 'test_outputs.npz'))
    ap.add_argument('--baseline_dir', default=os.path.join(HERE, 'baseline_out'))
    ap.add_argument('--out', default=os.path.join(HERE, 'tables'))
    ap.add_argument('--quota_hours', type=float, nargs='+', default=[2.0, 3.0, 5.0],
                    help='quota Q = this value x mean hourly system-wide outflow')
    ap.add_argument('--budget_frac', type=float, default=0.05,
                    help='movement budget per hour, as a fraction of the quota')
    ap.add_argument('--z', type=float, default=1.0, help='safety coefficient z for the risk-aware policy')
    ap.add_argument('--pileup_hours', type=float, default=6.0,
                    help='inventory above this many hours of the region own demand counts as pile-up')
    ap.add_argument('--static_hours', type=float, default=1.0,
                    help='static policy holding level = this many hours x historical mean outflow')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    m = sio.loadmat(args.mat)
    flow = m['flow_tensor'].astype(np.float64)
    dist = m['distance_matrix'].astype(np.float64)
    T_all, N, _ = flow.shape
    train_end, val_end = int(T_all * 0.7), int(T_all * 0.85)

    d = np.load(args.mrstgn)
    P_mr, Y, V_mr = d['preds'], d['targets'], d['vars']
    n_steps = len(Y)
    seq_len = 24
    abs_t = np.array([val_end + seq_len + k for k in range(n_steps)])

    x_out = flow[abs_t][:, :, 0]
    x_in = flow[abs_t][:, :, 1]
    assert np.allclose(x_out, Y[:, :, 0], atol=1e-3), 'test-period alignment check failed'

    # Training-period mean outflow, used by the static policy and for the
    # initial inventory
    hist_mean = flow[:train_end][:, :, 0].mean(axis=0)

    def load_pred(fname):
        p = os.path.join(args.baseline_dir, fname)
        return np.load(p)['preds'][:, :, 0] if os.path.exists(p) else None

    P_ha = load_pred('HA_test.npz')
    P_gru = load_pred('GRU_s42_test.npz')

    mu = P_mr[:, :, 0]
    sd = np.sqrt(np.maximum(V_mr[:, :, 0], 0))

    policies = {
        'static (no prediction)':    lambda t: args.static_hours * hist_mean,
        'HA forecast':               (lambda t: np.maximum(P_ha[t], 0)) if P_ha is not None else None,
        'GRU forecast (graph-free)': (lambda t: np.maximum(P_gru[t], 0)) if P_gru is not None else None,
        'MR-STGN mu (point)':        lambda t: np.maximum(mu[t], 0),
        f'MR-STGN mu+{args.z}sigma (risk-aware)': lambda t: np.maximum(mu[t] + args.z * sd[t], 0),
        'oracle (perfect foresight)': lambda t: x_out[t],
    }
    policies = {k: v for k, v in policies.items() if v is not None}

    mean_hourly_total = x_out.sum(axis=1).mean()
    results = {}

    for qh in args.quota_hours:
        Q = qh * mean_hourly_total
        b0 = hist_mean / hist_mean.sum() * Q
        # Pile-up threshold: inventory above six hours of the region own
        # demand. Deliberately decoupled from the quota, otherwise a larger
        # quota would mechanically raise the pile-up rate and the figures
        # could not be compared across quotas.
        cap = np.maximum(args.pileup_hours * hist_mean, 30.0)
        print(f"\n{'='*100}")
        print(f"quota Q = {qh}x mean hourly demand = {Q:,.0f} vehicles | "
              f"movement budget {args.budget_frac*100:.0f}% = {args.budget_frac*Q:,.0f}")
        print(f"{'='*100}")
        print(f"{'Policy':<34}{'Unmet%':>11}{'Stockout%':>11}{'Pileup%':>11}"
              f"{'Moved/h':>11}{'bike-km/h':>13}")
        row = {}
        for name, fn in policies.items():
            r = simulate(x_out, x_in, fn, dist, Q, args.budget_frac, cap, b0)
            row[name] = r
            print(f"{name:<34}{r['unmet_rate_pct']:>11.3f}{r['stockout_region_hours_pct']:>11.2f}"
                  f"{r['pileup_region_hours_pct']:>11.2f}{r['bikes_moved_per_hour']:>11.0f}"
                  f"{r['bike_km_per_hour']:>13.0f}")
        results[f'Q={qh}h'] = row

    with open(os.path.join(args.out, 'simulation_results.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    # Emit the markdown table
    L = ['# Table 6: rebalancing simulation under a fleet quota', '',
         'Forecast output is connected to an actual dispatching decision; the four',
         'families of operational indicators are reported below.', '',
         f'Horizon: {n_steps} test hours x {N} regions; movement budget '
         f'{args.budget_frac*100:.0f}% of the fleet per hour.', '']
    for qk, row in results.items():
        L += [f'## Quota {qk}', '',
              '| Policy | Unmet demand % | Stockout region-hours % | Pile-up region-hours % '
              '| Vehicles moved/h | bike-km/h |',
              '|---|---|---|---|---|---|']
        for name, r in row.items():
            L.append(f"| {name} | {r['unmet_rate_pct']:.3f} | {r['stockout_region_hours_pct']:.2f} | "
                     f"{r['pileup_region_hours_pct']:.2f} | {r['bikes_moved_per_hour']:.0f} | "
                     f"{r['bike_km_per_hour']:.0f} |")
        L.append('')
    open(os.path.join(args.out, 'table5_simulation.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print(f"\nresults: {args.out}/table5_simulation.md")


if __name__ == '__main__':
    main()
