#!/usr/bin/env python3
"""
Regenerate the manuscript figures from the saved prediction and result files.

Output goes to the paper/ directory under the filenames the .tex refers to, so
rebuilding the manuscript afterwards picks the new figures up.

Not regenerated here: fig2_architecture.jpg, which is drawn by hand.
fig11_crosscity.png is supplementary and is not used by the manuscript.
"""

import os
import json
import argparse

from datetime import datetime, timedelta
import numpy as np
import scipy.io as sio
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
from matplotlib.ticker import MaxNLocator

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
OUT = os.path.join(PROJ, 'paper')

plt.rcParams.update({
    'font.family': 'DejaVu Sans', 'font.size': 9,
    'axes.labelsize': 9, 'axes.titlesize': 9.5,
    'xtick.labelsize': 8, 'ytick.labelsize': 8,
    'legend.fontsize': 8, 'axes.grid': True,
    'grid.alpha': 0.25, 'grid.linewidth': 0.5,
    'axes.spines.top': False, 'axes.spines.right': False,
    'figure.dpi': 160, 'savefig.dpi': 300, 'savefig.bbox': 'tight',
})
C = {'geo': '#3B6EA5', 'flow': '#C0504D', 'sim': '#4E9A51',
     'main': '#1F3B57', 'alt': '#C77C2B', 'grey': '#8A8F94'}

# Text width of a single-column A4 page with 1-inch margins. LaTeX scales
# every figure down to this width, so font sizes inside the figure have to be
# scaled up by the same factor first, otherwise they end up at 4-5 pt on paper.
TEXT_WIDTH_IN = 6.27
_BASE = {'font.size': 9, 'axes.labelsize': 9, 'axes.titlesize': 9.5,
         'xtick.labelsize': 8, 'ytick.labelsize': 8, 'legend.fontsize': 8}


def scale_fonts(fig_width_in, latex_frac=0.96):
    """Scale in-figure fonts by the LaTeX reduction factor, so the effective
    size on the printed page comes back to _BASE."""
    k = fig_width_in / (TEXT_WIDTH_IN * latex_frac)
    plt.rcParams.update({key: v * k for key, v in _BASE.items()})
    plt.rcParams.update({'lines.linewidth': 1.5 * k, 'lines.markersize': 4 * k,
                         'axes.linewidth': 0.8 * k, 'grid.linewidth': 0.5 * k,
                         'xtick.major.width': 0.8 * k, 'ytick.major.width': 0.8 * k})
    return k


def load(p, default=None):
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else default


