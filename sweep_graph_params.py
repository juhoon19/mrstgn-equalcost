#!/usr/bin/env python3
"""
Sensitivity of the model to the graph-construction parameters (Table 3).

One parameter is varied at a time, the others held at their defaults:
    kappa   geographic neighbours   default 8    swept over {4, 6, 8, 12, 16}
    K_f     flow-graph top-K        default 15   swept over {5, 10, 15, 20}
    delta_s similarity threshold    default 0.7  swept over
                                    {0.70, 0.80, 0.90, 0.95, 0.96, 0.97}

Edge density is recorded for every configuration, which is what shows that a
fixed similarity threshold of 0.7 leaves the graph at ~94% density.

Usage:
    python sweep_graph_params.py --epochs 60 --device cuda
    python sweep_graph_params.py --only delta_s        # sweep one parameter
"""

import os
import json
import time
import argparse

import numpy as np
import scipy.io as sio
import torch
from torch.utils.data import DataLoader

import mrstgn_paper as M

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)


def run_one(tag, flow, dist, centers, od_counts, T, train_end, val_end,
            k_geo, K_f, delta_s, args, outdir):
    """Train one configuration and return its metrics."""
    M.set_seed(args.seed)

    A_geo, sigma_d = M.build_geo_graph(dist, k=k_geo)
    A_flow = M.build_flow_graph(od_counts, K_f=K_f)
    A_sim, _ = M.build_sim_graph(flow[:train_end], delta_s=delta_s)

    dens = {n: float((A > 0).mean() * 100) for n, A in
            [('geo', A_geo), ('flow', A_flow), ('sim', A_sim)]}

    time_feat = M.build_time_features(T)
    static_feat = M.build_static_features(flow[:train_end], centers)
    nm_ = float(flow[:train_end].mean())
    ns_ = float(flow[:train_end].std() + 1e-6)

    tr = M.FlowDataset(flow[:train_end], time_feat[:train_end], args.seq_len, nm_, ns_)
    va = M.FlowDataset(flow[train_end:val_end], time_feat[train_end:val_end], args.seq_len, nm_, ns_)
    te = M.FlowDataset(flow[val_end:], time_feat[val_end:], args.seq_len, nm_, ns_)

    trl = DataLoader(tr, batch_size=args.batch_size, shuffle=True)
    val = DataLoader(va, batch_size=args.batch_size)
    tel = DataLoader(te, batch_size=args.batch_size)

    model = M.MRSTGN(flow.shape[1], A_geo, A_flow, A_sim, static_feat,
                     hidden_dim=args.hidden_dim, dropout=args.dropout)

    t0 = time.time()
    model, hist = M.train(model, trl, val, args.device, args.epochs,
                          args.lr, args.patience,
                          os.path.join(outdir, f'{tag}.log'))
    elapsed = time.time() - t0

    model.eval()
    P, Y, V, AT = [], [], [], []
    with torch.no_grad():
        for b in tel:
            mu, logvar, alpha = model(b['x_flow'].to(args.device),
                                      b['x_time'].to(args.device), return_attn=True)
            P.append(mu.cpu().numpy()); Y.append(b['y_flow'].numpy())
            V.append(torch.exp(logvar).cpu().numpy()); AT.append(alpha.cpu().numpy())
    P, Y, V, AT = (np.concatenate(x) for x in (P, Y, V, AT))

    rec = {
        'tag': tag, 'k_geo': k_geo, 'K_f': K_f, 'delta_s': delta_s,
        'density_pct': dens, 'sigma_d_km': sigma_d,
        'epochs_run': len(hist['train_loss']), 'minutes': round(elapsed / 60, 1),
        **M.metrics(P, Y), **M.prob_metrics(P, Y, V),
        'attn': {'geo': float(AT[..., 0].mean()),
                 'flow': float(AT[..., 1].mean()),
                 'sim': float(AT[..., 2].mean())},
    }
    print(f"\n>>> {tag}: MAE {rec['MAE']:.3f} RMSE {rec['RMSE']:.3f} "
          f"WMAPE {rec['WMAPE']:.2f}% | sim density {dens['sim']:.1f}% "
          f"| attn(g/f/s) {rec['attn']['geo']:.2f}/{rec['attn']['flow']:.2f}/{rec['attn']['sim']:.2f}"
          f" | {rec['minutes']}min\n", flush=True)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mat', default='dataset.mat')
    ap.add_argument('--out', default=os.path.join(HERE, 'sweep_out'))
    ap.add_argument('--od_npy', default=None)
    ap.add_argument('--only', default=None, choices=['k_geo', 'K_f', 'delta_s'])
    ap.add_argument('--seq_len', type=int, default=24)
    ap.add_argument('--hidden_dim', type=int, default=64)
    ap.add_argument('--batch_size', type=int, default=32)
    ap.add_argument('--epochs', type=int, default=60)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--patience', type=int, default=15)
    ap.add_argument('--dropout', type=float, default=0.1)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    print(f"device: {args.device} | torch {torch.__version__}", flush=True)

    m = sio.loadmat(args.mat)
    flow = m['flow_tensor'].astype(np.float32)
    dist = m['distance_matrix'].astype(np.float64)
    centers = m['grid_centers'].astype(np.float64)
    od_counts = (np.load(args.od_npy) if args.od_npy
                 else m['adj_flow'].astype(np.float64))
    T = flow.shape[0]
    train_end, val_end = int(T * 0.7), int(T * 0.85)

    DEF = dict(k_geo=8, K_f=15, delta_s=0.7)
    grids = {
        'k_geo':   [4, 6, 8, 12, 16],
        'K_f':     [5, 10, 15, 20],
        'delta_s': [0.70, 0.80, 0.90, 0.95, 0.96, 0.97],
    }
    if args.only:
        grids = {args.only: grids[args.only]}

    results_path = os.path.join(args.out, 'results.json')
    results = json.load(open(results_path, encoding='utf-8')) if os.path.exists(results_path) else []
    done = {r['tag'] for r in results}

    for pname, values in grids.items():
        for v in values:
            cfg = dict(DEF)
            cfg[pname] = v
            tag = f"{pname}={v}"
            if tag in done:
                print(f"skipping completed: {tag}", flush=True)
                continue
            print(f"\n{'='*70}\nrunning {tag}  (others at defaults {DEF})\n{'='*70}", flush=True)
            rec = run_one(tag, flow, dist, centers, od_counts, T, train_end, val_end,
                          cfg['k_geo'], cfg['K_f'], cfg['delta_s'], args, args.out)
            rec['swept'] = pname
            results.append(rec)
            with open(results_path, 'w', encoding='utf-8') as f:
                json.dump(results, f, indent=2, ensure_ascii=False)

    # Summary table
    print(f"\n{'='*90}\nSensitivity sweep summary\n{'='*90}")
    print(f"{'Setting':<16}{'MAE':>9}{'RMSE':>9}{'WMAPE%':>9}{'Corr':>8}"
          f"{'NLL':>9}{'PICP95':>9}{'SimDens%':>10}")
    for r in results:
        print(f"{r['tag']:<16}{r['MAE']:>9.3f}{r['RMSE']:>9.3f}{r['WMAPE']:>9.2f}"
              f"{r['Corr']:>8.4f}{r['NLL']:>9.3f}{r['PICP95']:>9.2f}"
              f"{r['density_pct']['sim']:>10.2f}")
    print(f"\nresults: {results_path}")


if __name__ == '__main__':
    main()
