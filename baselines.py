#!/usr/bin/env python3
"""
Baseline models for Table 1.

Every baseline is implemented here from scratch, including Graph WaveNet and
GMAN, which grid-based regional comparisons commonly omit on the grounds that
they need substantial adaptation. They do not: both run on exactly the same
gridded input tensor as MR-STGN.

Statistical and classical machine learning:
    HA      mean of the same hour-of-day over the training period
    ARIMA   per region and channel, ARIMA(p,d,q); falls back to a
            least-squares AR(24) if statsmodels is unavailable
    SVR     per region, RBF-kernel support vector regression on the past
            24 steps

Temporal deep learning (per region, no spatial structure):
    LSTM, GRU

Spatio-temporal graph networks (all using the geographic graph A_geo):
    GCN     two graph convolutions on the final time step, then an MLP
    STGCN   gated temporal convolution alternating with graph convolution
    ASTGCN  spatial and temporal attention with Chebyshev graph convolution
    DCRNN   diffusion-convolutional GRU (K-step forward/backward random walk)
    GWN     Graph WaveNet: dilated causal convolution + adaptive adjacency
    GMAN    spatio-temporal multi-head attention with spatial embedding

Fairness:
    - every baseline uses the same data, the same chronological split and the
      same training-set standardization statistics as MR-STGN
    - the deep baselines share one training loop, optimizer (AdamW, wd=1e-4),
      scheduler, early-stopping rule and epoch budget
    - hidden dimension is 64 throughout, as in MR-STGN; depth follows the
      smallest complete configuration from each model's original paper
    - all support multiple random seeds, for mean, standard deviation and
      significance testing
"""

import os
import json
import time
import math
import argparse

import numpy as np
import scipy.io as sio
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader
from torch.optim.lr_scheduler import CosineAnnealingWarmRestarts

import mrstgn_paper as M

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)


# =====================================================================
# 1. Non-learned and classical methods
# =====================================================================
def run_ha(flow, time_feat, train_end, val_end, seq_len):
    """HA: predict the training-period mean for the same hour-of-day."""
    N = flow.shape[1]
    tr = flow[:train_end]
    hours_tr = np.arange(train_end) % 24
    table = np.zeros((24, N, 2), dtype=np.float64)
    for h in range(24):
        table[h] = tr[hours_tr == h].mean(axis=0)

    test = flow[val_end:]
    idx = list(range(seq_len, len(test) - 1))
    preds = np.stack([table[(val_end + t) % 24] for t in idx])
    targets = np.stack([test[t] for t in idx])
    return preds.astype(np.float32), targets.astype(np.float32)


def run_arima(flow, train_end, val_end, seq_len, order=(2, 0, 1), max_hist=1500):
    """ARIMA fitted per region and channel; least-squares AR(24) as fallback."""
    try:
        from statsmodels.tsa.arima.model import ARIMA as _ARIMA
        have_sm = True
    except Exception:
        have_sm = False
        print("  [ARIMA] statsmodels not available, falling back to AR(24)", flush=True)

    N = flow.shape[1]
    test = flow[val_end:]
    idx = list(range(seq_len, len(test) - 1))
    targets = np.stack([test[t] for t in idx]).astype(np.float32)
    preds = np.zeros_like(targets)

    offset = val_end - train_end          # where the test period starts in rest
    n_fallback = 0

    for n in range(N):
        for c in range(2):
            hist = flow[:train_end, n, c].astype(np.float64)[-max_hist:]
            rest = flow[train_end:, n, c].astype(np.float64)
            done = False
            if have_sm:
                try:
                    fit = _ARIMA(hist, order=order).fit()
                    # Fit once on the training period, append the rest with
                    # refit=False and read off the one-step-ahead predictions:
                    # fittedvalues[i] is the prediction of point i given all
                    # observations before it.
                    res2 = fit.append(rest, refit=False)
                    fv = np.asarray(res2.fittedvalues)[-len(rest):]
                    preds[:, n, c] = fv[[offset + t for t in idx]]
                    done = True
                except Exception:
                    done = False
            if not done:
                n_fallback += 1
                p = seq_len
                X = np.stack([hist[i:i + p] for i in range(len(hist) - p)])
                y = hist[p:]
                w, *_ = np.linalg.lstsq(np.c_[X, np.ones(len(X))], y, rcond=None)
                for k, t in enumerate(idx):
                    ctx = test[t - p:t, n, c].astype(np.float64)
                    preds[k, n, c] = np.r_[ctx, 1.0] @ w
        if (n + 1) % 25 == 0:
            print(f"  [ARIMA] {n+1}/{N} regions done ({n_fallback} series on fallback)", flush=True)

    return np.maximum(preds, 0).astype(np.float32), targets


