#!/bin/bash
# wx-router 安全重启看门狗（2026-09-28；2026-09-29 v2：探活走 /healthz，v2 起不来自动切回 v1）
#
# 为什么需要它：DSH 助手本身跑在 wx-router 里，重启 = 杀自己，
# 所以助手**无法**自己重启、也无法在重启后确认自己活没活。必须由
# 进程外的第三方来干这件事。
#
# 它做什么（按顺序）：
#   1. 拍一份当前 config.json 快照
#   2. 重启 wx-router.service（systemd 的 Restart=always 会兜底）
#   3. 等待并健康检查（HTTP 探活，最多 60 秒）
#   4. 健康 → 成功退出；不健康 → 回滚 config.json.good，再重启一次
#   5. 全过程写日志到 /home/aibox/.aibox/wx-router-guard.log
#
# 用法：
#   wx-router-guard.sh            # 正常重启并健康检查
#   wx-router-guard.sh --dry-run  # 只检查当前健康状态，不重启
#
# 注意：本脚本必须由**助手之外**的实体调用（助手自己调它会杀掉自己，
# 脚本虽能继续跑完，但助手那一轮对话就没了）。

set -uo pipefail

DIR=/home/aibox/wx-router
LOG=/home/aibox/.aibox/wx-router-guard.log
HEALTH_URL=http://127.0.0.1:8787/healthz
WAIT_MAX=60          # 健康检查最多等多少秒
UNIT=wx-router.service

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

# 2026-09-28 加：重启完主动给主人发一条微信。
# 为什么放在这里：助手本身跑在 wx-router 里，重启=杀自己，
# 所以助手**没法**自己报告重启结果（它那一轮已经没了，或者回来时已经晚了）。
# 必须由这个进程外的看门狗来报。主人不用再猜「到底成功没有」。
# wx-notify 直连 iLink，不经 wx-router，所以服务正在重启也能发出去。
notify() {
  local msg="$1"
  command -v node >/dev/null 2>&1 || { log "（无法通知：没有 node）"; return 0; }
  [ -x /home/aibox/bin/wx-notify.mjs ] || { log "（无法通知：没有 wx-notify.mjs）"; return 0; }
  # 最多重试 3 次：重启刚结束那几秒 iLink 可能还没准备好
  local i=0
  while [ $i -lt 3 ]; do
    if node /home/aibox/bin/wx-notify.mjs "$msg" >>"$LOG" 2>&1; then
      log "已通知主人 ✅"
      return 0
    fi
    i=$((i+1)); sleep 3
  done
  log "通知主人失败 ❌（已重试 3 次，不影响重启本身）"
  return 0
}

healthy() {
  # 能连上端口就认为活着；再等它稳定 2 秒确认不是启动瞬间
  curl -s -o /dev/null -m 3 -w '' "$HEALTH_URL" 2>/dev/null
  local rc=$?
  # 401/404 也算活着（服务在响应），只有连不上才算死
  if [ $rc -eq 0 ] || [ $rc -eq 22 ] || [ $rc -eq 52 ]; then
    sleep 2
    curl -s -o /dev/null -m 3 -w '' "$HEALTH_URL" 2>/dev/null
    local rc2=$?
    [ $rc2 -eq 0 ] || [ $rc2 -eq 22 ] || [ $rc2 -eq 52 ]
    return
  fi
  return 1
}

engine() { node -e 'try{console.log(require(process.argv[1]).engine||"v2")}catch{console.log("v2")}' "$DIR/config.json" 2>/dev/null || echo v2; }
set_engine() { node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.engine=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2))' "$DIR/config.json" "$1"; }

wait_healthy() {
  local i=0
  while [ $i -lt "$WAIT_MAX" ]; do
    if healthy; then return 0; fi
    sleep 2; i=$((i+2))
  done
  return 1
}

if [ "${1:-}" = "--dry-run" ]; then
  if healthy; then log "dry-run: 健康 ✅"; echo "健康 ✅"; exit 0
  else log "dry-run: 不健康 ❌"; echo "不健康 ❌"; exit 1; fi
fi

log "===== 开始安全重启 ====="
log "重启前状态: $(systemctl --user is-active "$UNIT" 2>/dev/null)"

# 1. 快照当前配置（回滚用）
if [ -f "$DIR/config.json" ]; then
  cp -f "$DIR/config.json" "$DIR/config.json.before-restart" 2>/dev/null \
    && log "已快照 config.json → config.json.before-restart"
fi

# 2. 重启
systemctl --user restart "$UNIT" 2>>"$LOG"
log "已发出 restart，等待健康检查（最多 ${WAIT_MAX}s）…"

# 3. 健康检查
if wait_healthy; then
  NEWPID=$(pgrep -f 'wx-router/(boot|proxy)\.mjs' | head -1)
  ENGINE=$(engine)
  log "结果: 重启成功，服务健康 ✅"
  log "新 PID: $NEWPID 引擎: $ENGINE"
  notify "✅ wx-router 重启成功
时间：$(date '+%m-%d %H:%M:%S')
新 PID：$NEWPID
引擎：$ENGINE
健康检查：通过（60 秒内连上）"
  exit 0
fi

# 4. 不健康 → 回滚
log "结果: 健康检查失败 ❌ 开始回滚"
# 4a. v2 起不来 → 先切回 v1 老引擎（代码原样保留在 proxy.mjs）
if [ "$(engine)" != "v1" ]; then
  set_engine v1 && log "已切回 v1 引擎（config.json engine=v1）"
  systemctl --user restart "$UNIT" 2>>"$LOG"
  if wait_healthy; then
    log "切回 v1 后恢复健康 ⚠️"
    notify "⚠️ wx-router 新引擎 v2 没起来，已自动切回老引擎 v1
时间：$(date '+%m-%d %H:%M:%S')
现在：服务正常（v1），新功能暂时不可用，需要排查。日志：/home/aibox/wx-router/router.log"
    exit 2
  fi
fi
if [ -f "$DIR/config.json.good" ]; then
  cp -f "$DIR/config.json.good" "$DIR/config.json" && log "已回滚 config.json ← config.json.good"
else
  log "警告: 没有 config.json.good，无法回滚配置"
fi
systemctl --user restart "$UNIT" 2>>"$LOG"
log "已回滚重启，再等健康检查…"

if wait_healthy; then
  log "回滚后恢复健康 ⚠️（配置已退回 good 版，请检查刚才的改动）"
  notify "⚠️ wx-router 重启异常，但已自动回滚恢复
时间：$(date '+%m-%d %H:%M:%S')
情况：新配置健康检查没过 → 已回滚 config.json.good 并重启成功
现在：服务活着，但刚才那次改动**没生效**，需要排查"
  exit 2
fi

log "回滚后仍不健康 ❌❌ 需要人工介入"
notify "❌❌ wx-router 重启失败，回滚也没救回来
时间：$(date '+%m-%d %H:%M:%S')
情况：新配置不健康 → 回滚 config.json.good → 仍然不健康
**需要你介入**。查日志：/home/aibox/.aibox/wx-router-guard.log"
exit 3
