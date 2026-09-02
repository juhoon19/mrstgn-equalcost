# Table 1: overall prediction performance

The Measured column reports the result of re-implementing and retraining
each model on the same data, the same chronological split and the same
training-set standardization. Graph WaveNet and GMAN run on exactly the
same gridded input as MR-STGN, with no special adaptation.

| Method | Prev. MAE | Measured MAE | Prev. RMSE | Measured RMSE | WMAPE% | Prev. Corr | Measured Corr | Seeds |
|---|---|---|---|---|---|---|---|---|
| HA | 35.20 | **22.83** | 58.50 | 45.46 | 37.14 | 0.520 | 0.814 | 1 |
| ARIMA | 28.50 | **29.77** | 48.20 | 50.01 | 48.43 | 0.610 | 0.757 | 1 |
| SVR | 25.80 | **18.08** | 43.50 | 39.60 | 29.41 | 0.680 | 0.873 | 1 |
| LSTM | 22.10 | **11.30** ±0.02 | 38.20 | 21.36 | 18.39 | 0.780 | 0.961 | 3 |
| GRU | 21.50 | **11.45** ±0.09 | 36.80 | 22.21 | 18.62 | 0.800 | 0.958 | 3 |
| GCN | 19.80 | **18.63** | 34.50 | 39.76 | 30.31 | 0.840 | 0.862 | 1 |
| STGCN | 17.20 | **13.18** ±0.06 | 30.20 | 25.28 | 21.44 | 0.890 | 0.944 | 2 |
| ASTGCN | 15.80 | **16.42** | 28.50 | 30.73 | 26.71 | 0.910 | 0.917 | 1 |
| DCRNN | 14.20 | **11.27** ±0.09 | 25.80 | 22.05 | 18.33 | 0.930 | 0.959 | 3 |
| GraphWaveNet | not reported | **11.48** | — | 20.81 | 18.66 | — | 0.963 | 1 |
| GMAN | not reported | **12.54** | — | 23.62 | 20.40 | — | 0.954 | 1 |
| **MR-STGN** | 11.54 | **10.14** | 21.01 | 17.92 | 16.50 | 0.962 | 0.973 | 1 |
