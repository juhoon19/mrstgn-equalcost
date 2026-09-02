# Table 6: rebalancing simulation under a fleet quota

Forecast output is connected to an actual dispatching decision; the four
families of operational indicators are reported below.

Horizon: 526 test hours x 200 regions; movement budget 5% of the fleet per hour.

## Quota Q=5.0h

| Policy | Unmet demand % | Stockout region-hours % | Pile-up region-hours % | Vehicles moved/h | bike-km/h |
|---|---|---|---|---|---|
| static (no prediction) | 1.311 | 1.79 | 32.79 | 1 | 1 |
| HA forecast | 1.211 | 1.72 | 31.25 | 3 | 2 |
| GRU forecast (graph-free) | 1.137 | 1.77 | 30.12 | 5 | 2 |
| MR-STGN mu (point) | 1.092 | 1.68 | 29.26 | 6 | 3 |
| MR-STGN mu+1.0sigma (risk-aware) | 0.613 | 1.01 | 20.80 | 20 | 11 |
| oracle (perfect foresight) | 0.255 | 0.38 | 13.55 | 35 | 22 |

