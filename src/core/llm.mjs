/**
 * 轻量模型客户端（经理、话题裁判、自进化复盘共用）。密钥从 ~/.dsh/.credentials.yaml 读，从不打印。
 *   chat(messages)            快模型（Go deepseek-v4.1-flash，关思考）→ 挂了走 DeepSeek 官方；返回 { text, route }
 *   responses(model, input)   Go 的 /responses 协议（gpt-6-luna、grok 只能走这个）
 * 每次调用记一条 llm.call 事件（模型、耗时、成败），面板和自进化用来看成本。
 */
import fs from 'node:fs';
import { cfg, paths } from './config.mjs';
import { emit } from './log.mjs';

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

export function key(name) {
  try {
    const s = fs.readFileSync(paths.credentials, 'utf8');
    const m = s.match(new RegExp('^\\s*' + name + ':\\s*(\\S+)', 'm'));
    return m ? m[1].replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

function routes(session) {
  const L = cfg.llm;
  return [
    { name: 'go', url: L.goBase + '/chat/completions', model: L.managerModel, key: 'OPENCODE_GO_API_KEY', extra: { thinking: { type: 'disabled' } }, headers: { 'x-opencode-session': session } },
    { name: 'deepseek', url: L.deepseekBase + '/chat/completions', model: L.deepseekModel, key: 'DEEPSEEK_API_KEY', extra: { thinking: { type: 'disabled' } }, headers: {} },
  ];
}

export async function chat(messages, { session = 'ses_aibox_manager', maxTokens = 700, json = true, timeoutMs = 20000, purpose = 'manager' } = {}) {
  let lastErr = null;
  for (const r of routes(session)) {
    const k = key(r.key); if (!k) continue;
    const t0 = Date.now();
    try {
      const res = await fetch(r.url, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + k, ...r.headers },
        body: JSON.stringify({ model: r.model, messages, max_tokens: maxTokens, temperature: 0.4, ...(json ? { response_format: { type: 'json_object' } } : {}), ...r.extra }),
      });
      const j = await res.json().catch(() => ({}));
      const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      emit('llm.call', { purpose, route: r.name, model: r.model, ok: !!(res.ok && c), ms: Date.now() - t0, status: res.status });
      if (res.ok && c) return { text: c, route: r.name };
      lastErr = 'HTTP ' + res.status + ' ' + cut(JSON.stringify(j.error || j), 160);
    } catch (e) {
      emit('llm.call', { purpose, route: r.name, model: r.model, ok: false, ms: Date.now() - t0, error: cut(e.message, 80) });
      lastErr = String((e && e.message) || e);
    }
  }
  throw new Error('经理模型都不可用：' + lastErr);
}

export async function responses(model, input, { session = 'ses_aibox_topicjudge', maxTokens = 1500, effort = 'low', timeoutMs = 45000, purpose = 'judge' } = {}) {
  const k = key('OPENCODE_GO_API_KEY'); if (!k) throw new Error('no key');
  const t0 = Date.now();
  let ok = false;
  try {
    const r = await fetch(cfg.llm.goBase + '/responses', {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + k, 'x-opencode-session': session },
      body: JSON.stringify({ model, input, max_output_tokens: maxTokens, reasoning: { effort } }),
    });
    const j = await r.json();
    const txt = j.output_text || (j.output || []).flatMap((o) => (o.content || []).map((c) => c.text || '')).join('');
    if (!r.ok || !txt) throw new Error('HTTP ' + r.status + ' ' + cut(JSON.stringify(j.error || j), 120));
    ok = true;
    return txt;
  } finally {
    emit('llm.call', { purpose, route: 'go', model, ok, ms: Date.now() - t0 });
  }
}
