#!/usr/bin/env python3
"""
Ablation study: the eight relational variants of Table 2.

Variants:
    No Graph (GRU only) | Geo Only | Flow Only | Sim Only
    Geo+Flow | Geo+Sim | Flow+Sim | MR-STGN (Full)

The Sim Only and Flow+Sim variants also address whether the similarity graph
carries information the temporal encoder does not already have: compare
Sim Only against No Graph, and Flow+Sim against Geo+Flow.
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

VARIANTS_ALL = [
    ('No Graph (GRU only)', ()),
    ('Geo Only',            ('geo',)),
    ('Flow Only',           ('flow',)),
    ('Sim Only',            ('sim',)),
    ('Geo + Flow',          ('geo', 'flow')),
    ('Geo + Sim',           ('geo', 'sim')),
    ('Flow + Sim',          ('flow', 'sim')),
    ('MR-STGN (Full)',      ('geo', 'flow', 'sim')),
]

# Cross-city validation and multi-seed significance testing only need the
# comparisons the paper makes claims about, not all eight combinations.
SUBSETS = {
    'all':      [n for n, _ in VARIANTS_ALL],
    'key':      ['No Graph (GRU only)', 'Geo Only', 'Flow Only', 'MR-STGN (Full)'],
    'headline': ['No Graph (GRU only)', 'MR-STGN (Full)'],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mat', default='dataset.mat')
    ap.add_argument('--out', default=os.path.join(HERE, 'ablation_out'))
    ap.add_argument('--od_npy', default=None)
    ap.add_argument('--delta_s', type=float, default=0.7,
                    help='similarity-graph threshold; 0.7 yields ~94%% density, see the sweep')
    ap.add_argument('--k_geo', type=int, default=8)
    ap.add_argument('--K_f', type=int, default=15)
    ap.add_argument('--seeds', type=int, nargs='+', default=[42],
                    help='several seeds -> report mean and standard deviation')
    ap.add_argument('--seq_len', type=int, default=24)
    ap.add_argument('--hidden_dim', type=int, default=64)
    ap.add_argument('--batch_size', type=int, default=32)
    ap.add_argument('--epochs', type=int, default=100)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--patience', type=int, default=20)
    ap.add_argument('--dropout', type=float, default=0.1)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    ap.add_argument('--variants', default='key',
                    help="'all' | 'key' | 'headline' | comma-separated variant names")
    args = ap.parse_args()

    if args.variants in SUBSETS:
        want_variants = SUBSETS[args.variants]
    else:
        want_variants = [v.strip() for v in args.variants.split(',')]
    VARIANTS = [(n, r) for n, r in VARIANTS_ALL if n in want_variants]
    if not VARIANTS:
        raise SystemExit(f"no variant matched: {args.variants}")
    print(f"variants in this run ({len(VARIANTS)}): {[n for n, _ in VARIANTS]}", flush=True)

    os.makedirs(args.out, exist_ok=True)
    print(f"device: {args.device} | torch {torch.__version__}", flush=True)

    m = sio.loadmat(args.mat)
    flow = m['flow_tensor'].astype(np.float32)
    dist = m['distance_matrix'].astype(np.float64)
    centers = m['grid_centers'].astype(np.float64)
    if args.od_npy:
        od_counts = np.load(args.od_npy)
    elif 'od_train' in m:
        od_counts = m['od_train'].astype(np.float64)   # training-period OD
    else:
        od_counts = m['adj_flow'].astype(np.float64)   # OD from the dataset's adj_flow key
    T, N, _ = flow.shape
    train_end, val_end = int(T * 0.7), int(T * 0.85)

    A_geo, _ = M.build_geo_graph(dist, k=args.k_geo)
    A_flow = M.build_flow_graph(od_counts, K_f=args.K_f)
    A_sim, _ = M.build_sim_graph(flow[:train_end], delta_s=args.delta_s)

    time_feat = M.build_time_features(T)
    static_feat = M.build_static_features(flow[:train_end], centers)
    nm_ = float(flow[:train_end].mean())
    ns_ = float(flow[:train_end].std() + 1e-6)

    tr = M.FlowDataset(flow[:train_end], time_feat[:train_end], args.seq_len, nm_, ns_)
    va = M.FlowDataset(flow[train_end:val_end], time_feat[train_end:val_end], args.seq_len, nm_, ns_)
    te = M.FlowDataset(flow[val_end:], time_feat[val_end:], args.seq_len, nm_, ns_)

    results_path = os.path.join(args.out, 'results.json')
    results = json.load(open(results_path, encoding='utf-8')) if os.path.exists(results_path) else []
    done = {(r['variant'], r['seed']) for r in results}

    for name, rels in VARIANTS:
        for seed in args.seeds:
            if (name, seed) in done:
                print(f"skipping completed: {name} seed={seed}", flush=True)
                continue
            print(f"\n{'='*70}\n{name}   relations={rels}   seed={seed}\n{'='*70}", flush=True)
            M.set_seed(seed)

            trl = DataLoader(tr, batch_size=args.batch_size, shuffle=True)
            val = DataLoader(va, batch_size=args.batch_size)
            tel = DataLoader(te, batch_size=args.batch_size)

            model = M.MRSTGN(N, A_geo, A_flow, A_sim, static_feat,
                             hidden_dim=args.hidden_dim, dropout=args.dropout,
                             relations=rels)
            t0 = time.time()
            tag = name.replace(' ', '_').replace('(', '').replace(')', '').replace('+', 'p')
            model, hist = M.train(model, trl, val, args.device, args.epochs,
                                  args.lr, args.patience,
                                  os.path.join(args.out, f'{tag}_s{seed}.log'))
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

            rec = {'variant': name, 'relations': list(rels), 'seed': seed,
                   'epochs_run': len(hist['train_loss']), 'minutes': round(elapsed / 60, 1),
                   'n_params': int(sum(p.numel() for p in model.parameters())),
                   **M.metrics(P, Y), **M.prob_metrics(P, Y, V),
                   'attn': {'geo': float(AT[..., 0].mean()),
                            'flow': float(AT[..., 1].mean()),
                            'sim': float(AT[..., 2].mean())}}
            results.append(rec)
            with open(results_path, 'w', encoding='utf-8') as f:
                json.dump(results, f, indent=2, ensure_ascii=False)
            np.savez_compressed(os.path.join(args.out, f'{tag}_s{seed}_test.npz'),
                                preds=P, targets=Y, vars=V, attn=AT)
            print(f"\n>>> {name}: MAE {rec['MAE']:.3f}  RMSE {rec['RMSE']:.3f}  "
                  f"WMAPE {rec['WMAPE']:.2f}%  ({rec['minutes']}min)\n", flush=True)

    # Summary, laid out like Table 2
    full = [r['MAE'] for r in results if r['variant'] == 'MR-STGN (Full)']
    base = np.mean(full) if full else None
    print(f"\n{'='*96}\nAblation summary (Table 2)\n{'='*96}")
    print(f"{'Variant':<24}{'MAE':>10}{'RMSE':>10}{'WMAPE%':>10}{'Rel.dMAE':>11}"
          f"{'NLL':>9}{'PICP95':>9}{'params':>9}")
    for name, _ in VARIANTS:
        rs = [r for r in results if r['variant'] == name]
        if not rs:
            continue
        mae = np.mean([r['MAE'] for r in rs])
        sd = np.std([r['MAE'] for r in rs])
        rel = f"{(mae/base-1)*100:+.1f}%" if base else '-'
        print(f"{name:<24}{mae:>10.3f}{np.mean([r['RMSE'] for r in rs]):>10.3f}"
              f"{np.mean([r['WMAPE'] for r in rs]):>10.2f}{rel:>11}"
              f"{np.mean([r['NLL'] for r in rs]):>9.3f}"
              f"{np.mean([r['PICP95'] for r in rs]):>9.2f}{rs[0]['n_params']:>9d}"
              + (f"   (±{sd:.3f}, n={len(rs)})" if len(rs) > 1 else ""))
    print(f"\nresults: {results_path}")


if __name__ == '__main__':
    main()
