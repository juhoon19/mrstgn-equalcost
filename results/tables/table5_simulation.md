# Table 6: rebalancing simulation under a fleet quota

Forecast output is connected to an actual dispatching decision; the four
families of operational indicators are reported below.

Horizon: 526 test hours x 200 regions; movement budget 5% of the fleet per hour.

## Quota Q=2.0h

| Policy | Unmet demand % | Stockout region-hours % | Pile-up region-hours % | Vehicles moved/h | bike-km/h |
|---|---|---|---|---|---|
| static (no prediction) | 5.361 | 7.75 | 32.77 | 265 | 183 |
| HA forecast | 4.847 | 9.03 | 29.95 | 471 | 385 |
| GRU forecast (graph-free) | 4.854 | 9.83 | 29.87 | 418 | 305 |
| MR-STGN mu (point) | 4.827 | 10.08 | 29.83 | 394 | 283 |
| MR-STGN mu+1.0sigma (risk-aware) | 4.525 | 7.27 | 28.47 | 554 | 468 |
| oracle (perfect foresight) | 4.588 | 6.25 | 28.53 | 549 | 458 |

## Quota Q=3.0h

| Policy | Unmet demand % | Stockout region-hours % | Pile-up region-hours % | Vehicles moved/h | bike-km/h |
|---|---|---|---|---|---|
| static (no prediction) | 5.192 | 7.58 | 33.09 | 260 | 180 |
| HA forecast | 4.527 | 8.87 | 29.24 | 548 | 476 |
| GRU forecast (graph-free) | 4.517 | 9.77 | 29.13 | 506 | 392 |
| MR-STGN mu (point) | 4.503 | 10.04 | 29.00 | 475 | 357 |
| MR-STGN mu+1.0sigma (risk-aware) | 4.022 | 6.52 | 26.53 | 707 | 719 |
| oracle (perfect foresight) | 4.063 | 5.06 | 26.12 | 719 | 767 |

## Quota Q=5.0h

| Policy | Unmet demand % | Stockout region-hours % | Pile-up region-hours % | Vehicles moved/h | bike-km/h |
|---|---|---|---|---|---|
| static (no prediction) | 4.864 | 7.24 | 34.61 | 249 | 172 |
| HA forecast | 4.046 | 8.51 | 29.39 | 615 | 632 |
| GRU forecast (graph-free) | 3.953 | 9.40 | 29.00 | 598 | 517 |
| MR-STGN mu (point) | 3.960 | 9.84 | 28.85 | 562 | 460 |
| MR-STGN mu+1.0sigma (risk-aware) | 3.212 | 5.55 | 24.37 | 867 | 1168 |
| oracle (perfect foresight) | 3.066 | 3.21 | 23.25 | 909 | 1356 |

