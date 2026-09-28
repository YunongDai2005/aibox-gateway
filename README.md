# AI Box Gateway

通过微信与 Linux AI 助手协作：发任务、追问进度、中途叫停或改方向，并按话题保留上下文。

本仓库是运行中 AI Box 网关的脱敏源码快照，包含模块化 v2 网关、v1 参考实现、配套脚本和模拟回放测试。真实账号、会话、机器配置和旧 Git 历史均未包含。

## 能做什么

- **微信消息路由**：插在 OpenClaw 微信插件与腾讯 iLink 之间，代理消息并按模式分流。
- **任务执行**：调用 DSH 命令行，处理文本、语音转写、图片和文件；支持排队、叫停和中途补充。
- **经理对话**：任务执行期间回应进度和纠正要求，通过信箱把补充信息交给执行器。
- **话题与记忆**：自动识别话题、拆分会话、生成交接包、检索历史目录。
- **可选外援**：配套脚本调用其他模型/CLI，在独立工作副本中处理任务。
- **可选复盘**：记录信号、调整限定参数、生成改进提案；代码提案有批准和上线两个步骤。
- **可观察性**：本地状态 API、运行日志、结构化事件与恢复脚本。

```text
微信 ↔ 腾讯 iLink ↔ AI Box Gateway ↔ OpenClaw 微信插件
                         │
                         ├─ 命令 / 经理 / 话题路由
                         ├─ DSH 执行器 → 模型与本机工具
                         └─ 会话交接 / 信箱 / 状态 API
```

## 先运行测试

需要 Node.js 22+，测试使用内置模块，无需 npm install，也不需要真实微信账号或模型密钥。

```bash
git clone https://github.com/YunongDai2005/aibox-gateway.git
cd aibox-gateway
npm test
```

模拟服务仅监听本机，临时目录隔离消息、账号和模型数据。`npm run test:both` 额外运行 v1 对照；v1 是保留的部署参考，其跨平台兼容性见 [验证记录](docs/VALIDATION.md)。

## 接入真实环境

这是需要自行配置的集成项目。实际运行依赖 Linux、已配置的 DSH `headless` profile、OpenClaw 及其微信插件、用户自己的 iLink 账号和模型凭证。

完整配套脚本沿用固定布局，以专用 Linux 用户 `aibox` 为示例：

```text
/home/aibox/wx-router/      本仓库
/home/aibox/bin/            从本仓库 bin/ 安装的脚本
/home/aibox/dsh-work/       DSH 工作目录
/home/aibox/.dsh/           用户自己的 DSH profile 与凭证
/home/aibox/.openclaw/      用户自己的 OpenClaw 和微信插件
/home/aibox/.aibox/         运行中生成的本地状态
```

1. 将仓库放在上面的 `wx-router` 目录。确认 `~/bin` 中没有同名脚本后，将仓库 `bin/` 的内容复制过去，并创建 `~/dsh-work`。
2. 复制 `config.example.json` 为 `config.json`，按实际安装填写 `accountFile`、`pluginDir`、`dshBin`、`dshCwd`、模型设置和 `realBase`。
3. **`realBase` 必须是原始 iLink 上游地址**。让 OpenClaw 微信通道通过 `http://127.0.0.1:8787` 接入代理时，不要把这个回环地址当成上游，否则会形成循环代理。
4. DSH 的 `headless` profile 及 `fallback-deepseek.yml` 需用户自行配置；经理等组件从 `~/.dsh/.credentials.yaml` 读取 `OPENCODE_GO_API_KEY`、`DEEPSEEK_API_KEY`。模型名与供应商地址按自己的服务调整。
5. 先前台执行 `npm start`，检查 `/healthz` 和 `http://127.0.0.1:8788/api/v2/status`。确认集成正确后再安装 `ops/wx-router.service`，修改其中 Node 的实际路径。

v2 核心支持 `AIBOX_HOME`、`AIBOX_ROOT`、`AIBOX_CONFIG`；v1 和部分 `bin/`/`ops/` 脚本仍使用 `/home/aibox`。若换用户或目录，需要同步调整这些脚本。微信插件内部模块布局可能随版本变化，接入时需核对。

示例配置关闭外援、本地模型及自动复盘；启用前先配置相应 CLI、模型和脚本。系统状态面板、MCP 控制服务、模型权重和第三方框架不包含在本仓库中。

## 目录与开发

| 目录 | 内容 |
| --- | --- |
| `src/core` | 配置、插件注册、日志和模型调用 |
| `src/channel` | 微信代理、消息与媒体 |
| `src/agent` | 执行流水线、队列和中断 |
| `src/plugins` | 经理、话题、叫停、交接等功能 |
| `src/memory` / `src/evolve` | 话题记忆与复盘提案 |
| `bin` / `ops` | 可选配套工具与 Linux 运维示例 |
| `test` | 假服务、场景回放和单元测试 |

开发前阅读 [架构](docs/ARCHITECTURE.md)；新增功能优先写插件并补充回放用例。另见 [复盘机制](docs/EVOLVE.md)、[项目盘点](docs/PROJECT-OVERVIEW.md)、[脱敏范围](docs/PUBLICATION.md) 和 [安全说明](SECURITY.md)。

## License

本仓库代码采用 [MIT License](LICENSE)。OpenClaw、微信插件、DSH、AstrBot、llama.cpp 及模型服务是独立依赖，遵循各自许可和使用条件；本仓库不重新分发它们的代码、权重或凭证。
