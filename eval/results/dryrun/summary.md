# ForeSight eval summary

| system | n | accuracy | SIR-i | SIR | tokens mean | tokens p95 | calls |
|---|---|---|---|---|---|---|---|
| foresight | 3 | 0.6667 | 0.0000 | 0.0000 | 28.0 | 28 | 0 |
| nolifecycle | 3 | 0.6667 | 0.0000 | 0.0000 | 28.0 | 28 | 0 |
| recency | 3 | 0.6667 | 0.0000 | 0.0000 | 18.0 | 18 | 0 |
| rag | 3 | 0.3333 | 0.0000 | 0.0000 | 12.0 | 12 | 0 |
| summary | 3 | 0.0000 | 0.0000 | 0.0000 | 37.0 | 37 | 0 |
| fullcontext | 3 | 0.0000 | 0.0000 | 0.0000 | 37.0 | 37 | 0 |
| closedbook | 3 | 0.3333 | n/a | 0.0000 | 0.0 | 0 | 0 |

## Pair foresight vs recency（paired n=3）

- McNemar: a_only=0, b_only=0, both=2/1, p=1.0000
- accuracy diff (a−b): 0.0000  95% CI [0.0000, 0.0000]
- SIR-i diff (a−b): 0.0000  95% CI [0.0000, 0.0000]