# ------------------------------------------------------------ dataset overview
def fig_dataset(mat, start_date='2021-04-01'):
    """Figure 1. Six views of the primary dataset, all derived from the flow
    tensor so that a reader with the tensor can regenerate the figure.

    Day of week is taken from the real calendar. Deriving it as t // 24 % 7
    assumes the study window opens on a Monday; this one opens on a Thursday,
    and the resulting three-day shift swaps weekdays into the weekend curve.
    """
    F = mat['flow_tensor']
    centers = mat['grid_centers']
    T = F.shape[0]
    lat, lng = centers[:, 0], centers[:, 1]
    hrs = np.arange(T) % 24
    day = np.arange(T) // 24

    node_total = F.sum(axis=(0, 2))
    hourly = np.array([F[hrs == h].sum() for h in range(24)])
    daily = F.reshape(T // 24, 24, F.shape[1], 2).sum(axis=(1, 2, 3))

    base = datetime.strptime(start_date, '%Y-%m-%d').date()
    dow = np.array([(base + timedelta(days=int(d))).weekday() for d in day])
    is_we = dow >= 5
    wd = np.array([F[(hrs == h) & ~is_we].sum() / ((hrs == h) & ~is_we).sum()
                   for h in range(24)])
    we = np.array([F[(hrs == h) & is_we].sum() / ((hrs == h) & is_we).sum()
                   for h in range(24)])

    scale_fonts(13.2, 0.92)
    fig, axes = plt.subplots(2, 3, figsize=(13.2, 7.2))
    ax = axes.ravel()

    sc = ax[0].scatter(lng, lat, c=node_total, s=18, cmap='hot_r', linewidths=0)
    ax[0].set_title('(a) Study area, total flow')
    ax[0].set_xlabel('Longitude'); ax[0].set_ylabel('Latitude')
    fig.colorbar(sc, ax=ax[0], shrink=0.85)

    peak = [(7 <= h <= 9) or (17 <= h <= 19) for h in range(24)]
    ax[1].bar(range(24), hourly,
              color=[C['alt'] if p else C['geo'] for p in peak], width=0.8)
    ax[1].set_title('(b) Flow by hour of day')
    ax[1].set_xlabel('Hour'); ax[1].set_ylabel('Total flow')

    ax[2].hist(node_total, bins=30, color=C['sim'], alpha=0.75)
    ax[2].axvline(node_total.mean(), color=C['flow'], ls='--', lw=1.4,
                  label='Mean %.0f' % node_total.mean())
    ax[2].set_title('(c) Flow per region')
    ax[2].set_xlabel('Total flow'); ax[2].set_ylabel('Regions')
    ax[2].set_ylim(0, ax[2].get_ylim()[1] * 1.45)
    ax[2].legend(frameon=False, loc='upper right')

    ax[3].plot(np.arange(1, len(daily) + 1), daily, lw=1.1, color=C['main'])
    ax[3].set_title('(d) Daily total, %d days' % len(daily))
    ax[3].set_xlabel('Day'); ax[3].set_ylabel('Daily flow')

    ax[4].plot(range(24), wd, 'o-', ms=3.5, lw=1.4, color=C['geo'],
               label='Weekday')
    ax[4].plot(range(24), we, 's--', ms=3.5, lw=1.4, color=C['flow'],
               label='Weekend')
    ax[4].set_title('(e) Weekday vs. weekend')
    ax[4].set_xlabel('Hour'); ax[4].set_ylabel('Mean hourly flow')
    ax[4].ticklabel_format(axis='y', style='sci', scilimits=(0, 0))
    ax[4].set_ylim(0, max(wd.max(), we.max()) * 1.3)
    ax[4].legend(frameon=False, loc='upper left')

    sc = ax[5].scatter(lng, lat, c=np.log10(np.maximum(node_total, 1)), s=18,
                       cmap='viridis', linewidths=0)
    ax[5].set_title('(f) Study area, $\\log_{10}$ flow')
    ax[5].set_xlabel('Longitude'); ax[5].set_ylabel('Latitude')
    fig.colorbar(sc, ax=ax[5], shrink=0.85)

    fig.tight_layout(pad=1.4, w_pad=2.0, h_pad=1.6)
    fig.savefig(os.path.join(OUT, 'fig1_dataset.png'))
    plt.close(fig)

# ------------------------------------------------------------ the three relational graphs
def fig_graphs(sz):
    A = np.load(os.path.join(HERE, 'out_paper', 'graphs.npz'))
    scale_fonts(13, 0.98)
    # Four across one row, matching the other multi-panel figures.
    fig, ax = plt.subplots(1, 4, figsize=(13, 3.9))
    for k, (key, name, col) in enumerate([('A_geo', r'(a) $\mathcal{G}_{geo}$', C['geo']),
                                          ('A_flow', r'(b) $\mathcal{G}_{flow}$', C['flow']),
                                          ('A_sim', r'(c) $\mathcal{G}_{sim}$', C['sim'])]):
        M = A[key]
        # Drawn as an image, not a scatter. A marker big enough to see at
        # this panel size is wider than one matrix cell, which inflates
        # apparent density and, once dense regions saturate, flattens the
        # contrast between the three graphs. One cell per pixel block is
        # faithful by construction.
        cmap = mcolors.ListedColormap(['white', col])
        ax[k].imshow((M > 0).astype(np.uint8), cmap=cmap, vmin=0, vmax=1,
                     interpolation='nearest', aspect='equal',
                     extent=[0, M.shape[0], M.shape[0], 0])
        ax[k].grid(False)
        e = int((M > 0).sum())
        # The counts go above the axes rather than in a box inside them,
        # which at this panel size sits on the matrix itself. A second
        # title line at full size does not fit across a quarter of the
        # text width, so it is set separately and smaller.
        ax[k].set_title(name)
        ax[k].set_xlabel('Region $j$')
        if k == 0:
            ax[k].set_ylabel('Region $i$')
        ax[k].set_aspect('equal')
    # The geographic and flow graphs give every node the same out-degree
    # by construction, so their "distributions" are single spikes. Filled
    # bars render those as invisible hairlines beside the spread-out
    # similarity graph; outlines keep all three legible on one axis.
    degs = {n: (A[k] > 0).sum(1) for k, n in
            [('A_geo', 'Geo'), ('A_flow', 'Flow'), ('A_sim', 'Sim')]}
    bins = np.arange(0, max(d.max() for d in degs.values()) + 3, 2)
    for name, col, fill in [('Geo', C['geo'], False),
                            ('Flow', C['flow'], False),
                            ('Sim', C['sim'], True)]:
        ax[3].hist(degs[name], bins=bins, label=name, color=col,
                   histtype='stepfilled' if fill else 'step',
                   alpha=0.55 if fill else 1.0, lw=1.6)
    ax[3].set_title('(d) Out-degree')
    ax[3].set_xlabel('Out-degree'); ax[3].set_ylabel('Regions')
    ax[3].set_ylim(0, ax[3].get_ylim()[1] * 1.5)   # a band for the legend
    ax[3].legend(frameon=False, loc='upper right', handlelength=0.9,
                 handletextpad=0.4, borderpad=0.15, labelspacing=0.25,
                 fontsize=plt.rcParams['font.size'] * 0.85)
    fig.tight_layout(pad=1.4, w_pad=2.0)
    fig.savefig(os.path.join(OUT, 'fig_graph_structures.png')); plt.close(fig)


# ------------------------------------------------------------ prediction vs truth
def fig_scatter(d):
    P, Y = d['preds'].ravel(), d['targets'].ravel()
    r2 = 1 - ((P - Y) ** 2).sum() / ((Y - Y.mean()) ** 2).sum()
    scale_fonts(4.6, 0.62)
    fig, ax = plt.subplots(figsize=(4.6, 4.4))
    ax.scatter(Y, P, s=1.1, alpha=0.16, color=C['main'], linewidths=0)
    m = max(Y.max(), P.max()) * 1.02
    ax.plot([0, m], [0, m], '--', lw=1.1, color=C['flow'])
    ax.set_xlim(0, m); ax.set_ylim(0, m)
    ax.set_xlabel('True flow (trips/hour)'); ax.set_ylabel('Predicted flow (trips/hour)')
    ax.set_title(f'Prediction vs. ground truth ($R^2$ = {r2:.3f})')
    ax.set_aspect('equal')
    fig.tight_layout(pad=1.4)
    fig.savefig(os.path.join(OUT, 'fig3_scatter.png')); plt.close(fig)


# ------------------------------------------------------------ spatial distribution
def fig_spatial(d, centers):
    P, Y = d['preds'], d['targets']
    t = int(np.argmax(Y[:, :, 0].sum(1)))       # peak system-wide hour
    lat, lng = centers[:, 0], centers[:, 1]
    node_mae = np.abs(P - Y).mean(axis=(0, 2))
    vmax_out = float(max(Y[t, :, 0].max(), P[t, :, 0].max()))
    vmax_in = float(max(Y[t, :, 1].max(), P[t, :, 1].max()))
    # (a)/(b) and (d)/(e) share a colour scale within each pair, otherwise
    # truth and prediction cannot be compared by eye
    panels = [(Y[t, :, 0], '(a) True outflow', 'hot_r', 0, vmax_out),
              (P[t, :, 0], '(b) Predicted outflow', 'hot_r', 0, vmax_out),
              (np.abs(P[t, :, 0] - Y[t, :, 0]), '(c) Outflow abs. error', 'hot_r', None, None),
              (Y[t, :, 1], '(d) True inflow', 'cool', 0, vmax_in),
              (P[t, :, 1], '(e) Predicted inflow', 'cool', 0, vmax_in),
              (node_mae, '(f) Test-set node MAE', 'hot_r', None, None)]
    scale_fonts(13.2, 0.96)
    fig, axes = plt.subplots(2, 3, figsize=(13.2, 7.6))
    for ax, (v, title, cm, lo, hi) in zip(axes.ravel(), panels):
        sc = ax.scatter(lng, lat, c=v, s=17, cmap=cm, linewidths=0, vmin=lo, vmax=hi)
        ax.set_title(title); ax.set_xlabel('Longitude'); ax.set_ylabel('Latitude')
        fig.colorbar(sc, ax=ax, shrink=0.85)
    fig.tight_layout(pad=1.4, w_pad=2.0, h_pad=1.6)
    fig.savefig(os.path.join(OUT, 'fig4_spatial.png')); plt.close(fig)


# ------------------------------------------------------------ time series
def fig_timeseries(d):
    P, Y = d['preds'], d['targets']
    tot = Y[:, :, 0].sum(0)
    order = np.argsort(-tot)
    picks = [order[0], order[1], order[len(order)//2], order[-30], order[-1]]
    labels = ['most active', 'high activity', 'medium activity', 'low activity', 'least active']
    H = 336                      # first two weeks only; all 526 hours is unreadable
    scale_fonts(12.4, 0.96)
    fig, axes = plt.subplots(3, 2, figsize=(12.4, 9.6))
    axes = axes.ravel()
    for k, (ax, n, lab) in enumerate(zip(axes, picks, labels)):
        mae = np.abs(P[:, n, 0] - Y[:, n, 0]).mean()
        ax.plot(Y[:H, n, 0], lw=0.9, color=C['main'], label='True')
        ax.plot(P[:H, n, 0], lw=0.9, ls='--', color=C['flow'], label='Predicted')
        ax.set_title(f'({chr(97+k)}) Node {n}, {lab} (MAE {mae:.2f})')
        ax.set_xlabel('Hour'); ax.set_ylabel('Outflow')
        ax.margins(x=0)
    n = picks[0]
    mae = np.abs(P[:, n, 1] - Y[:, n, 1]).mean()
    axes[5].plot(Y[:H, n, 1], lw=0.9, color=C['main'], label='True')
    axes[5].plot(P[:H, n, 1], lw=0.9, ls='--', color=C['flow'], label='Predicted')
    axes[5].set_title(f'(f) Node {n}, inflow channel (MAE {mae:.2f})')
    axes[5].set_xlabel('Hour'); axes[5].set_ylabel('Inflow'); axes[5].margins(x=0)
    h, l = axes[0].get_legend_handles_labels()
    fig.legend(h, l, loc='upper center', ncol=2, frameon=False,
               bbox_to_anchor=(0.5, 1.005))
    fig.tight_layout(pad=1.4, w_pad=2.0, h_pad=1.8, rect=(0, 0, 1, 0.965))
    fig.savefig(os.path.join(OUT, 'fig5_timeseries.png')); plt.close(fig)


# ------------------------------------------------------------ parameter sensitivity
def fig_sensitivity(sweep):
    groups = [('k_geo', r'(a) Neighbours $\kappa$', C['geo']),
              ('K_f', r'(b) Top-$K_f$', C['flow']),
              ('delta_s', r'(c) Threshold $\delta_s$', C['sim'])]
    scale_fonts(12.4, 0.96)
    fig, axes = plt.subplots(1, 3, figsize=(12.4, 3.5))
    for ax, (key, title, col) in zip(axes, groups):
        rs = sorted([r for r in sweep if r.get('swept') == key], key=lambda r: r[key])
        if not rs:
            continue
        if key == 'K_f':
            # Once K_f exceeds the number of outgoing edges the OD
            # matrix actually offers, the top-K step stops binding and
            # the graph stops changing. Those runs are duplicates of the
            # last distinct one, not further measurements, so plotting
            # them would draw a flat segment that looks like a result.
            seen, keep = set(), []
            for r in rs:
                d = round(r['density_pct']['flow'], 6)
                if d not in seen:
                    seen.add(d); keep.append(r)
            rs = keep
        x = [r[key] for r in rs]; y = [r['MAE'] for r in rs]
        ax.plot(x, y, 'o-', color=col, lw=1.5, ms=5)
        ax.set_title(title); ax.set_ylabel('MAE'); ax.set_ylim(11.0, 11.9)
        ax.set_xlabel({'k_geo': r'$\kappa$', 'K_f': r'$K_f$', 'delta_s': r'$\delta_s$'}[key])
        if key == 'delta_s':
            ax2 = ax.twinx(); ax2.grid(False)
            ax2.plot(x, [r['density_pct']['sim'] for r in rs], 's--',
                     color=C['grey'], lw=1.1, ms=4)
            ax2.set_ylabel('Similarity graph density (%)', color=C['grey'])
            ax2.tick_params(axis='y', colors=C['grey'])
    fig.tight_layout(pad=1.4, w_pad=2.0, h_pad=1.6)
    # Default JPEG quality is 75, which tells on thin lines and small text.
    fig.savefig(os.path.join(OUT, 'fig6_sensitivity.jpg'),
                pil_kwargs={'quality': 94})
    plt.close(fig)


# ------------------------------------------------------------ relational attention
def fig_attention(sz, ch, sh=None):
    cities = [(sz, 'Shenzhen'), (sh, 'Shanghai'), (ch, 'Chicago')]
    cities = [(d, c) for d, c in cities if d is not None]
    n = len(cities) + 1
    scale_fonts(3.3 * n, 0.96)
    fig, axes = plt.subplots(1, n, figsize=(3.3 * n, 3.6))
    for k, (ax, (d, city)) in enumerate(zip(axes[:len(cities)], cities)):
        a = d['attn']
        means = [a[..., i].mean() for i in range(3)]
        ax.bar(range(3), means, color=[C['geo'], C['flow'], C['sim']], width=0.6)
        # Bar labels have to scale with scale_fonts too, or they become
        # illegible once the figure is reduced to page width.
        for i, v in enumerate(means):
            ax.text(i, v + max(means) * 0.035, f'{v:.3f}', ha='center',
                    fontsize=plt.rcParams['font.size'] * 0.95)
        # Short labels, unrotated: rotating them makes the leftmost one
        # collide with the y-axis title. The full names appear in the legend
        # of panel (c), so there is no ambiguity.
        ax.set_xticks(range(3))
        ax.set_xticklabels(['Geo.', 'Flow', 'Sim.'])
        ax.set_ylim(0, max(means) * 1.34); ax.set_ylabel('Mean attention weight')
        ax.set_title(f'({chr(97+k)}) {city}')
    a = sz['attn']
    ax = axes[len(cities)]
    for i, (nm, col) in enumerate([('Geographic', C['geo']), ('Flow', C['flow']),
                                   ('Similarity', C['sim'])]):
        ax.hist(a[..., i].mean(axis=0), bins=30, alpha=0.55, label=nm, color=col)
    ax.set_title(f'({chr(97+len(cities))}) Per-region (Shenzhen)')
    ax.set_xlabel('Attention weight'); ax.set_ylabel('Regions')
    # The three distributions peak at different weights, so a legend inside the
    # axes lands on bars wherever it is put. Give it a band of its own above
    # the tallest bar instead.
    ax.set_ylim(0, ax.get_ylim()[1] * 1.95)
    ax.legend(frameon=False, loc='upper center', ncol=1,
              fontsize=plt.rcParams['font.size'] * 0.85,
              handlelength=1.1, handletextpad=0.5, borderpad=0.2,
              labelspacing=0.3)
    fig.tight_layout(pad=1.4, w_pad=2.0, h_pad=1.6)
    # Default JPEG quality is 75, which tells on thin lines and small text.
    fig.savefig(os.path.join(OUT, 'fig7_attention.jpg'),
                pil_kwargs={'quality': 94})
    plt.close(fig)


# ------------------------------------------------------------ error distribution
def fig_error(d):
    P, Y = d['preds'], d['targets']
    err = np.abs(P - Y)
    scale_fonts(12.4, 0.96)
    fig, axes = plt.subplots(1, 3, figsize=(12.4, 4.2))
    bins = [0, 10, 30, 50, 100, 200, 1e9]
    lab = ['0-10', '10-30', '30-50', '50-100', '100-200', '>200']
    mae_b, wm_b = [], []
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (Y >= lo) & (Y < hi)
        mae_b.append(err[m].mean() if m.any() else 0)
        wm_b.append(err[m].sum() / max(Y[m].sum(), 1e-9) * 100 if m.any() else 0)
    axes[0].bar(lab, mae_b, color=C['main'], width=0.65)
    axes[0].set_title('(a) MAE by flow level'); axes[0].set_ylabel('MAE')
    axes[0].set_xlabel('True flow (trips/hour)')
    axes[0].tick_params(axis='x', rotation=35)
    axes[1].bar(lab, wm_b, color=C['alt'], width=0.65)
    axes[1].set_title('(b) WMAPE by flow level')
    axes[1].set_ylabel('WMAPE (%)'); axes[1].set_xlabel('True flow (trips/hour)')
    axes[1].tick_params(axis='x', rotation=35)
    hr = np.arange(len(Y)) % 24
    hm = [err[hr == h].mean() for h in range(24)]
    cols = [C['flow'] if (7 <= h <= 9 or 17 <= h <= 19) else C['main'] for h in range(24)]
    axes[2].bar(range(24), hm, color=cols, width=0.75)
    axes[2].set_title('(c) MAE by hour (red: peaks)')
    axes[2].set_xlabel('Hour of day'); axes[2].set_ylabel('MAE')
    axes[2].xaxis.set_major_locator(MaxNLocator(integer=True))
    fig.tight_layout(pad=1.4, w_pad=2.0, h_pad=1.6)
    # Default JPEG quality is 75, which tells on thin lines and small text.
    fig.savefig(os.path.join(OUT, 'fig8_error.jpg'),
                pil_kwargs={'quality': 94})
    plt.close(fig)


# ------------------------------------------------------------ uncertainty and calibration
def fig_uncertainty(d):
    P, Y, V = d['preds'], d['targets'], d['vars']
    sd = np.sqrt(np.maximum(V, 0))
    tot = Y[:, :, 0].sum(0); order = np.argsort(-tot)
    scale_fonts(12.6, 0.96)
    fig, axes = plt.subplots(1, 3, figsize=(12.6, 3.9))
    for ax, n, lab in [(axes[0], order[0], 'High-activity node'),
                       (axes[1], order[-1], 'Low-activity node')]:
        h = slice(0, 168)
        ax.fill_between(range(168), (P[h, n, 0] - 1.96 * sd[h, n, 0]),
                        (P[h, n, 0] + 1.96 * sd[h, n, 0]),
                        color=C['geo'], alpha=0.22, label='95% interval')
        ax.plot(Y[h, n, 0], lw=1.0, color=C['main'], label='True')
        ax.plot(P[h, n, 0], lw=1.0, ls='--', color=C['flow'], label='Predicted $\\mu$')
        ax.set_title(f'({"ab"[0 if lab.startswith("High") else 1]}) {lab}')
        ax.set_xlabel('Hour'); ax.set_ylabel('Outflow')
        # Demand is spiky enough to reach the top of the axes, so 'best'
        # placement still lands the legend on the peaks. Reserve a band above
        # the highest interval and pin the legend into it.
        lo, hi = ax.get_ylim()
        ax.set_ylim(lo, hi + (hi - lo) * 0.42)
        ax.legend(frameon=False, fontsize=7.5, loc='upper right', ncol=3,
                  handlelength=1.2, handletextpad=0.5, columnspacing=1.1,
                  borderpad=0.2)
    ax = axes[2]
    lv = np.arange(5, 100, 5)
    from scipy.stats import norm
    cov = [float(((Y >= P - norm.ppf(0.5 + l / 200) * sd) &
                  (Y <= P + norm.ppf(0.5 + l / 200) * sd)).mean() * 100) for l in lv]
    ax.plot([0, 100], [0, 100], '--', lw=1.0, color=C['grey'], label='Ideal')
    ax.plot(lv, cov, 'o-', lw=1.5, ms=3.5, color=C['main'], label='MR-STGN')
    ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.set_aspect('equal')
    ax.set_xlabel('Nominal coverage (%)'); ax.set_ylabel('Empirical coverage (%)')
    ax.set_title('(c) Reliability diagram')
    ax.legend(frameon=False, loc='upper left', borderpad=0.2)
    fig.tight_layout(pad=1.4, w_pad=2.0, h_pad=1.6)
    fig.savefig(os.path.join(OUT, 'fig9_uncertainty.png')); plt.close(fig)


# ------------------------------------------------------------ equal-cost curves
def fig_equalcost(mc_sz, mc_ch):
    series = [('static_scaled', 'No prediction', C['grey'], 's--'),
              ('gru_scaled', 'GRU (graph-free)', C['sim'], '^-'),
              ('point_scaled', r'MR-STGN $\mu$', C['main'], 'o-'),
              ('risk', r'MR-STGN $\mu+z\sigma$', C['flow'], 'd-')]
    scale_fonts(11.6, 0.98)
    fig, axes = plt.subplots(1, 2, figsize=(11.6, 4.0))
    for ax, mc, city in [(axes[0], mc_sz, 'Shenzhen'), (axes[1], mc_ch, 'Chicago')]:
        if mc is None:
            continue
        for key, lab, col, mk in series:
            if key not in mc:
                continue
            rs = sorted(mc[key], key=lambda r: r['bikes_moved_per_hour'])
            ax.plot([r['bikes_moved_per_hour'] for r in rs],
                    [r['unmet_rate_pct'] for r in rs], mk, color=col,
                    lw=1.5, ms=4, label=lab)
        ax.set_xlabel('Vehicles moved per hour')
        ax.set_ylabel('Unmet demand rate (%)')
        ax.set_title(f'({"ab"[0 if city=="Shenzhen" else 1]}) {city}')
        ax.margins(x=0.04, y=0.06)
    # The curves run from top-left to bottom-right, so no corner inside the
    # axes is reliably free; the legend goes outside the axes instead.
    h, l = axes[0].get_legend_handles_labels()
    fig.legend(h, l, loc='lower center', ncol=4, frameon=False,
               bbox_to_anchor=(0.5, -0.02))
    fig.tight_layout(pad=1.4, w_pad=2.4, rect=(0, 0.10, 1, 1))
    # The .tex refers to this figure by the filename the superseded workflow
    # diagram used to occupy; keep it so the manuscript builds unchanged.
    fig.savefig(os.path.join(OUT, 'fig11_dispatching_workflow.png'))
    plt.close(fig)


# ------------------------------------------------------------ cross-city ablation
def fig_crosscity(ab_sz, ab_ch):
    names = ['No Graph (GRU only)', 'Geo Only', 'Flow Only', 'Sim Only', 'MR-STGN (Full)']
    short = ['No graph', 'Geo only', 'Flow only', 'Sim only', 'Full (3 graphs)']
    fig, axes = plt.subplots(1, 2, figsize=(11.6, 3.8))
    for ax, ab, city in [(axes[0], ab_sz, 'Shenzhen'), (axes[1], ab_ch, 'Chicago')]:
        full = np.mean([r['MAE'] for r in ab if r['variant'] == 'MR-STGN (Full)'])
        vals, labs = [], []
        for nm, sh in zip(names, short):
            rs = [r['MAE'] for r in ab if r['variant'] == nm]
            if rs:
                vals.append((np.mean(rs) / full - 1) * 100); labs.append(sh)
        cols = [C['flow'] if v > 0 else C['sim'] for v in vals]
        cols[-1] = C['main']
        ax.bar(labs, vals, color=cols, width=0.6)
        for i, v in enumerate(vals):
            ax.text(i, v + (0.12 if v >= 0 else -0.3), f'{v:+.1f}%', ha='center', fontsize=8)
        ax.axhline(0, color='0.3', lw=0.8)
        ax.set_ylabel('MAE change vs. full model (%)')
        ax.set_title(f'({"ab"[0 if city=="Shenzhen" else 1]}) {city}')
        ax.tick_params(axis='x', rotation=18)
    fig.tight_layout(pad=1.4, w_pad=2.0, h_pad=1.6)
    # Supplementary; the manuscript does not use it, so it does not go into
    # the paper directory.
    fig.savefig(os.path.join(HERE, 'fig11_crosscity.png'))
    plt.close(fig)


def main():
    os.makedirs(OUT, exist_ok=True)
    sz = np.load(os.path.join(HERE, 'out_paper', 'test_outputs.npz'))
    ch_p = os.path.join(HERE, 'out_chicago', 'test_outputs.npz')
    ch = np.load(ch_p) if os.path.exists(ch_p) else None
    sh_p = os.path.join(HERE, 'out_shanghai', 'test_outputs.npz')
    sh = np.load(sh_p) if os.path.exists(sh_p) else None
    ap = argparse.ArgumentParser()
    ap.add_argument('--mat', default='dataset.mat',
                    help='primary-city dataset, used for the grid centroids')
    args = ap.parse_args()
    mat = sio.loadmat(args.mat)
    centers = mat['grid_centers']
    sweep = load(os.path.join(HERE, 'sweep_out', 'results.json'), [])
    ab_sz = load(os.path.join(HERE, 'ablation_out', 'results.json'), [])
    ab_ch = load(os.path.join(HERE, 'ablation_chicago', 'results.json'), [])
    mc_sz = load(os.path.join(HERE, 'tables', 'matched_cost.json'))
    mc_ch = load(os.path.join(HERE, 'tables_chicago', 'matched_cost.json'))

    fig_dataset(mat);            print('  fig1_dataset.png')
    fig_graphs(sz);              print('  fig_graph_structures.png')
    fig_scatter(sz);             print('  fig3_scatter.png')
    fig_spatial(sz, centers);    print('  fig4_spatial.png')
    fig_timeseries(sz);          print('  fig5_timeseries.png')
    fig_sensitivity(sweep);      print('  fig6_sensitivity.jpg')
    fig_attention(sz, ch, sh);   print('  fig7_attention.jpg')
    fig_error(sz);               print('  fig8_error.jpg')
    fig_uncertainty(sz);         print('  fig9_uncertainty.png')
    fig_equalcost(mc_sz, mc_ch); print('  fig11_dispatching_workflow.png')
    fig_crosscity(ab_sz, ab_ch); print('  fig11_crosscity.png (supplementary)')
    print(f'\noutput directory: {OUT}')


if __name__ == '__main__':
    main()
