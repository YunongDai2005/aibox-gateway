/**
 * 回忆提示：新会话首条 / 主人提到以前的事（RECALL_RE）时，把交接目录 handoffs/INDEX.md 附在消息前，
 * 并按关键词重叠预筛出最像的 3 份放最前面。读不读哪份由 DSH 按 recall 技能自己判断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../core/config.mjs';
import { log, emit, tag } from '../core/log.mjs';

const RECALL_RE = new RegExp(cfg.recallKeywords || (
  '之前|以前|上次|上回|上上回|昨天|前天|前几天|那天|早先|当初|原来|刚刚|刚才|' +
  '上周|上个月|这周|这几天|前阵子|很久以前|最早|最开始|' +
  '还记得|记得吗|记不记得|你忘|忘了|我说过|你说过|我们说过|我们聊过|提过|' +
  '我们做过|做过的|弄过|搞过|那个|那件事|那个东西|那个项目|我们说的|刚才说的|' +
  '接着|继续|继续那个|接着做|接着弄|接着上次|' +
  '怎么样|怎样了|弄好|搞好|做完了吗|做完了没|搞定了吗|搞定没|结果呢|进展|进度|' +
  '怎么弄的|怎么做的|怎么搞的|再说一遍|再讲一遍|教我|回顾|总结一下|梳理'
), 'i');
const indexFile = () => path.join(cfg.dshCwd, 'handoffs', 'INDEX.md');

function indexDigest() {
  try {
    const t = fs.readFileSync(indexFile(), 'utf8');
    const rows = t.split('\n').filter((l) => l.startsWith('## ') || (l.startsWith('| ') && !l.startsWith('| # ') && !l.startsWith('| 周 ')));
    if (!rows.some((l) => l.startsWith('| '))) return '';
    let out = '';
    for (const l of rows) { if (out.length + l.length > cfg.recallIndexChars) { out += '…（更多见 handoffs/INDEX.md）\n'; break; } out += l + '\n'; }
    return out;
  } catch { return ''; }
}

// 中文没空格：ASCII 词按标点切；中文切成 2 字滑窗（bigram）
function recallTokens(s) {
  const txt = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of txt.split(/[\s，。、！？；：（）()\[\]「」『』,.;:!?~…—-]+/)) if (w.length >= 2 && /[a-z0-9]/.test(w)) out.add(w);
  const cjk = txt.replace(/[^一-龥]+/g, ' ');
  for (const seg of cjk.split(/\s+/)) for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  return out;
}
const RECALL_STOP = new Set(['那个','这个','怎么','什么','现在','已经','可以','帮我','一下','我们','你们','他们','的时','时候','不是','就是','还有','没有','知道','告诉','看看','咱们']);

export function rankHandoffs(userText, topN = 3) {
  try {
    const t = fs.readFileSync(indexFile(), 'utf8');
    const rows = t.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| # ') && !l.startsWith('| 周 ') && !/^\|\s*-+/.test(l));
    const toks = recallTokens(userText);
    if (!toks.size) return [];
    const scored = [];
    for (const l of rows) {
      const cells = l.split('|').map((s) => s.trim()).filter(Boolean);
      if (cells.length < 4) continue;
      const hay = cells.slice(1).join(' ').toLowerCase();
      let hit = 0; const which = [];
      for (const w of toks) {
        if (RECALL_STOP.has(w)) continue;
        if (hay.includes(w)) { hit++; if (which.length < 5) which.push(w); }
      }
      if (hit > 0) scored.push({ hit, line: l.trim(), which: which.join('、'), link: (l.match(/\(([^)]+\.md)\)/) || [])[1] || '' });
    }
    scored.sort((a, b) => b.hit - a.hit);
    return scored.slice(0, topN);
  } catch { return []; }
}

export function attachIndex(text, why) {
  const d = indexDigest();
  if (!d) return text;
  let lead = '';
  const rk = rankHandoffs(text, 3);
  if (rk.length) {
    lead = '\n【系统预筛 — 跟这句最像的几份（按关键词重叠，仅供参考，别硬套）】\n' +
      rk.map((r) => '- ' + r.link + '（命中：' + r.which + '）').join('\n') + '\n';
  }
  return '【交接目录 — 系统自动附上（' + why + '）。当前会话里没有的往事，按 recall 技能去查：cat ' + path.join(cfg.dshCwd, 'handoffs') + '/<文件>；与本条无关就忽略，别在回复里提这段】\n' +
    lead + d + '\n' + text;
}

export default {
  name: 'recall', desc: '提到以前的事时，自动附上交接目录',
  setup(app) {
    // context@20：在交接包注入之后、话题前缀之前
    app.stage('context', 20, (T) => {
      const why = T.fresh ? '新会话' : RECALL_RE.test(T.userText) ? '你提到了以前的事' : T.forceRecall ? '主人说话题放错了' : null;
      if (!why) return;
      const before = T.text;
      T.text = attachIndex(T.text, why);
      if (T.text !== before) { log('recall index attached chat=' + T.chat + ' why=' + why); emit('recall.attached', { chat: tag(T.chat), why }); }
    });
  },
};
