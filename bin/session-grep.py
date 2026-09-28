#!/usr/bin/env python3
"""session-grep：在 DSH 会话原文里找以前说过的话（recall 技能的第 3 步）。
2026-09-27 Mac 端 Claude 写。只读，不改任何会话文件。

  session-grep.py 关键词 [关键词2 ...]      # 所有词都出现的对话片段（用户+助手），新的在前
  session-grep.py --list                     # 列出所有会话：时间、标题、条数
  session-grep.py --show <会话ID前缀> [--from N --to M]   # 打印某个会话的对话（只含人和助手的文字）
选项：--dir 会话目录（默认 dsh-work 的）  --limit 每次最多条数（默认 20）  --all-dirs 搜全部工作目录
"""
import argparse, glob, json, os, subprocess, sys, time

BASE = os.path.expanduser('~/.dsh/sessions')
DEFAULT_DIR = os.path.join(BASE, '--home-aibox-dsh-work--')


def load(sess_dir):
    f = os.path.join(sess_dir, 'session.v4.jsonl.zstd')
    if not os.path.exists(f):
        return None
    try:
        raw = subprocess.run(['zstdcat', f], capture_output=True, timeout=60).stdout.decode('utf-8', 'replace')
    except Exception:
        return None
    sid, title, created, msgs = os.path.basename(sess_dir), '', 0, []
    for line in raw.splitlines():
        try:
            j = json.loads(line)
        except Exception:
            continue
        t = j.get('type')
        if t == 'session':
            created = j.get('createdAt', 0)
        elif t == 'session/title':
            title = j.get('data', {}).get('title', title)
        elif t == 'user/message':
            txt = ''.join(c.get('text', '') for c in j.get('data', {}).get('content', []) if c.get('type') == 'text')
            if txt.strip():
                msgs.append(('用户', j.get('time', 0), txt))
        elif t == 'assistant/message':
            m = j.get('data', {}).get('message', {})
            txt = ''.join(c.get('text', '') for c in m.get('content', []) if c.get('type') == 'text')
            if txt.strip():
                msgs.append(('助手', j.get('time', 0), txt))
    return {'sid': sid, 'title': title, 'created': created, 'msgs': msgs}


def ts(ms):
    return time.strftime('%Y-%m-%d %H:%M', time.localtime(ms / 1000)) if ms else '?'


def sessions(dirs):
    out = []
    for d in dirs:
        for s in glob.glob(os.path.join(d, '*/')):
            r = load(s.rstrip('/'))
            if r:
                r['dir'] = d
                out.append(r)
    return sorted(out, key=lambda r: r['created'], reverse=True)


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('words', nargs='*')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--show')
    ap.add_argument('--from', dest='frm', type=int, default=0)
    ap.add_argument('--to', type=int, default=10**9)
    ap.add_argument('--dir', default=DEFAULT_DIR)
    ap.add_argument('--all-dirs', action='store_true')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--width', type=int, default=300, help='每条片段最多字数')
    a = ap.parse_args()
    dirs = glob.glob(os.path.join(BASE, '*/')) if a.all_dirs else [a.dir]
    ss = sessions(dirs)
    if a.list:
        for s in ss:
            print(f"{ts(s['created'])}  {s['sid']}  {len(s['msgs'])}条  {s['title'][:40]}")
        return
    if a.show:
        s = next((s for s in ss if s['sid'].startswith(a.show) or s['sid'].startswith('session-' + a.show)), None)
        if not s:
            sys.exit('没找到会话 ' + a.show)
        print(f"# {s['sid']}  {ts(s['created'])}  {s['title']}")
        for i, (who, t, txt) in enumerate(s['msgs']):
            if a.frm <= i <= a.to:
                print(f"\n[{i}] {who} {ts(t)}\n{txt[:4000]}")
        return
    if not a.words:
        ap.print_help()
        return
    ws = [w.lower() for w in a.words]
    n = 0
    for s in ss:
        for i, (who, t, txt) in enumerate(s['msgs']):
            low = txt.lower()
            if all(w in low for w in ws):
                p = max(0, low.find(ws[0]) - a.width // 3)
                snip = txt[p:p + a.width].replace('\n', ' ')
                print(f"{ts(t)}  {s['sid'][:16]}  [{i}] {who}：…{snip}…")
                n += 1
                if n >= a.limit:
                    print(f'（已到 {a.limit} 条上限，加 --limit 或换更具体的词）')
                    return
    if not n:
        print('没找到。试试换同义词、少写几个词，或加 --all-dirs')


main()
