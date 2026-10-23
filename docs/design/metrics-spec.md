# 行为加权指标规范（metrics-spec）

> 状态：P2-4 三端统一口径的**唯一契约**。三份实现必须逐字一致；本文件由 `contract-check.mjs` 第 13 组机械校验。
>
> 权威实现：`D:\cline\src\core\teaching\behavior\metricsSpec.ts`
> 镜像实现：`D:\web-dashboard\teaching-server\src\submission\metricsSpec.ts`
> 镜像实现：`D:\web-dashboard\backend\src\metricsSpec.js`

## 1. 常量

```ts
export const METRICS_SCHEMA = "behavior-weighted/v1";
export const BEHAVIOR_TYPES = ["concept", "design", "error_help", "self_code", "ai_code", "other"] as const;
export const BEHAVIOR_WEIGHTS = { concept: 0.25, design: 0.75, error_help: 1.0, self_code: 0, ai_code: 1.2 } as const;
export const DEPENDENCY_DIVISOR = 1.2;
export const MAX_BEHAVIOR_WEIGHT = 1.2;
export const ADOPTION_WINDOW_TURNS = 5;
export const GUIDANCE_WINDOW_TURNS = 3;
export const ERROR_WINDOW_TURNS = 5;
export const QUERY_TYPE_FALLBACK = {
  concept: "concept",
  design: "design",
  error_help: "error_help",
  coding: "design",
  other: "other",
} as const;
```

## 2. 公式（与计划 §3 一致）

```
N   = 参与计分的行为条数（behaviorMix 中除 other 外的计数之和）
ΣW  = Σ(eventWeight)
depIndex          = round6(ΣW / (DEPENDENCY_DIVISOR × N))       // ∈ [0,1]，N=0 → null
weightedMean      = round6(ΣW / N)                               // ∈ [0,1.2]，N=0 → null
selfCodingRatio   = round6(self_code / (self_code + ai_code))    // 分母 0 → null
adoptionDeepening = round6(命中窗口的 adopted 数 / adopted 数)    // 分母 0 → null
guidanceEffect    = round6(1 - ai_code / demands)                // demands 0 → null
errorResolutionRate = round6(命中窗口的已解决数 / error_help 数)  // 分母 0 → null
behaviorMix       = { concept, design, error_help, self_code, ai_code, other } 计数
```

`round6(x) = Math.round(x * 1e6) / 1e6`；三端使用同一舍入，保证浮点 `toString()` 完全相等。

> 计划 §6 P2-1 测试断言第 11 条写「概念+自主各半 → 0.125」，该值实为 `weightedMean`：
> `(0.25+0)/(1.2×2) = 0.1041667`（与设计 §5.3 示例 10.4% 一致）。实现按公式，测试同时断言
> `depIndex=0.104167` 与 `weightedMean=0.125`。

## 3. 行为类型解析（`resolveBehaviorType(event)`，优先级从高到低）

1. `event.behaviorType` ∈ `BEHAVIOR_TYPES` → 原样使用（**新字段永远优先**，BN-41）。
2. `event.eventType === "code_edit"` → `event.editor === "ai" ? "ai_code" : "self_code"`（旧日志无 editor 按人工处理）。
3. `event.eventType === "file_save"` → `"self_code"`。
4. `event.queryType` ∈ `QUERY_TYPE_FALLBACK` → 映射值（旧事件回退路径，PLAN 测试 15）。
5. `event.role === "assistant" && event.hasFullImpl === true` → `"ai_code"`。
6. 其余 → `"other"`。

`eventWeight(event)`：类型为 `other` → 0；否则若 `event.behaviorWeight` 是有限数，则 `clamp(0, MAX_BEHAVIOR_WEIGHT)` 并在越界时 `console.warn("[metricsSpec] behaviorWeight 越界，已夹取", ...)`（BN-40）；否则 `BEHAVIOR_WEIGHTS[type]`。

## 4. 窗口类指标

- 事件流按**数组顺序**判定先后；`turnIndex` 双方都为有限数时用 `turnIndex` 差，否则用数组下标差。
- `adoptions`：`eventType === "adoption_infer" && adoptionStatus === "adopted"`。
- `adoptionDeepening` 命中：adopted 事件之后窗口内出现 `self_code` 类型事件。
- `demands`：`behaviorSignals`（字符串）包含 `"full_impl_demand"`，或 `interventionRuleId === "full_impl_demand"` 的事件数。
- `resolvedErrors`：`error_help` 类型事件之后窗口内出现 `eventType === "run_trace" && Number(event.exit_code) === 0`。
- 窗口距离 0（`turnIndex` 相同、数组位置靠后）**计入**窗口；`turnIndex` 倒退（差 < 0）不计入。三端必须一致。
- `event.ts` 缺失不抛错、不丢事件（BN-39）；时间戳不参与上述窗口判定。

## 5. 导出（三端同名）

```ts
round6(n): number
resolveBehaviorType(event): BehaviorType
eventWeight(event): number
behaviorMix(events): Record<BehaviorType, number>
dependencyCount(events): number
depIndex(events): number | null
weightedMean(events): number | null
selfCodingRatio(events): number | null
adoptionDeepening(events): number | null
guidanceEffect(events): number | null
errorResolutionRate(events): number | null
computeDependenceMetrics(events): {
  depIndex; weightedMean; selfCodingRatio; adoptionDeepening; guidanceEffect;
  errorResolutionRate; behaviorMix; metricsSchema: string;
}
```

纯函数、零外部依赖（不 import Logger / fs / 环境变量），不抛异常；`events` 允许 `undefined`/非数组（按空数组处理）。
