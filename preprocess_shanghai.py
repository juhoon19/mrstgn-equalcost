#!/usr/bin/env python3
"""
Shanghai, 2018-08-26 to 2018-09-08: a second dockless Chinese city.

The raw files are lock/unlock event records, not trip records:

    BIKE_ID, DATA_TIME, LOCK_STATUS, LONGITUDE, LATITUDE

Sorting by bike and time, a LOCK_STATUS 0 record followed by a LOCK_STATUS 1
record for the same bike is one trip: the 0 event gives the origin and the 1
event the destination. Spurious lock/unlock events at the same spot are removed
by requiring a plausible duration and displacement.

Everything downstream is identical to the other two cities: the same
0.005-degree grid, the same top-200 node selection, the same hourly
aggregation, and origin-destination counts restricted to the training period.

Note on scope: this window is 14 days (336 hourly steps), against 153 days for
the other two cities. It is long enough to compare predictive accuracy, the
ablation ordering and the attention pattern, and too short for the rebalancing
simulation, which needs a test period spanning several daily cycles. The paper
uses it for the former only.
"""

import os
import re
import glob
import zipfile
import argparse

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)

START = '2018-08-26'
END = '2018-09-09'                      # exclusive
BBOX = dict(lat_min=30.60, lat_max=31.60, lng_min=120.80, lng_max=122.10)


