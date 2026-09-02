#!/usr/bin/env python3
"""
Chicago Divvy, 2021-04-01 to 2021-08-31: the second city, processed through
exactly the same pipeline as the primary dataset.

Why this dataset:
    1. cross-city generalization, so no conclusion rests on a single city;
    2. Divvy publishes trip origins and destinations, so the OD matrix can be
       restricted to the training period exactly;
    3. it is fully public, so these results are reproducible by anyone.

Settings shared with the primary pipeline:
    window   2021-04-01 to 2021-08-31 (153 days = 3672 hours)
    grid     0.005 x 0.005 degrees
    nodes    the 200 busiest cells by total trips
    channels outflow and inflow

Differences that are stated in the paper:
    - Chicago sits near 41.9 degrees north, where 0.005 degrees of longitude is
      about 413 m, against about 512 m at 22.5 degrees. The same angular
      resolution therefore gives cells of different physical width.
    - Divvy is primarily station-based with dockless e-bikes, whereas the
      primary dataset is fully dockless. Once gridded by coordinates the two
      are equivalent for modelling, but this is a cross-system test as well as
      a cross-city one.
"""

import os
import glob
import argparse

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)

START = '2021-04-01'
END = '2021-09-01'
BBOX = dict(lat_min=41.60, lat_max=42.10, lng_min=-88.00, lng_max=-87.50)


def haversine_matrix(lat, lng):
    R = 6371.0
    la = np.radians(lat)[:, None]
    lo = np.radians(lng)[:, None]
    dla = la - la.T
    dlo = lo - lo.T
    a = np.sin(dla / 2) ** 2 + np.cos(la) * np.cos(la.T) * np.sin(dlo / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data_dir', default=os.path.join(PROJ, 'data_chicago'))
    ap.add_argument('--out', default=os.path.join(HERE, 'chicago_data.npz'))
    ap.add_argument('--grid_size', type=float, default=0.005)
    ap.add_argument('--max_nodes', type=int, default=200)
    ap.add_argument('--min_trips', type=int, default=1000)
    args = ap.parse_args()

    start_dt = pd.Timestamp(START)
    end_dt = pd.Timestamp(END)
    T = int((end_dt - start_dt).total_seconds() // 3600)
    train_end = int(T * 0.7)
    print(f"window {START} to {END} | T={T} hours | training ends at t={train_end}")

    frames = []
    for f in sorted(glob.glob(os.path.join(args.data_dir, '*.csv'))):
        print(f"  reading {os.path.basename(f)} ...", flush=True)
        for chunk in pd.read_csv(
                f, chunksize=500_000, low_memory=False,
                usecols=['started_at', 'start_lat', 'start_lng', 'end_lat', 'end_lng']):
            chunk['started_at'] = pd.to_datetime(chunk['started_at'], errors='coerce')
            chunk = chunk.dropna()
            chunk = chunk[(chunk.started_at >= start_dt) & (chunk.started_at < end_dt)]
            for c, lo, hi in [('start_lat', BBOX['lat_min'], BBOX['lat_max']),
                              ('end_lat', BBOX['lat_min'], BBOX['lat_max']),
                              ('start_lng', BBOX['lng_min'], BBOX['lng_max']),
                              ('end_lng', BBOX['lng_min'], BBOX['lng_max'])]:
                chunk = chunk[(chunk[c] >= lo) & (chunk[c] <= hi)]
            if len(chunk):
                frames.append(chunk)
    df = pd.concat(frames, ignore_index=True)
    del frames
    print(f"valid records {len(df):,}")

    g = args.grid_size
    for p in ['start', 'end']:
        df[f'{p}_gi'] = np.floor(df[f'{p}_lat'] / g).astype(np.int64)
        df[f'{p}_gj'] = np.floor(df[f'{p}_lng'] / g).astype(np.int64)
        df[f'{p}_key'] = df[f'{p}_gi'] * 1_000_000 + (df[f'{p}_gj'] + 500_000)

    # Node selection: the max_nodes busiest cells by departures + arrivals
    cnt = (df.start_key.value_counts().add(df.end_key.value_counts(), fill_value=0))
    cnt = cnt[cnt >= args.min_trips].sort_values(ascending=False)
    keys = cnt.index[:args.max_nodes].to_numpy()
    N = len(keys)
    print(f"candidate cells {len(cnt)} (>= {args.min_trips} trips), keeping {N}")

    key2idx = {int(k): i for i, k in enumerate(keys)}
    df = df[df.start_key.isin(key2idx) & df.end_key.isin(key2idx)].copy()
    df['o'] = df.start_key.map(key2idx).astype(np.int32)
    df['d'] = df.end_key.map(key2idx).astype(np.int32)
    df['t'] = ((df.started_at - start_dt).dt.total_seconds() // 3600).astype(np.int64)
    df = df[(df.t >= 0) & (df.t < T)]
    print(f"records inside the selected cells {len(df):,}")

    # Cell centroids
    gi = (keys // 1_000_000).astype(np.int64)
    gj = (keys % 1_000_000 - 500_000).astype(np.int64)
    lat_c = (gi + 0.5) * g
    lng_c = (gj + 0.5) * g

    # Flow tensor
    flow = np.zeros((T, N, 2), dtype=np.float32)
    np.add.at(flow, (df.t.to_numpy(), df.o.to_numpy(), 0), 1)
    np.add.at(flow, (df.t.to_numpy(), df.d.to_numpy(), 1), 1)

    # ---- OD counts and hourly profiles from the training period only ----
    tr = df[df.t < train_end]
    od_train = np.zeros((N, N), dtype=np.float64)
    np.add.at(od_train, (tr.o.to_numpy(), tr.d.to_numpy()), 1)
    print(f"non-zero training-period OD pairs {int((od_train>0).sum()):,} / {N*N:,}")

    # Full-period OD, kept only to quantify what training-period restriction
    # changes; it is not used by any experiment.
    od_full = np.zeros((N, N), dtype=np.float64)
    np.add.at(od_full, (df.o.to_numpy(), df.d.to_numpy()), 1)

    dist = haversine_matrix(lat_c, lng_c)
    centers = np.stack([lat_c, lng_c], axis=1)

    np.savez_compressed(
        args.out, flow_tensor=flow, distance_matrix=dist, grid_centers=centers,
        od_train=od_train, od_full=od_full, train_end=train_end, T=T, N=N,
        grid_size=g)

    print(f"\n=== Chicago dataset ===")
    print(f"  shape {flow.shape} | total flow {flow.sum():,.0f}")
    print(f"  cell size: {g*111:.3f} km lat x "
          f"{g*111*np.cos(np.radians(lat_c.mean())):.3f} km lon")
    print(f"  inter-node distance: median {np.median(dist[dist>0]):.2f} km, "
          f"max {dist.max():.2f} km")
    print(f"  mean hourly system-wide outflow {flow[:,:,0].sum(1).mean():.1f}")
    print(f"  saved to {args.out}")


if __name__ == '__main__':
    main()
