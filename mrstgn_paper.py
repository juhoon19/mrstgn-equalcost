#!/usr/bin/env python3
"""
MR-STGN: multi-relational spatio-temporal graph network for regional
shared-bicycle flow prediction.

Implements the model of Section 3.2 of the paper:

  Graph construction (Sec. 3.2.1)
    geo   Eq.(4)  A_ij = exp(-d_ij^2 / 2*sigma_d^2) for the kappa nearest
                  neighbours of i, else 0. sigma_d is the standard deviation
                  of all pairwise distances. Directed, exactly kappa edges
                  per row, not symmetrized.
    flow  Eq.(5)  A_ij = OD_ij / max(OD) over training-period trips, top-K_f
                  per row, directed and asymmetric.
    sim   Eq.(6)  cosine similarity between 48-dim hourly usage profiles
                  (24h outflow + 24h inflow) computed on the training period,
                  thresholded at delta_s. The threshold is chosen to hit a
                  target edge density rather than fixed, because the cosine
                  distribution is city-specific (see Sec. 3.2.1).
    All three are built from training-period data only and held fixed
    thereafter. Normalization: A~^r = D^-1 (A^r + I).

  Encoding (Sec. 3.2.2)  Eq.(7)(8): three independent linear projections
    summed with a learnable node embedding E_node ~ N(0, 0.01^2).

  Temporal (Sec. 3.2.3)  Eq.(9): single-layer GRU, dropout 0.1.

  Spatial fusion (Sec. 3.2.4)  Eq.(10)-(13): one relation-specific weight
    matrix per graph, per-region softmax attention over the three relational
    outputs, residual + dropout + layer normalization.

  Output (Sec. 3.2.5)  Eq.(14)(15): two 2-layer MLP heads with ReLU; the
    variance head emits log sigma^2 for numerical stability.
    Eq.(16) loss: Gaussian NLL + lambda * MAE (lambda = 0.1), computed
    independently for the outflow and inflow channels and summed.

  Features (Sec. 4.1)
    F_t = 5  hour-of-day, day-of-week, is-weekend, is-morning-peak,
             is-evening-peak
    F_s = 4  training-period mean flow, training-period flow variance,
             grid-centroid longitude and latitude
    Input flow sequences are standardized with training-set statistics only.

  Relation subsets
    The `relations` argument selects any subset of the three graphs; the
    empty tuple disables spatial propagation entirely. This is what
    run_ablation.py uses to produce the ablation table.

Usage
    python mrstgn_paper.py --mat <dataset.mat> --delta_s <threshold> \
        --epochs 100 --out ./out

The dataset file must provide flow_tensor (T,N,2), distance_matrix (N,N),
grid_centers (N,2) and an origin-destination count matrix. Supply the OD
counts either as the `od_train` key of the dataset or via --od_npy; both are
expected to be accumulated over the training period only. See README.md for
how the two datasets used in the paper are prepared.
"""

import os
import json
import argparse
from datetime import datetime, timedelta

import numpy as np
import scipy.io as sio
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from torch.optim.lr_scheduler import CosineAnnealingWarmRestarts

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)


def set_seed(seed=42):
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


# =====================================================================
# 1. Graph construction, Eq. (4)(5)(6)
# =====================================================================
def build_geo_graph(dist_matrix, k=8):
    """Eq.(4): thresholded Gaussian kernel; kappa_i is the distance of the k-th
    nearest neighbour, so every row has exactly k edges."""
    N = dist_matrix.shape[0]
    off = ~np.eye(N, dtype=bool)
    sigma_d = dist_matrix[off].std()
    A = np.zeros((N, N), dtype=np.float64)
    for i in range(N):
        order = np.argsort(dist_matrix[i])
        nearest = order[order != i][:k]
        A[i, nearest] = np.exp(-dist_matrix[i, nearest] ** 2 / (2 * sigma_d ** 2))
    return A, float(sigma_d)


