#!/usr/bin/env node
// steer-rules.mjs —— 判定「改方向/补充」意图（方案甲的触发规则）
// 2026-09-28 建；同日按 Claude 审查意见重修。原版误伤严重：
//   `别` 是子串匹配 → 「特别好」「区别在哪」都触发打断；
//   PREFIX 里的 `还有` → 「还有多久」触发；只在句末查疑问 → 「改成什么了」漏网。
// 纯正则，零 token 成本，不调模型。
//
// 设计原则：宁可漏判，不可误判。
//   漏判 → 走原有排队逻辑，用户多等（可接受）
//   误判 → 打断正在好好跑的任务（不可接受）
// 判定顺序：先排雷（疑问/否定/元讨论/叫停词），再认正。

// ---------- 先排雷：命中就绝不触发 ----------

// 疑问语境（全句匹配，不只看句末）—— 用户在问，不是在改
const QUESTION_ANY = /(多久|几步|几个|几分|什么|怎么|为什么|为啥|哪里|哪个|哪一|是不是|有没有|行不行|进度|好了吗|完了吗)/;
// 句末语气词：吗/呢/?/？/啊/嘛（「改成python吧」要保留，所以不排「吧」）
const QUESTION_TAIL = /(吗|呢|\?|？|啊|嘛)\s*$/;

// 否定/劝阻语境 —— 这是在安抚或讨论，不是在改方向
const NEG_RE = /(别停|不要停|不用停|先别停|不用急|不用管我|慢慢来|不着急|别着急)/;
// 「不用」只在句首且不接 急/谢/管我/麻烦/了 时才算祈使
const BUYONG_SAFE = /^不用(急|谢|管我|麻烦|了)/;

// 讨论/引用语境 —— 含这些词说明在说别的（原版误伤的主因）
const META_RE = /(补充说明|补充材料|补充协议|特别|区别|别人|别的|分别|个别|告别|性别|识别|辨别)/;

// ---------- 再认正 ----------

// 明确的补充、改向词（必须在句首）
const STEER_PREFIX = /^(补充|补充一下|补一个|补一句|补个|另外|顺便|再加|再补|改成|改一下|改为|换成|换一个|重来|重做|方向错了|搞错|不是这个|不对|先做|先看|先跑|先别|换个思路|我是说|我的意思是|应该是|错了)/;

// 祈使/修正类动词 —— 只匹配句首，绝不做子串匹配
// 注意「先别」要放在这里：它是「先别动数据库」= 改方向（去做别的），而不是叫停整个任务。
// 真正的叫停是「停/别做了」，由 stop-rules.mjs 的 isHardStop 处理，两条规则不重叠。
const STEER_VERB_HEAD = /^(别|不要|不用|改成|换成|先做|先看|先跑|先别|重来|重做|调一下|改一下|加一个|加上|记得|也要|要用)/;

const MAX_LEN = 40;    // 超过就认为在正常提问/长指令，走排队
const SHORT_LEN = 20;  // 走 VERB 判定路径的短消息上限

function isSteer(raw, opts = {}) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return false;
  if (s.length > (opts.maxLen || MAX_LEN)) return false;   // 太长 → 不当改向
  if (s.startsWith('/')) return false;                     // 命令 → 交给命令分支

  // —— 排雷 ——
  if (QUESTION_ANY.test(s)) return false;                  // 全句疑问词
  if (QUESTION_TAIL.test(s)) return false;                 // 句末疑问语气
  if (NEG_RE.test(s)) return false;                        // 「别停」类安抚
  if (BUYONG_SAFE.test(s)) return false;                   // 「不用急」类
  if (META_RE.test(s)) return false;                       // 元讨论 / 含「别」的普通词
  if (/^(暂停|停下)/.test(s)) return false;                // 归叫停规则管，不该重跑

  // —— 认正 ——
  if (STEER_PREFIX.test(s)) return true;                   // 明确补向前缀
  if (s.length <= (opts.shortLen || SHORT_LEN) && STEER_VERB_HEAD.test(s)) return true;

  return false;
}

export { isSteer };
export default { isSteer };

// ------------------------- 自测 -------------------------
if (process.argv.includes('--selftest')) {
  const SHOULD_STEER = [
    '补充：先做登录',
    '补充一下，还要加上导出',
    '另外把日志也加上',
    '改成先跑测试',
    '换成 python 写',
    '重来',
    '方向错了',
    '不对，应该是另一个文件',
    '先做接口',
    '先别动数据库',
    '换个思路',
    '别管那个了',
    '不要用 redis',
    '先跑一下测试',
    '再加一个按钮',
    '顺便把文档更新了',
    '改为每天凌晨跑',
    '我是说用另一个方案',
    '我的意思是先做后端',
    '错了，文件路径不对',
    '记得加错误处理',
    '也要处理空值',
  ];
  const SHOULD_NOT = [
    '补充说明一下这个是什么意思？',
    '现在是第几步了？',
    '你还在跑吗',
    '进度怎么样呢',
    '别停，继续',
    '不要停',
    '补充材料在哪里',
    '帮我写一个完整的用户登录注册系统，要用 JWT 并且支持刷新令牌',
    '/new',
    '/进度',
    '',
    '   ',
    '这个方案你觉得可行吗？',
    '刚才那个文件里写的什么',
    '为什么不用 redis 呢',
    '补充：这是一个很长很长的消息用来测试长度限制是否能够正确地把过长的内容排除在改方向判定之外',
    // ---- Claude 指出的误伤（原版全部会错误触发）----
    '不用急，慢慢来',
    '好的不用管我',
    '特别好',
    '区别在哪',
    '别人说的',
    '还有多久',
    '还有几步',
    '改成什么了',
    '顺便问下进度',
    '暂停一下',
    '停下',
    '分别处理一下',
    '识别一下这个图片',
    '告别仪式怎么弄',
    '性别字段要加吗',
    // ---- 其他常见疑问 ----
    '还要多久才能好',
    '这个要改吗',
    '是不是有问题',
    '有没有更好的办法',
  ];
  let pass = 0, fail = 0;
  for (const s of SHOULD_STEER) {
    if (isSteer(s)) { pass++; } else { fail++; console.log('❌ 应触发但未触发: ' + JSON.stringify(s)); }
  }
  for (const s of SHOULD_NOT) {
    if (!isSteer(s)) { pass++; } else { fail++; console.log('❌ 不应触发但触发了: ' + JSON.stringify(s)); }
  }
  console.log(`\n自测结果: ${pass}/${pass + fail} ${fail === 0 ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(fail === 0 ? 0 : 1);
}
