#!/usr/bin/env node
/**
 * stop-rules：判断一条微信消息是不是「明确叫停」。
 * 第一阶段只认确定性规则（纯正则，不走模型），宁可漏判也不能误判 ——
 * 误判会把正在正常干活的任务杀掉，代价远大于漏判（漏判只是晚一点停）。
 *
 * 用法：import { isHardStop } from '/home/aibox/bin/stop-rules.mjs'
 *       node stop-rules.mjs "先别做了"   → 打印 yes/no（自测）
 */

// 1) 明确叫停的核心动词
const STOP_WORDS = [
  '停下', '停止', '停一下', '先停', '别做', '别弄', '别搞', '别继续', '不要继续',
  '别干', '先别', '算了', '取消', '中止', '中断', '打住', '住手', '停了', '停吧',
  '不用了', '不要了', '别写了', '别改了', '回来', '停',
];
const STOP_RE = new RegExp('(' + STOP_WORDS.join('|') + ')');

// 2) 否定/假设/引用 —— 出现这些一律不算叫停
//    「不要停止」「别停」「他说先别做了」「如果不行就停」「不用担心」
//    「停不下来」「停不了」也算否定
const NEG_RE = /(不要|不用|别|请勿|无需|不必|不准)\s*(停|停止|停下|停手|终止|取消|中断)/;
const CANT_RE = /(停不下|停不了|停不掉|停不住|没法停|不能停|无法停|舍不得停)/;
const COND_RE = /(如果|若是|要是|万一|假如|一旦|否则)/;
const QUOTE_RE = /(他说|你说|他说过|说的是|意思是|什么叫|什么意思|那句|引号|原文|quote)/;
// 疑问才排除。「吧」在祈使句里很常见（「停吧」），只有「吗/呢/?」才是问
const QUESTION_RE = /(吗|呢|\?|？)\s*$/;

// 3) 委派式否定：「不用担心」「不着急」这类只是安抚
const REASSURE_RE = /(不用|不必|别)\s*(担心|着急|急|管|理会|在意)/;

// 4) 纯粹的「停」字但指的是别的意思：停车、停水、停电、停机
const FALSE_STOP_RE = /(停车|停水|停电|停机|停产|停业|停售|停运|不停|暂停服务|停靠)/;

export function isHardStop(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (s.length > 30) return false;            // 叫停都很短；长句多半是在交代事情
  if (!STOP_RE.test(s)) return false;          // 根本没有叫停词
  if (NEG_RE.test(s) || CANT_RE.test(s)) return false;
  if (QUOTE_RE.test(s) || COND_RE.test(s)) return false;
  if (REASSURE_RE.test(s)) return false;
  if (FALSE_STOP_RE.test(s)) return false;
  if (QUESTION_RE.test(s)) return false;       // 「停了吗？」是在问，不是命令
  return true;
}

export default { isHardStop };

// ---------- 自测 ----------
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const should = [
    // 该叫停
    ['停', true], ['停停', true], ['停下', true], ['先停一下', true],
    ['先别做了', true], ['不要继续了', true], ['取消这个', true], ['算了别弄了', true],
    ['别干了', true], ['打住', true], ['不用了', true], ['停吧', true],
    ['别改了我看看', true], ['中止吧', true],
    // 不该叫停
    ['不要停止', false], ['别停', false], ['停不下来', false],
    ['他说先别做了', false], ['他说的"别做了"是什么意思', false],
    ['如果不行就停', false], ['万一卡住就停下', false],
    ['不用担心', false], ['不着急慢慢来', false],
    ['停了吗', false], ['是不是停了？', false],
    ['停车位找到了吗', false], ['小区停电了', false],
    ['帮我把日志整理一下，顺便看看有没有报错，不急', false],
    ['', false],
  ];
  let bad = 0;
  for (const [text, want] of should) {
    const got = isHardStop(text);
    const ok = got === want;
    if (!ok) bad++;
    console.log((ok ? 'PASS' : 'FAIL') + '  [' + (want ? '该停' : '不该停') + '] ' + JSON.stringify(text) + ' → ' + (got ? '停' : '不停'));
  }
  console.log(bad === 0 ? '\n全部通过（' + should.length + ' 条）' : '\n失败 ' + bad + ' 条');
  process.exit(bad === 0 ? 0 : 1);
}
