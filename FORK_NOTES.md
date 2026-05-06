# Fork Notes

本地化改造记录。fork 自 [virattt/dexter](https://github.com/virattt/dexter)。

---

## 1. 改了什么

### 1.1 默认模型 `gpt-5.4` → `gpt-5.5`

8 处全部更新，并加了**自动升级映射**：旧 `.dexter/settings.json` 里写的 `gpt-5.4` 下次启动会被自动改写成 `gpt-5.5`，不用手动改。

| 文件 | 改动 |
|---|---|
| [src/agent/agent.ts](src/agent/agent.ts) | `DEFAULT_MODEL` |
| [src/model/llm.ts](src/model/llm.ts) | `DEFAULT_MODEL` |
| [src/utils/model.ts](src/utils/model.ts) | 把 5.5 加到 OpenAI 列表首位，5.4 保留可选 |
| [src/utils/config.ts](src/utils/config.ts) | `DEPRECATED_MODEL_UPGRADES`：`gpt-5.4 → gpt-5.5` |
| [src/agent/types.ts](src/agent/types.ts) | 注释 |
| [src/evals/run.ts](src/evals/run.ts) | eval 默认模型 + LLM-judge |
| [src/gateway/gateway.ts](src/gateway/gateway.ts) | WhatsApp gateway 默认 |
| [src/cron/executor.ts](src/cron/executor.ts) | cron job 默认 |

### 1.2 金融数据：Finnhub 主、Financial Datasets 兜底

**问题**：原版强绑 financialdatasets.ai，免费档只覆盖 5 只大票（AAPL/MSFT/NVDA/TSLA/GOOGL），其他全部 402 Payment Required。

**改造**：新建路由层，**有 Finnhub key 就优先走 Finnhub**，Finnhub 失败再 fallback 到 FD。

| 新文件 | 作用 |
|---|---|
| [src/tools/finance/finnhub-api.ts](src/tools/finance/finnhub-api.ts) | Finnhub 适配器：HTTP 请求 + Finnhub 响应 → FD 字段名翻译（含 XBRL → 命名字段映射） |

| 改动文件 | 作用 |
|---|---|
| [src/tools/finance/api.ts](src/tools/finance/api.ts) | 入口加 `shouldUseFinnhub()` 路由 + try/catch fallback |
| [.env](.env) | 注释更新，标 Finnhub 为主 |

#### 端点路由表

| 端点 | Finnhub 行为 | 兜底 |
|---|---|---|
| `/prices/snapshot/` | ✅ `/quote` | FD |
| `/prices/`（历史 K 线） | ✅ **直接走 Yahoo Finance**（Finnhub `/stock/candle` 已转付费档） | FD |
| `/news` | ✅ `/company-news` 或 `/news?category=general` | FD |
| `/insider-trades/` | ✅ `/stock/insider-transactions` | FD |
| `/financial-metrics/snapshot/` | ✅ `/stock/metric?metric=all`（含 P/E、margin、ROE、52W、beta、growth 等） | FD |
| `/financial-metrics/`（历史） | ⚠️ 退化为单点快照 + TTM 包装 | FD |
| `/financials/income-statements/` | ✅ `/stock/financials-reported` + XBRL → FD 字段映射 | FD |
| `/financials/balance-sheets/` | ✅ 同上 | FD |
| `/financials/cash-flow-statements/` | ✅ 同上，自动算 `free_cash_flow = OCF - CapEx` | FD |
| `/financials/`（合并） | ✅ 同上 | FD |
| `/earnings` | ✅ `/stock/earnings` | FD |
| `/analyst-estimates/` | ✅ `/stock/recommendation` + `/stock/price-target` 合并 | FD |
| `/financials/segments/` | ❌ 不支持 | 走 FD（5 只票才有） |
| `/financials/search/screener/` | ❌ 不支持 | FD |
| `/filings/items/`（SEC 10-K 章节抽取） | ❌ 不支持（FD 独有） | FD |
| `/crypto/*` | ❌ 不支持 | FD |

#### 强制走某一家

```bash
FINANCE_PROVIDER=finnhub          # 强制 Finnhub
FINANCE_PROVIDER=financialdatasets # 强制 FD
# 不设 = 自动（有 Finnhub key 就用 Finnhub）
```

### 1.3 Yahoo Finance 历史 K 线兜底

Finnhub 把 `/stock/candle` 移到付费档了，所以 [`priceHistory()`](src/tools/finance/finnhub-api.ts) 直接走 Yahoo 的免费 chart 端点：

```
https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}?period1=...&period2=...&interval=1d
```

无需 key、稳定、覆盖全球票（含 A 股 `600519.SS`、港股 `0700.HK`、加密 `BTC-USD`）。

### 1.4 烟测脚本

[scripts/smoke-finnhub.ts](scripts/smoke-finnhub.ts) —— 7 个端点逐个验证，每次改动后跑一遍：

```bash
bun run scripts/smoke-finnhub.ts URA   # 测 ETF
bun run scripts/smoke-finnhub.ts AAPL  # 测个股
```

---

## 2. 怎么启动

### 2.1 第一次配置

```bash
cd /Users/patrick/Projects/dexter

# 装 Bun（如果还没装）
curl -fsSL https://bun.com/install | bash

# 装依赖（含 playwright chromium ~91 MiB）
bun install
```

### 2.2 `.env` 至少要有

| key | 必要性 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ 必须 | 默认走 OpenAI 的 `gpt-5.5` |
| `FINNHUB_API_KEY` | ✅ 强烈建议 | 已从 IB/Option 项目复用 |
| `FINANCIAL_DATASETS_API_KEY` | ⚠️ 选填 | 仅为兜底；不设也能跑 |
| `IB_BRIDGE_URL` | ⚠️ 选填 | 设了就启用 IB 集成；不设则 `ib_portfolio` 工具不注册（见 §3） |

### 2.3 启动顺序

**模式 A：纯研究（无 IB 集成）—— 1 个终端**

```bash
cd /Users/patrick/Projects/dexter
bun start
```

**模式 B：带 IB 集成 —— 3 件事 + 2 个终端**

```bash
# (1) 在桌面打开 IB Gateway 应用，登录（readonly 模式）→ 监听 4001
#     不用终端做这步，是 GUI 操作

# 终端 1：起 options-tool 桥（HTTP 8000 → IB 4001 翻译层）
cd ~/Projects/IB/Option && uv run options-tool serve

# 终端 2：跑 Dexter
cd ~/Projects/dexter && bun start
```

> ⚠️ 端口区分：**4001 是 IB Gateway 自己的端口**（IB 二进制协议）；**8000 是 options-tool 桥的 HTTP 端口**（Dexter 通过这个跟 IB 通信）。Dexter 没法直接说 IB 协议，必须经过 8000 中转。

> 验证桥起来了：`curl -s http://127.0.0.1:8000/api/health` 返回 `{"status":"ok",...}` 就 OK。

### 2.4 其他常用命令

```bash
bun dev            # watch 模式（改代码自动重启）
bun run typecheck  # TS 类型检查
bun test           # 跑测试套
```

### 2.5 常用 slash 命令（CLI 内）

| 命令 | 作用 |
|---|---|
| `/model` | 切换 LLM provider 和具体模型 |
| `/rules` | 看 / 管理 `.dexter/RULES.md` 里的研究规则 |
| `/memory` | 看 Dexter 关于你的持久化记忆 |
| `/heartbeat` | 看周期性 checklist |
| `/history` | 看历史会话摘要 |
| `/clear` | 清当前对话 |
| `/help` | 快捷键和提示 |

### 2.6 调试 / 看日志

每次 query 在 `.dexter/scratchpad/` 留一份 JSONL，含每个 tool call 的入参、原始返回、LLM summary。诊断用：

```bash
ls -lt .dexter/scratchpad/ | head
cat .dexter/scratchpad/2026-05-03-XXX.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    e = json.loads(line)
    if e.get('type') == 'tool_result':
        print(e['toolName'], '→', json.dumps(e.get('result'))[:300])
"
```


## 3. IB Gateway 集成

启用后 Dexter 能查你**真实**的持仓、成本、期权链——通过本地 `~/Projects/IB/Option` 项目转一道 HTTP（只读，不下单）。

启动看 §2.3 模式 B。启动好以后在 Dexter 里直接问：

> "看下我 IB 里 URA 实际持仓和成本"
> "拉 URA Jun call 链找 delta 0.20-0.30 的合约"
> "我整个组合现货敞口按 intent 分组列一下"

持仓数据来自本地 DB，需要刷新就在 Option Web 面板点 Sync。Spot 和期权链是实时调 IB Gateway。

烟测：`bun run scripts/smoke-ib.ts URA`（需要先启动 bridge）。

---


## 4. 还想再上一档

| 投入 | 收益 |
|---|---|
| 注册 Tavily / Exa 免费 key（5 分钟） | Agent 能主动搜网，不用你给 URL |
| 付 Finnhub $30/月 | 解锁完整历史 K 线、深 metric 字段，绕开 Yahoo fallback |
| 付 Financial Datasets $49/月 | 全市场 + 深财报 + SEC 章节抽取 |
| Anthropic API key | 用 Claude 跑 compaction（更便宜更准）和重活；OpenAI 留 fast model |