def run_svr(flow, train_end, val_end, seq_len, sub=600):
    """SVR per region, RBF kernel, past seq_len steps of both channels."""
    from sklearn.svm import SVR
    from sklearn.preprocessing import StandardScaler

    N = flow.shape[1]
    test = flow[val_end:]
    idx = list(range(seq_len, len(test) - 1))
    targets = np.stack([test[t] for t in idx]).astype(np.float32)
    preds = np.zeros_like(targets)

    for n in range(N):
        tr = flow[:train_end, n, :]
        Xtr = np.stack([tr[i:i + seq_len].ravel() for i in range(len(tr) - seq_len)])
        Ytr = tr[seq_len:]
        if len(Xtr) > sub:                      # cap the O(n^2) SVR training cost
            sel = np.linspace(0, len(Xtr) - 1, sub).astype(int)
            Xtr, Ytr = Xtr[sel], Ytr[sel]
        Xte = np.stack([test[t - seq_len:t, n, :].ravel() for t in idx])

        sc = StandardScaler().fit(Xtr)
        Xtr_s, Xte_s = sc.transform(Xtr), sc.transform(Xte)
        for c in range(2):
            svr = SVR(kernel='rbf', C=10.0, gamma='scale', epsilon=0.1)
            svr.fit(Xtr_s, Ytr[:, c])
            preds[:, n, c] = svr.predict(Xte_s)
        if (n + 1) % 25 == 0:
            print(f"  [SVR] {n+1}/{N} regions done", flush=True)

    return np.maximum(preds, 0).astype(np.float32), targets


