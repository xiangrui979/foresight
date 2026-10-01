# RUNLOG

## smoke-offline-1 · 2026-10-01

- commit: `dcfde34` · offline stub reader（无 LLM 调用；真实 reader/judge 需 key）
- 20 items × 7 systems = 140 traces · budget=2000 tokens
- cost: calls=0 · ¥0（离线）· tokenizer=estimate@v1 (cl100k_base unavailable)
- trace: eval/results/smoke/traces.jsonl（校验通过）· 主表: eval/results/smoke/summary.md
- ingest 接受: smoke-ttl-active-0:1/1 smoke-ttl-active-1:1/1 smoke-ttl-active-2:1/1 smoke-ttl-expired-0:1/1 smoke-ttl-expired-1:1/1 smoke-ttl-expired-2:1/1 smoke-point-active-0:1/1 smoke-point-expired-0:1/1 smoke-not-started-0:1/1 smoke-not-started-1:1/1 smoke-interval-active-0:1/1 smoke-interval-active-1:1/1 smoke-update-0:2/1 smoke-update-1:2/1 smoke-prediction-0:1/1 smoke-prediction-1:1/1 smoke-control-empty-0:0/1 smoke-gate-reject-0:0/1 smoke-multisession-0:1/2 smoke-final-0:1/1
- mechanism checklist: C1/C2 expired not injected (foresight) vs nolifecycle contrast=PASS · C10 not-started hidden by lifecycle=PASS · C6 budget respected=PASS · C3 f_embed participates in final score=PASS · C5 gate-eval rules aspect ≥80%=PASS · C7 prediction evidence channel wired=PASS · C8 UTC-stable date extraction=PASS
