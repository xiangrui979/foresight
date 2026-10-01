# 人工抽查样本（Task 1.8：10 条待人工判定）

| system | item | query | answer | injected | correct(机器) |
|---|---|---|---|---|---|
| foresight | foresight-dry-1 | 训练任务 | 训练任务在跑 / 用户是研究生 / 用户是大学生 | GuOUFaahmOPMZ__FT7vDv, XQGBjgA5o3S7nvxdBBcY9, E-CfC_Q5Kuh4MFQNJYMYI | true |
| foresight | foresight-dry-2 | 用户身份 | 用户是大学生 / 训练任务在跑 / 用户是研究生 | E-CfC_Q5Kuh4MFQNJYMYI, GuOUFaahmOPMZ__FT7vDv, XQGBjgA5o3S7nvxdBBcY9 | true |
| foresight | foresight-dry-3 | 下一阶段迭代 | 用户是研究生 / 训练任务在跑 / 用户是大学生 | XQGBjgA5o3S7nvxdBBcY9, GuOUFaahmOPMZ__FT7vDv, E-CfC_Q5Kuh4MFQNJYMYI | false |
| nolifecycle | nolifecycle-dry-1 | 训练任务 | 训练任务在跑 / 用户是研究生 / 用户是大学生 | GuOUFaahmOPMZ__FT7vDv, XQGBjgA5o3S7nvxdBBcY9, E-CfC_Q5Kuh4MFQNJYMYI | true |
| nolifecycle | nolifecycle-dry-2 | 用户身份 | 用户是大学生 / 训练任务在跑 / 用户是研究生 | E-CfC_Q5Kuh4MFQNJYMYI, GuOUFaahmOPMZ__FT7vDv, XQGBjgA5o3S7nvxdBBcY9 | true |
| nolifecycle | nolifecycle-dry-3 | 下一阶段迭代 | 用户是研究生 / 训练任务在跑 / 用户是大学生 | XQGBjgA5o3S7nvxdBBcY9, GuOUFaahmOPMZ__FT7vDv, E-CfC_Q5Kuh4MFQNJYMYI | false |
| recency | recency-dry-1 | 训练任务 | 用户是研究生 / 用户是大学生 / 训练任务在跑 | XQGBjgA5o3S7nvxdBBcY9, E-CfC_Q5Kuh4MFQNJYMYI, GuOUFaahmOPMZ__FT7vDv | true |
| recency | recency-dry-2 | 用户身份 | 用户是研究生 / 用户是大学生 / 训练任务在跑 | XQGBjgA5o3S7nvxdBBcY9, E-CfC_Q5Kuh4MFQNJYMYI, GuOUFaahmOPMZ__FT7vDv | true |
| recency | recency-dry-3 | 下一阶段迭代 | 用户是研究生 / 用户是大学生 / 训练任务在跑 | XQGBjgA5o3S7nvxdBBcY9, E-CfC_Q5Kuh4MFQNJYMYI, GuOUFaahmOPMZ__FT7vDv | false |
| rag | rag-dry-1 | 训练任务 | 用户是研究生 / 用户是大学生 | XQGBjgA5o3S7nvxdBBcY9, E-CfC_Q5Kuh4MFQNJYMYI | false |