def build_flow_graph(od_counts, K_f=15):
    """Eq.(5): normalized by the global maximum, top-K_f per row, directed."""
    N = od_counts.shape[0]
    od = od_counts.astype(np.float64).copy()
    np.fill_diagonal(od, 0.0)
    mx = od.max()
    A_full = od / (mx if mx > 0 else 1.0)
    A = np.zeros_like(A_full)
    for i in range(N):
        row = A_full[i]
        nz = np.flatnonzero(row > 0)
        if nz.size == 0:
            continue
        keep = nz[np.argsort(row[nz])[-K_f:]]
        A[i, keep] = row[keep]
    return A


def build_sim_graph(flow_train, delta_s=0.7, hour_offset=0):
    """Eq.(6): cosine similarity between 48-dimensional hourly profiles
    (24h outflow followed by 24h inflow), thresholded at delta_s.

    Uses training-period data only (flow_train).
    """
    T, N, _ = flow_train.shape
    hours = (np.arange(T) + hour_offset) % 24
    prof = np.zeros((N, 48), dtype=np.float64)
    for h in range(24):
        mask = hours == h
        if mask.sum() == 0:
            continue
        prof[:, h] = flow_train[mask, :, 0].mean(axis=0)       # outflow
        prof[:, 24 + h] = flow_train[mask, :, 1].mean(axis=0)  # inflow
    norm = np.linalg.norm(prof, axis=1, keepdims=True) + 1e-12
    P = prof / norm
    cos = P @ P.T
    A = np.where(cos >= delta_s, cos, 0.0)
    np.fill_diagonal(A, 0.0)
    return A, prof


