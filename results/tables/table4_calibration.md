# Table 4: uncertainty calibration

Probabilistic metrics over the full test set and all regions.
PICP is empirical coverage (ideally equal to the nominal level); MPIW is
mean prediction interval width; NLL and CRPS are lower-is-better.

| Model | NLL | CRPS | PICP50% | PICP90% | PICP95% | MPIW50 | MPIW90 | MPIW95 |
|---|---|---|---|---|---|---|---|---|
| MR-STGN | 3.596 | 7.301 | 57.5 | 93.0 | 96.1 | 18.33 | 44.70 | 53.26 |
| MR-STGN (Full, seed 42) | 3.596 | 7.301 | 57.5 | 93.0 | 96.1 | 18.33 | 44.70 | 53.26 |
| MR-STGN (Full, seed 7) | 3.612 | 7.239 | 51.8 | 90.1 | 94.2 | 16.49 | 40.22 | 47.93 |
| MR-STGN (Full, seed 2026) | 3.592 | 7.364 | 55.4 | 91.9 | 95.3 | 18.10 | 44.15 | 52.61 |

Ideal coverage is PICP50 = 50, PICP90 = 90, PICP95 = 95.
The further from those values, the worse the variance is calibrated.
