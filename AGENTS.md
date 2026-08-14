# Person Relation Lab Working Rules

## 文档与沟通语言

- 与用户沟通默认使用中文。
- 设计规格、实施计划、进度报告和运维说明默认使用中文。
- 代码标识符、数据库对象、命令、日志事件名和行业标准术语可保留英文。

## Runtime and package manager

- Use Node.js 24 and `npm`; keep `package-lock.json` authoritative.
- Production runs through Docker Compose and PostgreSQL 16.
- Shell scripts must work with macOS Bash 3.2 and BSD userland.

## Validation

- Focused tests: `npm test -- <test-file>`.
- Shell syntax: `bash -n scripts/<script>.sh`.
- Full gate: `npm run verify`.
- Never weaken or remove a test merely to make the gate pass.

## Protected data and configuration

- Never read, copy, print, or send `.env`, database dumps, import files, CSV/XLS/XLSX data, logs containing records, or the `data/` directory to an AI model.
- Real personal data must never enter Git, tests, fixtures, prompts, CI, or GitHub.
- Use synthetic people and identifiers in tests.
- Never run `docker compose down -v`, delete Docker volumes, truncate source tables, or reset projection state without explicit user authority.

## Local coding model

- Ollama and `qwen2.5-coder:7b-instruct` are optional development tools, never runtime dependencies.
- Give the model only an explicit task file and explicit allowlisted source files.
- Model output is untrusted. Save it under `/tmp`, do not execute generated commands, and do not automatically write generated patches into the repository.
- Accept code only after review plus `npm run verify`.

## Git delivery

- Preserve unrelated user changes and dirty files.
- Do not reset, clean, force-push, merge, or modify `main` directly.
- Push only when the user has authorized it; use the existing feature branch and Pull Request when present.
- Completion reports must include changed files, fresh verification evidence, remaining risks, and the exact next command.
