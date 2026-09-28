# AI Box 网关 v2 · 架构

> 给要改这个网关的人和 AI 看。先读这一页，再动代码。

## 一句话

网关是插在 **OpenClaw 微信插件** 和 **腾讯 iLink** 之间的透明代理（`127.0.0.1:8787`）。
归它管的消息（DSH / 本地模型模式、命令）从 `getupdates` 响应里摘出来自己处理，其余原样还给 OpenClaw。

```
微信 ──▶ iLink ◀──▶ 网关 :8787 ◀──▶ OpenClaw 微信插件
                       │
                       ├─ 命令（/进度 /经理 /话题 /进化 …）
                       ├─ 入站管道（去重 → 信号 → 计数 → 切错了 → 叫停 → 经理 → 改方向 → 派发）
                       └─ 一轮对话流水线 ──▶ DSH 工人（dsh --profile headless --json）
                       
面板 :80（aibox-dashboard.py）──反代──▶ 网关 API 127.0.0.1:8788 /api/v2/*
```

## 目录

```
boot.mjs              启动器：config.json 的 engine = v2（默认）| v1（老 proxy.mjs，回滚用）
proxy.mjs 等根目录 .mjs  v1 老代码，原样保留，别改
src/
  main.mjs            装配插件、入站调度、起代理
  core/
    config.mjs        唯一配置入口：路径全从 AIBOX_HOME 推导；DEFAULTS + config.json + tunables.json；启动校验
    app.mjs           插件注册中心（挂点见下）
    log.mjs           router.log（人看）+ events.jsonl（机器看，结构化、打码、无原文）
    store.mjs         JSON 状态文件读写（原子写）
    llm.mjs           快模型/responses 客户端（经理、话题裁判、复盘共用）
  channel/wechat.mjs  iLink 代理、发文字/文件、收媒体、主动通知主人
  agent/
    turn.mjs          一轮对话的流水线骨架 + 对外的 agent API（answer / enqueue / interrupt …）
    dsh.mjs           起 DSH 进程、读事件流、看门狗（卡死才杀）、Go→DeepSeek 线路
    runs.mjs          可中断运行的登记表（runId + generation 租约）
    queue.mjs         每个聊天一条优先级队列
    session.mjs       会话表 / 元数据 / 模式（与 v1 同一份文件，可随时互切）
    prompts.mjs       给工人的固定话术
  plugins/            功能插件（每个都能在 config.features 里关掉）
  manager/core.mjs    经理的大脑（决策、信箱、提问、话题裁判）
  memory/             话题路由 threads.mjs、往回拆话题 topic-split.mjs
  observe/            live.mjs（dsh-live.json）、metrics.mjs（按天指标）
  evolve/             自进化：signals / tunables / retro / proposals
  vendor/             叫停、改向的硬规则（纯正则）
test/                 回放测试台（假 iLink / 假插件 / 假 DSH / 假模型），node test/run.mjs
```

## 插件挂点（src/core/app.mjs）

| 挂点 | 用途 | 例子 |
|---|---|---|
| `command({names, help, modes, pattern, handle})` | 整句精确匹配的微信命令 | `/进度`、`/批准 3` |
| `ingress(order, name, fn)` | 入站管道，`fn(ctx)` 返回 `'consume'` 吃掉 / `'keep'` 放行给 OpenClaw / 其它 = 交给下一个 | 叫停@50、经理@60 |
| `stage(name, order, fn)` | 一轮对话流水线的阶段 | 交接包注入 context@10 |
| `status(fn)` | `/mode` 回执里的状态行 | 话题、上下文水位 |
| `every(ms, fn)` | 定时任务 | 信箱补交、每晚复盘 |
| `api(name, fn)` | 面板 API `GET /api/v2/<name>` | topics、evolve |
| `listen/notify` | 插件间进程内通知 | `'new'`、`'preempt'` |

入站管道顺序（order）：命令（最先）→ 30 去重 → 33 信号 → 34 计数 → 36 记住最后一条 → 40 切错了 → 50 叫停 → 60 经理 → 70 改方向 → 80 本地模型 → 90 DSH 排队。

一轮对话流水线（`turn`）：

| 阶段 | 挂的东西（插件@order） |
|---|---|
| input | core@10 语音并入文字、下载图片/文件 |
| turnStart | core@10 面板登记运行；progress@20 开进度播报 |
| route | core@5 撤回重答前缀；topics@10 话题归属（可能整体换 sid/meta） |
| session | core@10 读会话/失配冷切；handoff@20 该不该换会话（日切/闲置/上下文）；core@90 计数 |
| context | handoff@10 交接包注入；recall@20 交接目录；core@30 话题前缀；helpers@40 外援提醒 |
| run | core@50 跑 DSH（Go 失败→DeepSeek；会话丢了→新会话）；被打断则 `stop` |
| afterRun | progress@1 停播报；core@5 刷额度；handoff@10 消费交接包；core@20 存 sid；handoff@30 上下文水位 |
| deliver | core@50 发文字 + 文件（或说明为什么没内容） |
| afterReply | topics@10 记回复；core@20 结束运行；manager@30 告诉经理；core@90 日志/事件 |
| reset（/new） | topics@10 开新话题；core@50 清会话 |

**顺序有讲究**：交接包必须在存新 sid 之前消费（afterRun 10 < 20），否则会被带进新会话元数据。

## 状态文件（全在 `AIBOX_ROOT`，默认 /home/aibox/wx-router，与 v1 共用）

`modes.json` · `dsh-sessions.json` · `dsh-session-meta.json` · `dsh-threads.json` · `dsh-live.json` · `go-state.json` · `tunables.json`（自进化 L1）

其它：`~/.aibox/logs/events.jsonl`（结构化事件）、`~/.aibox/evolve/`（指标、信号、复盘报告、提案）、`~/.aibox/mgr/`（经理信箱/提问）。

## 改代码的规矩

1. **能写成插件就别动核心**（`src/core`、`src/agent`）。新功能 = 新文件 `src/plugins/xxx.mjs` + 在 `main.mjs` 里 `app.use`。
2. 改完跑 `node test/run.mjs`（约 1 分钟），全过才能上线；新功能补一个场景到 `test/scenarios/`。
3. 用户看得到的话术集中在插件里；给工人的固定话术在 `agent/prompts.mjs`。
4. 事件里不放原文、聊天 id 只露前 6 位（`tag()`），文本过 `mask()`。
5. 不许动：叫停规则（`vendor/stop-rules.mjs`）、工人权限、凭证。
6. 上线：`git commit` → 看 DSH 空闲 → `systemd-run --user --collect /home/aibox/bin/wx-router-restart-now.sh`（看门狗健康检查，不健康自动回滚到 v1）。