# =====================================================================
# 2. Features, Section 4.1
# =====================================================================
def build_time_features(T, start_date='2021-04-01'):
    """F_t = 5: hour-of-day, day-of-week, is-weekend, is-morning-peak, is-evening-peak"""
    base = datetime.strptime(start_date, '%Y-%m-%d').date()
    tf = np.zeros((T, 5), dtype=np.float32)
    for t in range(T):
        hour = t % 24
        cur = base + timedelta(days=t // 24)
        wd = cur.weekday()
        tf[t] = [hour / 23.0,
                 wd / 6.0,
                 1.0 if wd >= 5 else 0.0,
                 1.0 if 7 <= hour <= 9 else 0.0,
                 1.0 if 17 <= hour <= 19 else 0.0]
    return tf


def build_static_features(flow_train, grid_centers):
    """F_s = 4: training-period mean flow and flow variance, plus cell centroid
    longitude and latitude, each column z-scored."""
    total = flow_train.sum(axis=2)                 # (T_train, N)
    mean_flow = total.mean(axis=0)
    var_flow = total.var(axis=0)
    lat = grid_centers[:, 0]
    lng = grid_centers[:, 1]
    X = np.stack([mean_flow, var_flow, lng, lat], axis=1).astype(np.float64)
    X = (X - X.mean(axis=0)) / (X.std(axis=0) + 1e-8)
    return X.astype(np.float32)


# =====================================================================
# 3. Model, Eq. (7)-(15)
# =====================================================================
class MRSTGN(nn.Module):
    """relations: any subset of ('geo','flow','sim'); the empty tuple disables
    spatial propagation entirely, which is the No Graph ablation variant."""

    def __init__(self, n_regions, adj_geo, adj_flow, adj_sim,
                 static_features, hidden_dim=64, f_t=5, f_s=4, dropout=0.1,
                 relations=('geo', 'flow', 'sim')):
        super().__init__()
        self.N = n_regions
        self.D = hidden_dim
        self.relations = tuple(relations)

        # Ã^r = D^{-1}(A^r + I)
        for name, adj in [('adj_geo', adj_geo), ('adj_flow', adj_flow), ('adj_sim', adj_sim)]:
            a = torch.tensor(adj, dtype=torch.float32) + torch.eye(n_regions)
            deg = a.sum(dim=1, keepdim=True).clamp(min=1e-6)
            self.register_buffer(name, a / deg)

        self.register_buffer('x_static', torch.tensor(static_features, dtype=torch.float32))

        # Eq.(7): three independent linear projections
        self.phi_flow = nn.Linear(2, hidden_dim)
        self.phi_time = nn.Linear(f_t, hidden_dim)
        self.phi_static = nn.Linear(f_s, hidden_dim)

        # Eq.(8): learnable node embedding E_node ~ N(0, 0.01^2)
        self.node_emb = nn.Parameter(torch.empty(n_regions, hidden_dim))
        nn.init.normal_(self.node_emb, mean=0.0, std=0.01)

        # Eq.(9): single-layer GRU
        self.gru = nn.GRU(hidden_dim, hidden_dim, num_layers=1, batch_first=True)

        # Eq.(10): one W^r per relation, allocated only for enabled relations
        self.W_rel = nn.ModuleDict({
            r: nn.Linear(hidden_dim, hidden_dim, bias=False) for r in self.relations})

        # Eq.(11): relational attention. With a single relation the softmax
        # is identically 1, which reduces to the single-graph case.
        R = len(self.relations)
        self.W_att = nn.Linear(hidden_dim * R, R) if R > 0 else None

        # Eq.(13)
        self.dropout = nn.Dropout(dropout)
        self.norm = nn.LayerNorm(hidden_dim)

        # Eq.(14)(15): two heads, each two linear layers with ReLU
        self.head_mu = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2), nn.ReLU(),
            nn.Linear(hidden_dim // 2, 2))
        self.head_logvar = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2), nn.ReLU(),
            nn.Linear(hidden_dim // 2, 2))

    def forward(self, flow, time_feat, return_attn=False):
        B, T, N, _ = flow.shape

        # Eq.(7)(8): the four terms are summed
        z = (self.phi_flow(flow)
             + self.phi_time(time_feat).unsqueeze(2)
             + self.phi_static(self.x_static).unsqueeze(0).unsqueeze(0)
             + self.node_emb.unsqueeze(0).unsqueeze(0))

        # Eq.(9)
        z = z.permute(0, 2, 1, 3).reshape(B * N, T, self.D)
        h, _ = self.gru(z)
        H_temp = h[:, -1, :].reshape(B, N, self.D)

        if len(self.relations) == 0:
            # No Graph ablation: skip spatial propagation
            H_sp = self.norm(H_temp)
            alpha = torch.zeros(B, N, 3, device=flow.device)
        else:
            # Eq.(10)
            adjs = {'geo': self.adj_geo, 'flow': self.adj_flow, 'sim': self.adj_sim}
            Hs = [F.relu(self.W_rel[r](torch.matmul(adjs[r], H_temp))) for r in self.relations]

            # Eq.(11)(12)
            a = F.softmax(self.W_att(torch.cat(Hs, dim=-1)), dim=-1)
            H_fused = sum(a[..., i:i + 1] * Hs[i] for i in range(len(Hs)))

            # Eq.(13)
            H_sp = self.norm(H_temp + self.dropout(H_fused))

            # Map back onto fixed (geo, flow, sim) columns, zero for any
            # relation that is disabled, so records stay comparable.
            alpha = torch.zeros(B, N, 3, device=flow.device)
            for i, r in enumerate(self.relations):
                alpha[..., ['geo', 'flow', 'sim'].index(r)] = a[..., i]

        # Eq.(14)(15)
        mu = self.head_mu(H_sp)
        logvar = self.head_logvar(H_sp).clamp(-10.0, 10.0)

        if return_attn:
            return mu, logvar, alpha
        return mu, logvar


def gaussian_loss(mu, logvar, y, lam=0.1):
    """Eq.(16): computed independently per channel (outflow, inflow), summed."""
    total = 0.0
    for c in range(y.shape[-1]):
        m, lv, t = mu[..., c], logvar[..., c], y[..., c]
        var = torch.exp(lv)
        nll = ((t - m) ** 2) / (2 * var) + 0.5 * lv
        total = total + nll.mean() + lam * (t - m).abs().mean()
    return total


# =====================================================================
# 4. Dataset, Section 4.2.1: standardized with training-set statistics only
# =====================================================================
class FlowDataset(Dataset):
    def __init__(self, flow, time_feat, seq_len, norm_mean, norm_std):
        self.flow = flow
        self.time_feat = time_feat
        self.seq_len = seq_len
        self.mean = norm_mean
        self.std = norm_std
        self.valid_indices = list(range(seq_len, len(flow) - 1))

    def __len__(self):
        return len(self.valid_indices)

    def __getitem__(self, idx):
        t = self.valid_indices[idx]
        x_flow = (self.flow[t - self.seq_len:t] - self.mean) / self.std
        return {
            'x_flow': torch.tensor(x_flow, dtype=torch.float32),
            'x_time': torch.tensor(self.time_feat[t - self.seq_len:t], dtype=torch.float32),
            'y_flow': torch.tensor(self.flow[t], dtype=torch.float32),
        }


def metrics(preds, targets):
    mae = float(np.abs(preds - targets).mean())
    rmse = float(np.sqrt(((preds - targets) ** 2).mean()))
    mask = targets > 1
    mape = float(np.abs((preds[mask] - targets[mask]) / targets[mask]).mean() * 100) if mask.sum() else 0.0
    corr = float(np.corrcoef(preds.flatten(), targets.flatten())[0, 1])
    r2 = float(1 - ((preds - targets) ** 2).sum() / ((targets - targets.mean()) ** 2).sum())
    wmape = float(np.abs(preds - targets).sum() / np.abs(targets).sum() * 100)
    return dict(MAE=mae, RMSE=rmse, MAPE=mape, Corr=corr, R2=r2, WMAPE=wmape)


def prob_metrics(preds, targets, variances):
    """Probabilistic metrics over the full test set."""
    sigma = np.sqrt(np.maximum(variances, 1e-12))
    z = (targets - preds) / sigma
    nll = float((0.5 * np.log(2 * np.pi * variances) + 0.5 * z ** 2).mean())
    out = {'NLL': nll}
    for lvl, k in [(50, 0.6745), (90, 1.6449), (95, 1.9600)]:
        lo, hi = preds - k * sigma, preds + k * sigma
        out[f'PICP{lvl}'] = float(((targets >= lo) & (targets <= hi)).mean() * 100)
        out[f'MPIW{lvl}'] = float((hi - lo).mean())
    # CRPS, closed form for a Gaussian predictive distribution
    from math import sqrt, pi
    from scipy.special import erf
    phi = np.exp(-0.5 * z ** 2) / sqrt(2 * pi)
    Phi = 0.5 * (1 + erf(z / sqrt(2)))
    out['CRPS'] = float((sigma * (z * (2 * Phi - 1) + 2 * phi - 1 / sqrt(pi))).mean())
    return out


def train(model, train_loader, val_loader, device, epochs, lr, patience, log_path):
    model = model.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = CosineAnnealingWarmRestarts(opt, T_0=10, T_mult=2)
    history = {k: [] for k in ['train_loss', 'val_loss', 'val_mae', 'val_rmse',
                               'val_mape', 'val_corr', 'lr']}
    best, best_state, wait = float('inf'), None, 0
    logf = open(log_path, 'w', encoding='utf-8')

    for ep in range(epochs):
        model.train()
        tl = 0.0
        for b in train_loader:
            x, tf, y = b['x_flow'].to(device), b['x_time'].to(device), b['y_flow'].to(device)
            opt.zero_grad()
            mu, logvar = model(x, tf)
            loss = gaussian_loss(mu, logvar, y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            tl += loss.item()
        tl /= len(train_loader)
        sched.step()

        model.eval()
        vl = 0.0
        P, Y = [], []
        with torch.no_grad():
            for b in val_loader:
                x, tf, y = b['x_flow'].to(device), b['x_time'].to(device), b['y_flow'].to(device)
                mu, logvar = model(x, tf)
                vl += gaussian_loss(mu, logvar, y).item()
                P.append(mu.cpu().numpy()); Y.append(y.cpu().numpy())
        vl /= len(val_loader)
        P, Y = np.concatenate(P), np.concatenate(Y)
        m = metrics(P, Y)

        history['train_loss'].append(tl); history['val_loss'].append(vl)
        history['val_mae'].append(m['MAE']); history['val_rmse'].append(m['RMSE'])
        history['val_mape'].append(m['MAPE']); history['val_corr'].append(m['Corr'])
        history['lr'].append(opt.param_groups[0]['lr'])

        line = (f"Epoch {ep+1:3d} | Train: {tl:.4f} | Val: {vl:.4f} | MAE: {m['MAE']:.2f} | "
                f"RMSE: {m['RMSE']:.2f} | MAPE: {m['MAPE']:.1f}% | Corr: {m['Corr']:.4f}")
        print(line, flush=True); logf.write(line + '\n'); logf.flush()

        if vl < best:
            best, wait = vl, 0
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
        else:
            wait += 1
            if wait >= patience:
                print(f"Early stopping at epoch {ep+1}", flush=True)
                logf.write(f"Early stopping at epoch {ep+1}\n")
                break
    logf.close()
    if best_state:
        model.load_state_dict(best_state)
    return model, history


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mat', default='dataset.mat')
    ap.add_argument('--out', default=os.path.join(HERE, 'out_paper'))
    ap.add_argument('--od_npy', default=None,
                    help='training-period OD count matrix (N,N) as .npy; overrides the dataset key')
    ap.add_argument('--k_geo', type=int, default=8)
    ap.add_argument('--k_flow', type=int, default=15)
    ap.add_argument('--delta_s', type=float, default=0.95,
                    help='similarity threshold. Chosen per city to reach a comparable graph density (19.6 per cent): 0.95 for Shenzhen, 0.967 for Shanghai, 0.981 for Chicago. A fixed threshold does not transfer between cities; see Section 3.2.1 of the paper.')
    ap.add_argument('--seq_len', type=int, default=24)
    ap.add_argument('--hidden_dim', type=int, default=64)
    ap.add_argument('--batch_size', type=int, default=32)
    ap.add_argument('--epochs', type=int, default=100)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--patience', type=int, default=20)
    ap.add_argument('--dropout', type=float, default=0.1)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    set_seed(args.seed)
    print(f"device: {args.device} | torch {torch.__version__}")

    m = sio.loadmat(args.mat)
    flow = m['flow_tensor'].astype(np.float32)
    dist = m['distance_matrix'].astype(np.float64)
    centers = m['grid_centers'].astype(np.float64)
    T, N, _ = flow.shape
    train_end, val_end = int(T * 0.7), int(T * 0.85)
    print(f"flow_tensor {flow.shape} | train_end={train_end} val_end={val_end}")

    # ---- graph construction ----
    A_geo, sigma_d = build_geo_graph(dist, k=args.k_geo)

    if args.od_npy:
        od_counts = np.load(args.od_npy)
        od_source = f'train_period_od:{os.path.basename(args.od_npy)}'
    elif 'od_train' in m:
        # OD counts accumulated over the training period only
        od_counts = m['od_train'].astype(np.float64)
        od_source = 'training-period OD (dataset key: od_train)'
    else:
        # Eq.(5) normalizes by the global maximum, so any constant scaling of
        # the OD counts cancels out.
        od_counts = m['adj_flow'].astype(np.float64)
        od_source = 'OD from dataset key: adj_flow (verify it covers the training period only)'
    A_flow = build_flow_graph(od_counts, K_f=args.k_flow)

    A_sim, _ = build_sim_graph(flow[:train_end], delta_s=args.delta_s)

    print("\n=== graph structures, Eq. (4)(5)(6) ===")
    for nm, A in [('Geo', A_geo), ('Flow', A_flow), ('Sim', A_sim)]:
        e = int((A > 0).sum())
        print(f"  {nm:5s} edges {e:6d}  density {e/(N*N)*100:5.2f}%  "
              f"median out-degree {np.median((A>0).sum(1)):.0f}")
    print(f"  sigma_d = {sigma_d:.4f} km | OD source: {od_source}")

    # ---- features ----
    time_feat = build_time_features(T)
    static_feat = build_static_features(flow[:train_end], centers)

    # ---- standardization: training-set statistics only ----
    nm_, ns_ = float(flow[:train_end].mean()), float(flow[:train_end].std() + 1e-6)
    print(f"  standardization (training set): mean={nm_:.4f} std={ns_:.4f}")

    tr = FlowDataset(flow[:train_end], time_feat[:train_end], args.seq_len, nm_, ns_)
    va = FlowDataset(flow[train_end:val_end], time_feat[train_end:val_end], args.seq_len, nm_, ns_)
    te = FlowDataset(flow[val_end:], time_feat[val_end:], args.seq_len, nm_, ns_)
    print(f"  splits: train={len(tr)}, val={len(va)}, test={len(te)}")

    trl = DataLoader(tr, batch_size=args.batch_size, shuffle=True)
    val = DataLoader(va, batch_size=args.batch_size)
    tel = DataLoader(te, batch_size=args.batch_size)

    model = MRSTGN(N, A_geo, A_flow, A_sim, static_feat,
                   hidden_dim=args.hidden_dim, dropout=args.dropout)
    n_par = sum(p.numel() for p in model.parameters())
    print(f"  parameters: {n_par:,}\n")

    model, history = train(model, trl, val, args.device, args.epochs,
                           args.lr, args.patience, os.path.join(args.out, 'training.log'))

    # ---- test ----
    model.eval()
    P, Y, V, AT = [], [], [], []
    with torch.no_grad():
        for b in tel:
            mu, logvar, alpha = model(b['x_flow'].to(args.device),
                                      b['x_time'].to(args.device), return_attn=True)
            P.append(mu.cpu().numpy()); Y.append(b['y_flow'].numpy())
            V.append(torch.exp(logvar).cpu().numpy()); AT.append(alpha.cpu().numpy())
    P, Y, V, AT = (np.concatenate(x) for x in (P, Y, V, AT))

    res = metrics(P, Y)
    pres = prob_metrics(P, Y, V)
    print("\n=== test set, point prediction ===")
    for k, v in res.items():
        print(f"  {k}: {v:.4f}")
    print("=== test set, probabilistic calibration ===")
    for k, v in pres.items():
        print(f"  {k}: {v:.4f}")
    print("=== mean relational attention ===")
    print(f"  geo {AT[...,0].mean():.4f} | flow {AT[...,1].mean():.4f} | sim {AT[...,2].mean():.4f}")

    torch.save(model.state_dict(), os.path.join(args.out, 'model.pt'))
    np.savez_compressed(os.path.join(args.out, 'test_outputs.npz'),
                        preds=P, targets=Y, vars=V, attn=AT)
    np.savez_compressed(os.path.join(args.out, 'graphs.npz'),
                        A_geo=A_geo, A_flow=A_flow, A_sim=A_sim, static=static_feat)
    with open(os.path.join(args.out, 'history.json'), 'w', encoding='utf-8') as f:
        json.dump(history, f)
    with open(os.path.join(args.out, 'metrics.json'), 'w', encoding='utf-8') as f:
        json.dump({'test': res, 'prob': pres,
                   'attn_mean': {'geo': float(AT[..., 0].mean()),
                                 'flow': float(AT[..., 1].mean()),
                                 'sim': float(AT[..., 2].mean())},
                   'graph': {'sigma_d_km': sigma_d, 'od_source': od_source,
                             'k_geo': args.k_geo, 'K_f': args.k_flow, 'delta_s': args.delta_s,
                             'edges_geo': int((A_geo > 0).sum()),
                             'edges_flow': int((A_flow > 0).sum()),
                             'edges_sim': int((A_sim > 0).sum())},
                   'n_params': int(n_par), 'seed': args.seed,
                   'epochs_run': len(history['train_loss'])}, f, indent=2, ensure_ascii=False)
    print(f"\noutput directory: {args.out}")


if __name__ == '__main__':
    main()
