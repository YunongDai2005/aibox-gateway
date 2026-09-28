#!/usr/bin/env node
/**
 * 启动器：按 config.json 的 engine 选引擎。
 *   "v2"（默认）  模块化网关 src/main.mjs
 *   "v1"          老的单文件 proxy.mjs（回滚用，原样保留）
 * 切换：改 config.json 的 engine，再用 wx-router-guard.sh 安全重启。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let engine = 'v2';
try { engine = JSON.parse(fs.readFileSync(process.env.AIBOX_CONFIG || path.join(process.env.AIBOX_ROOT || here, 'config.json'), 'utf8')).engine || 'v2'; } catch {}
if (engine === 'v1') await import('./proxy.mjs');
else await import('./src/main.mjs');
