# 本地 Qwen 代码助手

该工具可把小型开发任务和明确指定的代码文件交给本机 Ollama 中的 `qwen2.5-coder:7b-instruct`。它是可选开发工具，不参与数据导入、人物合并或关系判断；Ollama 未启动也不会影响应用和数据库。

## 安装与自检

```bash
ollama list
ollama pull qwen2.5-coder:7b-instruct
./scripts/local-coder-check.sh
```

自检日志固定保存在 `/tmp/person-relation-local-coder-check-latest.log`。默认连接 `http://127.0.0.1:11434`，可用 `OLLAMA_URL` 覆盖，但工具只接受 `localhost`、`127.0.0.1` 或 `::1` 的 HTTP 地址。

自检和任务脚本会检查 TypeScript 测试/构建依赖；若本地 `node_modules` 不完整，会自动按照 `package-lock.json` 执行一次 `npm ci --include=dev`。后续依赖完整时不会重复安装。

## 执行小型代码任务

先把需求写入仓库内的 Markdown 或文本文件，例如 `/tmp` 文件不在仓库内，因此不能作为输入。推荐创建一个不会包含真实数据的临时任务文档：

```bash
mkdir -p docs/local-coder-tasks
printf '%s\n' '请审查给定代码的边界条件，只返回建议和 unified diff，不要假定测试已运行。' > docs/local-coder-tasks/review.md
./scripts/local-coder-task.sh docs/local-coder-tasks/review.md src/domain/relations.ts tests/relations.test.ts
```

模型回答写入 `/tmp/person-relation-local-coder-latest.md`，运行日志写入 `/tmp/person-relation-local-coder-task-latest.log`。脚本不会修改工程文件、应用补丁或执行回答里的命令。

如需切换模型或延长超时：

```bash
LOCAL_CODER_MODEL=qwen2.5-coder:7b-instruct LOCAL_CODER_TIMEOUT_SECONDS=300 ./scripts/local-coder-task.sh docs/local-coder-tasks/review.md src/domain/relations.ts
```

## 输入边界

- 只读取命令行明确列出的仓库内文件。
- 单文件最多 256 KiB，全部输入最多 768 KiB。
- 支持常用代码、SQL、Shell、JSON、Markdown、HTML、CSS 和 YAML 文本。
- 拒绝 `.env`、仓库外路径、符号链接逃逸、`data/`、导入目录、备份、转储、日志、CSV 和电子表格。
- 不连接 PostgreSQL，不查询原始人员数据，不向外部模型发送内容。

采纳任何生成内容前应人工检查，再执行：

```bash
npm run verify
```