def haversine_matrix(lat, lng):
    R = 6371.0
    la = np.radians(lat)[:, None]
    lo = np.radians(lng)[:, None]
    dla = la - la.T
    dlo = lo - lo.T
    a = np.sin(dla / 2) ** 2 + np.cos(la) * np.cos(la.T) * np.sin(dlo / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def extract_trips(df, start_dt, g, min_sec, max_sec, min_km):
    """Turn lock/unlock events into trips with origin and destination cells."""
    # parse_dates does not always fire when reading from a zip file handle.
    # Some days mix full timestamps with date-only records; pandas infers one
    # format from the first row, so a date-only first row silently turns every
    # timestamped record into NaT. format='mixed' parses both. Date-only records
    # carry no hour and are dropped rather than being assigned to midnight,
    # which would inflate the hour-0 counts.
    if not pd.api.types.is_datetime64_any_dtype(df.DATA_TIME):
        raw = df.DATA_TIME.astype(str)
        has_time = raw.str.contains(':', na=False)
        df = df[has_time]
        df = df.assign(DATA_TIME=pd.to_datetime(df.DATA_TIME, format='mixed',
                                                errors='coerce'))
    df = df.dropna(subset=['DATA_TIME', 'LONGITUDE', 'LATITUDE', 'LOCK_STATUS'])
    df = df.sort_values(['BIKE_ID', 'DATA_TIME'], kind='mergesort').reset_index(drop=True)

    s = df.LOCK_STATUS.to_numpy()
    b = df.BIKE_ID.to_numpy()
    ok = (s[:-1] == 0) & (s[1:] == 1) & (b[:-1] == b[1:])
    i = np.flatnonzero(ok)
    if i.size == 0:
        return None

    o = df.iloc[i]
    d = df.iloc[i + 1]
    dur = (d.DATA_TIME.to_numpy() - o.DATA_TIME.to_numpy()) / np.timedelta64(1, 's')

    R = 6371.0
    la1, lo1 = np.radians(o.LATITUDE.to_numpy()), np.radians(o.LONGITUDE.to_numpy())
    la2, lo2 = np.radians(d.LATITUDE.to_numpy()), np.radians(d.LONGITUDE.to_numpy())
    hav = np.sin((la2 - la1) / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin((lo2 - lo1) / 2) ** 2
    km = 2 * R * np.arcsin(np.sqrt(np.clip(hav, 0, 1)))

    keep = (dur >= min_sec) & (dur <= max_sec) & (km >= min_km)
    for c, lo_v, hi_v in [(o.LATITUDE, BBOX['lat_min'], BBOX['lat_max']),
                          (o.LONGITUDE, BBOX['lng_min'], BBOX['lng_max']),
                          (d.LATITUDE, BBOX['lat_min'], BBOX['lat_max']),
                          (d.LONGITUDE, BBOX['lng_min'], BBOX['lng_max'])]:
        v = c.to_numpy()
        keep &= (v >= lo_v) & (v <= hi_v)
    if keep.sum() == 0:
        return None

    o, d = o[keep], d[keep]
    t = ((o.DATA_TIME.to_numpy() - np.datetime64(start_dt))
         / np.timedelta64(1, 'h')).astype(np.int64)
    okey = (np.floor(o.LATITUDE.to_numpy() / g).astype(np.int64) * 1_000_000
            + np.floor(o.LONGITUDE.to_numpy() / g).astype(np.int64))
    dkey = (np.floor(d.LATITUDE.to_numpy() / g).astype(np.int64) * 1_000_000
            + np.floor(d.LONGITUDE.to_numpy() / g).astype(np.int64))
    return t, okey, dkey


def main():
    ap = argparse.ArgumentParser()
    # Archive of the raw Shanghai lock/unlock event records; pass the path to
    # your own copy, which is not redistributable with this repository.
    ap.add_argument('--zip', default='shanghai_trajectories.zip')
    ap.add_argument('--out', default=os.path.join(HERE, 'shanghai_data.npz'))
    ap.add_argument('--cache', default=os.path.join(HERE, '_sh_trips'))
    ap.add_argument('--grid_size', type=float, default=0.005)
    ap.add_argument('--max_nodes', type=int, default=200)
    ap.add_argument('--min_trips', type=int, default=200)
    ap.add_argument('--min_sec', type=float, default=60)
    ap.add_argument('--max_sec', type=float, default=7200)
    ap.add_argument('--min_km', type=float, default=0.1)
    args = ap.parse_args()

    os.makedirs(args.cache, exist_ok=True)
    start_dt = pd.Timestamp(START)
    T = int((pd.Timestamp(END) - start_dt).total_seconds() // 3600)
    train_end = int(T * 0.7)
    g = args.grid_size
    print(f"window {START} to {END} | T={T} hours | training ends at t={train_end}")

    zf = zipfile.ZipFile(args.zip)
    members = sorted(n for n in zf.namelist()
                     if n.endswith('.csv') and '20180826-0908' in n)
    print(f"{len(members)} daily files")

    # ---- pass 1: extract trips per day and cache them ----
    for name in members:
        day = re.search(r'(\d{4}-\d{2}-\d{2})', name).group(1)
        cache = os.path.join(args.cache, f'{day}.npz')
        if os.path.exists(cache):
            print(f"  {day}: cached", flush=True)
            continue
        with zf.open(name) as fh:
            df = pd.read_csv(fh, parse_dates=['DATA_TIME'])
        got = extract_trips(df, start_dt, g, args.min_sec, args.max_sec, args.min_km)
        del df
        if got is None:
            print(f"  {day}: no trips", flush=True)
            continue
        t, okey, dkey = got
        np.savez_compressed(cache, t=t, okey=okey, dkey=dkey)
        print(f"  {day}: {len(t):,} trips", flush=True)

    # ---- pass 2: select nodes and build tensors ----
    files = sorted(glob.glob(os.path.join(args.cache, '*.npz')))
    counts = {}
    for f in files:
        z = np.load(f)
        for arr in (z['okey'], z['dkey']):
            k, c = np.unique(arr, return_counts=True)
            for kk, cc in zip(k, c):
                counts[int(kk)] = counts.get(int(kk), 0) + int(cc)
    ser = pd.Series(counts).sort_values(ascending=False)
    ser = ser[ser >= args.min_trips]
    keys = ser.index[:args.max_nodes].to_numpy()
    N = len(keys)
    key2idx = {int(k): i for i, k in enumerate(keys)}
    print(f"candidate cells {len(ser)} (>= {args.min_trips} trips), keeping {N}")

    flow = np.zeros((T, N, 2), dtype=np.float32)
    od_train = np.zeros((N, N), dtype=np.float64)
    od_full = np.zeros((N, N), dtype=np.float64)
    total = 0
    for f in files:
        z = np.load(f)
        t, okey, dkey = z['t'], z['okey'], z['dkey']
        oi = np.array([key2idx.get(int(k), -1) for k in okey])
        di = np.array([key2idx.get(int(k), -1) for k in dkey])
        m = (oi >= 0) & (di >= 0) & (t >= 0) & (t < T)
        t, oi, di = t[m], oi[m], di[m]
        total += len(t)
        np.add.at(flow, (t, oi, 0), 1)
        np.add.at(flow, (t, di, 1), 1)
        np.add.at(od_full, (oi, di), 1)
        tr = t < train_end
        np.add.at(od_train, (oi[tr], di[tr]), 1)
    print(f"trips inside the selected cells {total:,}")

    gi = (keys // 1_000_000).astype(np.int64)
    gj = (keys % 1_000_000).astype(np.int64)
    lat_c = (gi + 0.5) * g
    lng_c = (gj + 0.5) * g
    dist = haversine_matrix(lat_c, lng_c)
    centers = np.stack([lat_c, lng_c], axis=1)

    np.savez_compressed(args.out, flow_tensor=flow, distance_matrix=dist,
                        grid_centers=centers, od_train=od_train, od_full=od_full,
                        train_end=train_end, T=T, N=N, grid_size=g)

    print("\n=== Shanghai dataset ===")
    print(f"  shape {flow.shape} | total flow {flow.sum():,.0f}")
    print(f"  non-zero training-period OD pairs {int((od_train>0).sum()):,} / {N*N:,}")
    print(f"  mean hourly system-wide outflow {flow[:,:,0].sum(1).mean():.1f}")
    print(f"  mean per-region-hour outflow {flow[:,:,0].mean():.2f}")
    print(f"  zero share of region-hours {(flow[:,:,0]==0).mean()*100:.1f}%")
    print(f"  inter-node distance: median {np.median(dist[dist>0]):.2f} km, "
          f"max {dist.max():.2f} km")
    print(f"  saved to {args.out}")


if __name__ == '__main__':
    main()
