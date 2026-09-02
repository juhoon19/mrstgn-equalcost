# Table 2: ablation over the relational graphs

Every variant below was implemented and trained for this study.

| Variant | Prev. MAE | Measured MAE | Prev. RMSE | Measured RMSE | Prev. Rel.dMAE | Measured Rel.dMAE | NLL | PICP95% | Seeds |
|---|---|---|---|---|---|---|---|---|---|
| No Graph (GRU only) | 16.73 | **11.05** ±0.18 | 30.46 | 20.05 | +45.0% | +8.9% | 3.732 | 95.2 | 3 |
| Geo Only | 14.43 | **10.24** | 26.28 | 18.21 | +25.0% | +0.9% | 3.609 | 95.4 | 1 |
| Flow Only | 13.85 | **10.35** | 25.23 | 18.27 | +20.0% | +2.0% | 3.635 | 96.3 | 1 |
| Sim Only | 15.00 | **10.18** | 27.32 | 18.02 | +30.0% | +0.3% | 3.627 | 95.9 | 1 |
| Geo + Flow | 12.69 | **10.30** | 23.12 | 18.44 | +10.0% | +1.5% | 3.624 | 95.8 | 1 |
| Geo + Sim | 13.27 | **10.08** | 24.17 | 17.72 | +15.0% | -0.7% | 3.612 | 95.7 | 1 |
| Flow + Sim | 12.92 | **10.09** | 23.53 | 17.81 | +12.0% | -0.6% | 3.593 | 95.3 | 1 |
| MR-STGN (Full) | 11.54 | **10.15** ±0.06 | 21.01 | 17.93 | — | +0.0% | 3.600 | 95.2 | 3 |