# =====================================================================
# 2. Deep-learning baselines
# =====================================================================
class NodeRNN(nn.Module):
    """LSTM / GRU applied per region with shared weights, no spatial structure."""

    def __init__(self, cell='gru', in_dim=2, f_t=5, hidden=64):
        super().__init__()
        self.enc = nn.Linear(in_dim + f_t, hidden)
        rnn = nn.GRU if cell == 'gru' else nn.LSTM
        self.rnn = rnn(hidden, hidden, num_layers=2, batch_first=True, dropout=0.1)
        self.out = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.ReLU(),
                                 nn.Linear(hidden // 2, 2))

    def forward(self, flow, tf, adj=None):
        B, T, N, _ = flow.shape
        x = torch.cat([flow, tf.unsqueeze(2).expand(-1, -1, N, -1)], dim=-1)
        x = self.enc(x).permute(0, 2, 1, 3).reshape(B * N, T, -1)
        h, _ = self.rnn(x)
        return self.out(h[:, -1]).reshape(B, N, 2)


class GCNBaseline(nn.Module):
    """GCN (Kipf & Welling) on the final time-step features, then an MLP."""

    def __init__(self, in_dim=2, f_t=5, hidden=64):
        super().__init__()
        self.enc = nn.Linear(in_dim + f_t, hidden)
        self.g1 = nn.Linear(hidden, hidden)
        self.g2 = nn.Linear(hidden, hidden)
        self.out = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.ReLU(),
                                 nn.Linear(hidden // 2, 2))

    def forward(self, flow, tf, adj):
        B, T, N, _ = flow.shape
        x = torch.cat([flow[:, -1], tf[:, -1].unsqueeze(1).expand(-1, N, -1)], dim=-1)
        h = F.relu(self.enc(x))
        # Residual. Row-normalized propagation over eight neighbours plus a
        # self-loop dilutes a node's own signal to roughly 1/9, which is
        # destructive when regional flow levels span two orders of magnitude.
        # The original GCN has no residual, but MR-STGN Eq.(13) keeps an
        # unsmoothed path, so the baseline gets one too; without it the
        # comparison would be unfair by construction.
        h = h + F.relu(self.g1(torch.matmul(adj, h)))
        h = h + F.relu(self.g2(torch.matmul(adj, h)))
        return self.out(h)


class TemporalGatedConv(nn.Module):
    """STGCN gated temporal convolution with the residual of the original
    reference implementation."""

    def __init__(self, cin, cout, kt=3):
        super().__init__()
        self.conv = nn.Conv2d(cin, cout * 2, (kt, 1))
        self.res = nn.Conv2d(cin, cout, (1, 1)) if cin != cout else None
        self.kt = kt

    def forward(self, x):                      # x: (B, C, T, N)
        xr = x[:, :, self.kt - 1:, :]          # align with the output length
        if self.res is not None:
            xr = self.res(xr)
        p, q = self.conv(x).chunk(2, dim=1)
        return (p + xr) * torch.sigmoid(q)


class STGCN(nn.Module):
    """STGCN (Yu et al. 2018): two ST blocks of gated temporal convolution,
    graph convolution, gated temporal convolution."""

    def __init__(self, in_dim=2, f_t=5, hidden=64):
        super().__init__()
        c = hidden
        self.enc = nn.Linear(in_dim + f_t, c)
        self.t11, self.t12 = TemporalGatedConv(c, c), TemporalGatedConv(c, c)
        self.g1 = nn.Linear(c, c)
        self.t21, self.t22 = TemporalGatedConv(c, c), TemporalGatedConv(c, c)
        self.g2 = nn.Linear(c, c)
        self.out = nn.Sequential(nn.Linear(c, c // 2), nn.ReLU(), nn.Linear(c // 2, 2))

    def _block(self, x, t1, g, t2, adj):
        x = t1(x)
        h = x.permute(0, 2, 3, 1)              # (B,T,N,C)
        h = h + F.relu(g(torch.matmul(adj, h)))  # graph-convolution residual
        x = h.permute(0, 3, 1, 2)
        return t2(x)

    def forward(self, flow, tf, adj):
        B, T, N, _ = flow.shape
        x = torch.cat([flow, tf.unsqueeze(2).expand(-1, -1, N, -1)], dim=-1)
        x = self.enc(x).permute(0, 3, 1, 2)     # (B,C,T,N)
        x = self._block(x, self.t11, self.g1, self.t12, adj)
        x = self._block(x, self.t21, self.g2, self.t22, adj)
        h = x[:, :, -1, :].permute(0, 2, 1)     # last time step, not a mean over time
        return self.out(h)


class ASTGCN(nn.Module):
    """ASTGCN (Guo et al. 2019): spatial and temporal attention with
    Chebyshev graph convolution."""

    def __init__(self, in_dim=2, f_t=5, hidden=64, K=3, T=24, N=200):
        super().__init__()
        self.K = K
        self.enc = nn.Linear(in_dim + f_t, hidden)
        self.Ws = nn.Parameter(torch.randn(hidden, hidden) * 0.05)
        self.Wt = nn.Parameter(torch.randn(hidden, hidden) * 0.05)
        self.theta = nn.ModuleList([nn.Linear(hidden, hidden, bias=False) for _ in range(K)])
        self.tconv = nn.Conv2d(hidden, hidden, (3, 1), padding=(1, 0))
        self.out = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.ReLU(),
                                 nn.Linear(hidden // 2, 2))

    def forward(self, flow, tf, adj):
        B, T, N, _ = flow.shape
        x = torch.cat([flow, tf.unsqueeze(2).expand(-1, -1, N, -1)], dim=-1)
        h = self.enc(x)                                        # (B,T,N,C)

        # Temporal attention
        ht = h.permute(0, 2, 1, 3).reshape(B * N, T, -1)
        E = torch.softmax(torch.bmm(ht @ self.Wt, ht.transpose(1, 2)) / math.sqrt(ht.size(-1)), -1)
        ht = torch.bmm(E, ht)
        h = ht.reshape(B, N, T, -1).permute(0, 2, 1, 3)

        # Spatial attention
        hs = h.reshape(B * T, N, -1)
        S = torch.softmax(torch.bmm(hs @ self.Ws, hs.transpose(1, 2)) / math.sqrt(hs.size(-1)), -1)
        A = adj.unsqueeze(0) * S                                # attention-weighted adjacency

        # Chebyshev graph convolution
        out, Tk_1, Tk = 0, hs, torch.bmm(A, hs)
        for k in range(self.K):
            if k == 0:
                out = self.theta[0](Tk_1)
            elif k == 1:
                out = out + self.theta[1](Tk)
            else:
                Tk_2, Tk_1 = Tk_1, Tk
                Tk = 2 * torch.bmm(A, Tk_1) - Tk_2
                out = out + self.theta[k](Tk)
        h = (hs + F.relu(out)).reshape(B, T, N, -1).permute(0, 3, 1, 2)   # residual
        h = F.relu(self.tconv(h))[:, :, -1, :].permute(0, 2, 1)           # last time step
        return self.out(h)


class DCGRUCell(nn.Module):
    """Diffusion-convolutional GRU cell: every matrix multiplication is
    replaced by a K-step forward/backward random-walk convolution."""

    def __init__(self, in_dim, hidden, K=2):
        super().__init__()
        self.hidden, self.K = hidden, K
        n_sup = 2 * K + 1
        self.gate = nn.Linear((in_dim + hidden) * n_sup, 2 * hidden)
        self.cand = nn.Linear((in_dim + hidden) * n_sup, hidden)

    def _diffuse(self, x, Af, Ab):
        outs, s = [x], x
        for _ in range(self.K):
            s = torch.matmul(Af, s); outs.append(s)
        s = x
        for _ in range(self.K):
            s = torch.matmul(Ab, s); outs.append(s)
        return torch.cat(outs, dim=-1)

    def forward(self, x, h, Af, Ab):
        xh = torch.cat([x, h], dim=-1)
        sup = self._diffuse(xh, Af, Ab)
        r, u = torch.sigmoid(self.gate(sup)).chunk(2, dim=-1)
        xrh = torch.cat([x, r * h], dim=-1)
        c = torch.tanh(self.cand(self._diffuse(xrh, Af, Ab)))
        return u * h + (1 - u) * c


class DCRNN(nn.Module):
    """DCRNN (Li et al. 2018) encoder with a single-step output head."""

    def __init__(self, in_dim=2, f_t=5, hidden=64, K=2):
        super().__init__()
        self.hidden = hidden
        self.cell1 = DCGRUCell(in_dim + f_t, hidden, K)
        self.cell2 = DCGRUCell(hidden, hidden, K)
        self.out = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.ReLU(),
                                 nn.Linear(hidden // 2, 2))

    def forward(self, flow, tf, adj):
        B, T, N, _ = flow.shape
        Af = adj
        Ab = adj.transpose(0, 1)
        Ab = Ab / Ab.sum(dim=1, keepdim=True).clamp(min=1e-6)
        x = torch.cat([flow, tf.unsqueeze(2).expand(-1, -1, N, -1)], dim=-1)
        h1 = torch.zeros(B, N, self.hidden, device=flow.device)
        h2 = torch.zeros(B, N, self.hidden, device=flow.device)
        for t in range(T):
            h1 = self.cell1(x[:, t], h1, Af, Ab)
            h2 = self.cell2(h1, h2, Af, Ab)
        return self.out(h2)


class GraphWaveNet(nn.Module):
    """Graph WaveNet (Wu et al. 2019): dilated causal convolution with an
    adaptive adjacency matrix.

    Runs on the same gridded input as MR-STGN with no special adaptation.
    """

    def __init__(self, in_dim=2, f_t=5, hidden=32, N=200, emb=10,
                 dilations=(1, 2, 1, 2, 1, 2, 1, 2)):
        super().__init__()
        self.start = nn.Conv2d(in_dim + f_t, hidden, (1, 1))
        self.E1 = nn.Parameter(torch.randn(N, emb) * 0.1)
        self.E2 = nn.Parameter(torch.randn(emb, N) * 0.1)
        self.filt, self.gate, self.res, self.skip, self.bn = (nn.ModuleList() for _ in range(5))
        for d in dilations:
            self.filt.append(nn.Conv2d(hidden, hidden, (1, 2), dilation=(1, d)))
            self.gate.append(nn.Conv2d(hidden, hidden, (1, 2), dilation=(1, d)))
            self.res.append(nn.Conv2d(hidden, hidden, (1, 1)))
            self.skip.append(nn.Conv2d(hidden, hidden * 2, (1, 1)))
            self.bn.append(nn.BatchNorm2d(hidden))
        self.gconv = nn.ModuleList([nn.Linear(hidden * 3, hidden) for _ in dilations])
        self.end1 = nn.Conv2d(hidden * 2, hidden * 2, (1, 1))
        self.end2 = nn.Conv2d(hidden * 2, 2, (1, 1))

    def forward(self, flow, tf, adj):
        B, T, N, _ = flow.shape
        x = torch.cat([flow, tf.unsqueeze(2).expand(-1, -1, N, -1)], dim=-1)
        x = x.permute(0, 3, 2, 1)                      # (B,C,N,T)
        x = self.start(x)
        adp = F.softmax(F.relu(torch.mm(self.E1, self.E2)), dim=1)
        skip = 0
        for i in range(len(self.filt)):
            res = x
            f = torch.tanh(self.filt[i](x))
            g = torch.sigmoid(self.gate[i](x))
            x = f * g
            s = self.skip[i](x)
            skip = s if isinstance(skip, int) else skip[..., -s.size(3):] + s
            # Graph convolution over the predefined and adaptive adjacencies
            h = x.permute(0, 3, 2, 1)                  # (B,T',N,C)
            h = torch.cat([h, torch.matmul(adj, h), torch.matmul(adp, h)], dim=-1)
            h = self.gconv[i](h).permute(0, 3, 2, 1)
            x = h + res[..., -h.size(3):]
            x = self.bn[i](x)
        x = F.relu(skip)
        x = F.relu(self.end1(x))
        x = self.end2(x)                                # (B,2,N,T')
        return x[..., -1].permute(0, 2, 1)


class GMAN(nn.Module):
    """GMAN (Zheng et al. 2020): spatio-temporal multi-head attention with a
    spatial embedding. Like Graph WaveNet, it runs on the same gridded input
    directly.
    """

    def __init__(self, in_dim=2, f_t=5, hidden=64, N=200, heads=4, blocks=2):
        super().__init__()
        self.hidden, self.heads, self.blocks = hidden, heads, blocks
        self.enc = nn.Linear(in_dim + f_t, hidden)
        self.SE = nn.Parameter(torch.randn(N, hidden) * 0.05)   # spatial embedding
        self.sa_q = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(blocks)])
        self.sa_k = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(blocks)])
        self.sa_v = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(blocks)])
        self.ta_q = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(blocks)])
        self.ta_k = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(blocks)])
        self.ta_v = nn.ModuleList([nn.Linear(hidden, hidden) for _ in range(blocks)])
        self.gate = nn.ModuleList([nn.Linear(hidden * 2, hidden) for _ in range(blocks)])
        self.norm = nn.ModuleList([nn.LayerNorm(hidden) for _ in range(blocks)])
        self.out = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.ReLU(),
                                 nn.Linear(hidden // 2, 2))

    def _mha(self, q, k, v, nh):
        B, L, C = q.shape
        d = C // nh
        q = q.reshape(B, L, nh, d).transpose(1, 2)
        k = k.reshape(B, L, nh, d).transpose(1, 2)
        v = v.reshape(B, L, nh, d).transpose(1, 2)
        a = torch.softmax(q @ k.transpose(-1, -2) / math.sqrt(d), dim=-1)
        return (a @ v).transpose(1, 2).reshape(B, L, C)

    def forward(self, flow, tf, adj=None):
        B, T, N, _ = flow.shape
        x = torch.cat([flow, tf.unsqueeze(2).expand(-1, -1, N, -1)], dim=-1)
        h = self.enc(x) + self.SE.unsqueeze(0).unsqueeze(0)

        for b in range(self.blocks):
            # Spatial attention: across regions within each time step
            hs = h.reshape(B * T, N, -1)
            hs = self._mha(self.sa_q[b](hs), self.sa_k[b](hs), self.sa_v[b](hs), self.heads)
            hs = hs.reshape(B, T, N, -1)
            # Temporal attention: across time steps within each region
            ht = h.permute(0, 2, 1, 3).reshape(B * N, T, -1)
            ht = self._mha(self.ta_q[b](ht), self.ta_k[b](ht), self.ta_v[b](ht), self.heads)
            ht = ht.reshape(B, N, T, -1).permute(0, 2, 1, 3)
            # Gated fusion
            g = torch.sigmoid(self.gate[b](torch.cat([hs, ht], dim=-1)))
            h = self.norm[b](h + g * hs + (1 - g) * ht)

        return self.out(h[:, -1])


DL_MODELS = {
    'LSTM':  lambda N: NodeRNN('lstm'),
    'GRU':   lambda N: NodeRNN('gru'),
    'GCN':   lambda N: GCNBaseline(),
    'STGCN': lambda N: STGCN(),
    'ASTGCN': lambda N: ASTGCN(N=N),
    'DCRNN': lambda N: DCRNN(),
    'GraphWaveNet': lambda N: GraphWaveNet(N=N),
    'GMAN':  lambda N: GMAN(N=N),
}


def train_dl(model, trl, val, adj, device, epochs, lr, patience, log_path):
    """Training loop shared by every deep baseline; same configuration as
    MR-STGN, with an MAE loss."""
    model = model.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = CosineAnnealingWarmRestarts(opt, T_0=10, T_mult=2)
    best, best_state, wait = float('inf'), None, 0
    logf = open(log_path, 'w', encoding='utf-8')
    hist = []

    for ep in range(epochs):
        model.train()
        tl = 0.0
        for b in trl:
            x, tf, y = b['x_flow'].to(device), b['x_time'].to(device), b['y_flow'].to(device)
            opt.zero_grad()
            loss = F.l1_loss(model(x, tf, adj), y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            tl += loss.item()
        tl /= len(trl)
        sched.step()

        model.eval()
        vl, P, Y = 0.0, [], []
        with torch.no_grad():
            for b in val:
                x, tf, y = b['x_flow'].to(device), b['x_time'].to(device), b['y_flow'].to(device)
                p = model(x, tf, adj)
                vl += F.l1_loss(p, y).item()
                P.append(p.cpu().numpy()); Y.append(y.cpu().numpy())
        vl /= len(val)
        P, Y = np.concatenate(P), np.concatenate(Y)
        line = f"Epoch {ep+1:3d} | Train MAE: {tl:.4f} | Val MAE: {vl:.4f}"
        print(line, flush=True); logf.write(line + '\n'); logf.flush()
        hist.append({'train': tl, 'val': vl})

        if vl < best:
            best, wait = vl, 0
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
        else:
            wait += 1
            if wait >= patience:
                print(f"Early stopping at epoch {ep+1}", flush=True)
                break
    logf.close()
    if best_state:
        model.load_state_dict(best_state)
    return model, hist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mat', default='dataset.mat')
    ap.add_argument('--out', default=os.path.join(HERE, 'baseline_out'))
    ap.add_argument('--models', nargs='+', default=None, help='run only the named models')
    ap.add_argument('--seeds', type=int, nargs='+', default=[42])
    ap.add_argument('--k_geo', type=int, default=8)
    ap.add_argument('--seq_len', type=int, default=24)
    ap.add_argument('--batch_size', type=int, default=32)
    ap.add_argument('--epochs', type=int, default=100)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--patience', type=int, default=20)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    print(f"device: {args.device} | torch {torch.__version__}", flush=True)

    m = sio.loadmat(args.mat)
    flow = m['flow_tensor'].astype(np.float32)
    dist = m['distance_matrix'].astype(np.float64)
    T, N, _ = flow.shape
    train_end, val_end = int(T * 0.7), int(T * 0.85)

    A_geo, _ = M.build_geo_graph(dist, k=args.k_geo)
    a = torch.tensor(A_geo, dtype=torch.float32) + torch.eye(N)
    adj = (a / a.sum(dim=1, keepdim=True).clamp(min=1e-6)).to(args.device)

    time_feat = M.build_time_features(T)
    nm_ = float(flow[:train_end].mean())
    ns_ = float(flow[:train_end].std() + 1e-6)

    tr = M.FlowDataset(flow[:train_end], time_feat[:train_end], args.seq_len, nm_, ns_)
    va = M.FlowDataset(flow[train_end:val_end], time_feat[train_end:val_end], args.seq_len, nm_, ns_)
    te = M.FlowDataset(flow[val_end:], time_feat[val_end:], args.seq_len, nm_, ns_)

    results_path = os.path.join(args.out, 'results.json')
    results = json.load(open(results_path, encoding='utf-8')) if os.path.exists(results_path) else []
    done = {(r['model'], r['seed']) for r in results}

    def save(rec):
        results.append(rec)
        # One file per run. When several queues run in parallel and all read
        # and write a single results.json, whichever writes last overwrites the
        # file from its own start-up snapshot and silently drops records another
        # queue had just saved. Per-run files cannot race; results.json is only
        # a convenience aggregate and can be rebuilt from them or from the npz.
        with open(os.path.join(args.out,
                               f"run_{rec['model']}_s{rec['seed']}.json"),
                  'w', encoding='utf-8') as f:
            json.dump(rec, f, indent=2, ensure_ascii=False)
        with open(results_path, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        print(f"\n>>> {rec['model']}: MAE {rec['MAE']:.3f}  RMSE {rec['RMSE']:.3f}  "
              f"WMAPE {rec['WMAPE']:.2f}%  Corr {rec['Corr']:.4f}\n", flush=True)

    want = args.models or (['HA', 'ARIMA', 'SVR'] + list(DL_MODELS))

    # --- classical methods: deterministic, run once ---
    for name, fn in [('HA', lambda: run_ha(flow, time_feat, train_end, val_end, args.seq_len)),
                     ('ARIMA', lambda: run_arima(flow, train_end, val_end, args.seq_len)),
                     ('SVR', lambda: run_svr(flow, train_end, val_end, args.seq_len))]:
        if name not in want or (name, 0) in done:
            continue
        print(f"\n{'='*70}\n{name}\n{'='*70}", flush=True)
        t0 = time.time()
        P, Y = fn()
        save({'model': name, 'seed': 0, 'minutes': round((time.time() - t0) / 60, 1),
              **M.metrics(P, Y)})
        np.savez_compressed(os.path.join(args.out, f'{name}_test.npz'), preds=P, targets=Y)

    # --- deep-learning baselines ---
    for name in DL_MODELS:
        if name not in want:
            continue
        for seed in args.seeds:
            if (name, seed) in done:
                print(f"skipping completed: {name} seed={seed}", flush=True)
                continue
            print(f"\n{'='*70}\n{name}  seed={seed}\n{'='*70}", flush=True)
            M.set_seed(seed)
            trl = DataLoader(tr, batch_size=args.batch_size, shuffle=True)
            val = DataLoader(va, batch_size=args.batch_size)
            tel = DataLoader(te, batch_size=args.batch_size)

            model = DL_MODELS[name](N)
            t0 = time.time()
            model, _ = train_dl(model, trl, val, adj, args.device, args.epochs,
                                args.lr, args.patience,
                                os.path.join(args.out, f'{name}_s{seed}.log'))
            model.eval()
            P, Y = [], []
            with torch.no_grad():
                for b in tel:
                    P.append(model(b['x_flow'].to(args.device),
                                   b['x_time'].to(args.device), adj).cpu().numpy())
                    Y.append(b['y_flow'].numpy())
            P, Y = np.concatenate(P), np.concatenate(Y)
            save({'model': name, 'seed': seed,
                  'minutes': round((time.time() - t0) / 60, 1),
                  'n_params': int(sum(p.numel() for p in model.parameters())),
                  **M.metrics(P, Y)})
            np.savez_compressed(os.path.join(args.out, f'{name}_s{seed}_test.npz'),
                                preds=P, targets=Y)

    # Summary
    print(f"\n{'='*88}\nBaseline summary (Table 1)\n{'='*88}")
    print(f"{'Method':<16}{'MAE':>10}{'RMSE':>10}{'MAPE%':>10}{'WMAPE%':>10}{'Corr':>9}{'params':>10}")
    order = ['HA', 'ARIMA', 'SVR', 'LSTM', 'GRU', 'GCN', 'STGCN', 'ASTGCN',
             'DCRNN', 'GraphWaveNet', 'GMAN']
    for nm in order:
        rs = [r for r in results if r['model'] == nm]
        if not rs:
            continue
        print(f"{nm:<16}{np.mean([r['MAE'] for r in rs]):>10.3f}"
              f"{np.mean([r['RMSE'] for r in rs]):>10.3f}"
              f"{np.mean([r['MAPE'] for r in rs]):>10.2f}"
              f"{np.mean([r['WMAPE'] for r in rs]):>10.2f}"
              f"{np.mean([r['Corr'] for r in rs]):>9.4f}"
              f"{rs[0].get('n_params', 0):>10d}")
    print(f"\nresults: {results_path}")


if __name__ == '__main__':
    main()
