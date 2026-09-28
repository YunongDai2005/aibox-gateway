#!/usr/bin/env node
/**
 * claude-reset：把 Claude 限流提示里的「恢复时间」解析成机器可读的 ISO 时间戳。
 *
 * 为什么需要：ask-claude.mjs 原本只存人类可读的 resetText（如 "3:40am (Asia/Shanghai)"），
 * aibox-quota.mjs 拿它没法比较，导致状态永久卡在 limited:true、面板永远显示没额度。
 *
 * 关键点：跨天判断的基准是「探测时刻」(refMs)，不是「读取时刻」。
 *   例：探测于上海 9/28 00:41，提示 "3:40am" → 下一个 3:40am 是 9/28 03:40（未来）→ 当天。
 *       探测于上海 9/27 20:00，提示 "3:40am" → 9/27 03:40 已过 → 9/28 03:40。
 *
 * 用 Intl.DateTimeFormat 做时区换算：先求基准时刻在某时区的墙上时间，
 * 再反解「该时区某墙上时间」对应的 UTC 毫秒（两次逼近，处理 DST/the offset 变化）。
 */

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** 求 ms 时刻在 tz 时区的墙上时间各字段 */
function parts(tz, ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') o[p.type] = p.value;
  }
  // hour12:false 在部分 ICU 下会把午夜给成 24，归一到 0
  let h = +o.hour; if (h === 24) h = 0;
  return { year: +o.year, month: +o.month, day: +o.day, hour: h, minute: +o.minute, second: +o.second };
}

/** 反解：tz 时区的墙上时间 (y,m,d,h,mi) → UTC 毫秒。m 是 0-based。 */
function zonedToUtc(tz, y, m, d, h, mi) {
  // 先粗猜：把墙上时间当 UTC
  let guess = Date.UTC(y, m, d, h, mi, 0);
  // 两次逼近：用该时刻在 tz 的实际墙上时间与目标的差值修正
  for (let i = 0; i < 3; i++) {
    const p = parts(tz, guess);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(y, m, d, h, mi, 0);
    const diff = want - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/**
 * 从一段文本里抽出恢复时间短语，如 "3:40am (Asia/Shanghai)"、"resets at 5pm (UTC)"。
 * 返回短语字符串或 null。
 */
export function extractResetText(text) {
  if (!text) return null;
  const t = String(text);
  const pats = [
    /resets?\s*(?:at\s*)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?\s*\([^)]+\))/i,
    /resets?\s*(?:at\s*)?([0-9]{1,2}:[0-9]{2}\s*(?:am|pm)?)/i,
    /([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)\s*\([^)]+\))/i,
    /([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm))/i,
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * 解析恢复时间为 ISO 字符串。
 * @param {string} text 形如 "3:40am (Asia/Shanghai)"，也可以是一段包含它的长文本
 * @param {number} refMs 探测时刻（跨天判断的基准）
 * @returns {string|null} ISO 时间串；解析不了返回 null
 */
export function parseResetAt(text, refMs) {
  if (!text) return null;
  const ref = Number.isFinite(refMs) ? refMs : Date.now();
  const phrase = extractResetText(text) || String(text);
  // 匹配：[月 日] [时[:分]] [am/pm] [(时区)]
  const m = phrase.match(
    /^(?:([a-z]{3,9})\.?\s+([0-9]{1,2})\s+)?([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?\s*$/i
  );
  if (!m) return null;
  let h = +m[3];
  const mi = +(m[4] || 0);
  const ap = (m[5] || '').toLowerCase();
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'pm' ? 12 : 0); }
  if (h > 23 || mi > 59) return null;
  const tz = (m[6] || 'UTC').trim();
  try {
    const now = parts(tz, ref); // 时区非法会抛 RangeError
    let t;
    if (m[1]) { // 带日期（月份名 + 日）
      const mo = MON[m[1].toLowerCase()];
      if (mo === undefined) return null;
      t = zonedToUtc(tz, now.year, mo, +m[2], h, mi);
      if (t < ref - 86400e3) t = zonedToUtc(tz, now.year + 1, mo, +m[2], h, mi); // 跨年
    } else { // 只有钟点：今天这个点已过 → 明天
      t = zonedToUtc(tz, now.year, now.month - 1, now.day, h, mi);
      if (t <= ref) t = zonedToUtc(tz, now.year, now.month - 1, now.day + 1, h, mi);
    }
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  } catch { return null; }
}

export const _internals = { parts, zonedToUtc };

// 直接跑时自测：node claude-reset.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = [
    ['3:40am (Asia/Shanghai)', '2026-09-27T16:41:06Z', '2026-09-27T19:40:00.000Z'],
    ['3:40am (Asia/Shanghai)', '2026-09-27T20:00:00Z', '2026-09-28T19:40:00.000Z'],
    ['resets at 5pm (UTC)', '2026-09-27T10:00:00Z', '2026-09-27T17:00:00.000Z'],
    ['12:00am (Asia/Shanghai)', '2026-09-27T10:00:00Z', '2026-09-27T16:00:00.000Z'],
  ];
  let bad = 0;
  for (const [txt, ref, want] of cases) {
    const got = parseResetAt(txt, Date.parse(ref));
    const okMark = got === want ? '✅' : '❌';
    if (got !== want) bad++;
    console.log(`${okMark} ${txt} @ ${ref} → ${got}  (期望 ${want})`);
  }
  console.log(bad ? `\n${bad} 条不符` : '\n全部通过');
  process.exit(bad ? 1 : 0);
}
