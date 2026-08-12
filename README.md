# Person Relation Lab

本地优先的人员档案导入与关系证据分析工程，面向多个约300MB的Excel文件，保存来源行、归一身份字段，并以证据和置信度展示两个人之间的关系。

## 当前能力

- 递归扫描批准目录，忽略隐藏文件、Excel锁文件和不支持格式。
- 后台定时递归扫描目录；文件连续保持不变达到稳定期后自动登记、计算SHA-256并导入。
- `.xlsx` 流式读取，不把整个工作簿载入内存。
- 工作表级导入断点、人物投影断点和三通道关系计算断点。
- 手机、地址、单位关系按小批次原子提交，可安全暂停、重启和继续。
- 中文身份证校验、生日/性别提取、手机号归一。
- 地址缺失保持中性；公共单位证据不能推断伴侣。
- PostgreSQL按观察、实体、证据、投影、审核、审计分层。
- Fastify本地API，默认仅监听 `127.0.0.1`。

“疑似伴侣关联”只能是待人工核验的推断，系统不会自动输出“情人”结论。

## 本地运行

要求Docker Desktop或兼容的Docker Compose。

1. 复制 `.env.example` 为 `.env`。
2. 把 `IMPORT_DIR` 改为存放Excel的本地目录。
3. 修改本地数据库密码。
4. 执行：

```bash
docker compose up --build -d
curl http://127.0.0.1:8787/api/v1/health
```

Excel目录以只读方式挂载到容器内 `/imports`，浏览器不会上传这些文件。
默认每30秒扫描一次，文件至少稳定60秒才开始导入；失败文件会进入 `quarantined` 状态并留下审计事件。重启后依靠文件哈希、来源行唯一键和工作表断点继续，不会重复写入。

## 大数据恢复与监控

升级到断点续算版本后，在工程目录执行：

```bash
git pull --ff-only origin main
./scripts/pause-processing.sh
./scripts/resume-processing.sh
```

`pause-processing.sh` 只停止应用和关系投影 SQL，PostgreSQL、原始数据、已经提交的人物及关系数据都会保留。`resume-processing.sh` 会构建新镜像、运行迁移，然后串行修复所有未完成来源；全部验证通过后才启动常驻应用。

如果旧版本留下“阶段已完成、但人物观察数量不足”的污染断点，恢复程序会自动识别并只分页回填缺失的观察记录。随后三个关系阶段会从安全断点重新幂等计算；已有原始记录、人物、证据和关系均不会删除。恢复中断后再次运行同一脚本，会从最近一次已提交的人物或关系批次继续。

恢复期间可以在第二个终端查看进度：

```bash
./scripts/watch-processing.sh 30
```

每个来源分别记录 `people`、`mobile`、`address`、`company` 四个阶段。每批默认处理 2,000 条并立即提交；按 `Ctrl+C` 或重启 Docker 后，最多只会重做当前尚未提交的一批。

最新日志固定写入：

- `/tmp/person-relation-pause-latest.log`
- `/tmp/person-relation-resume-latest.log`
- `/tmp/person-relation-watch-latest.log`

可通过 `.env` 调整 `PROJECTION_BATCH_SIZE` 和 `RELATION_BATCH_SIZE`。初次恢复建议保持默认值 `2000`。绝对不要执行 `docker compose down -v`，该命令会删除数据库卷。

## 开发验证

```bash
npm ci
npm run verify
```

真实个人数据不得提交到Git、测试或CI。

## 大文件基准

先用合成数据调节行数，生成接近本机真实文件大小的工作簿，再执行流式读取基准：

```bash
BENCHMARK_ROWS=2000000 npm run benchmark:generate -- data/benchmark/people.xlsx
npm run benchmark:read -- data/benchmark/people.xlsx
```

命令会输出文件字节数、总行数、吞吐量和峰值RSS。合成文件位于已忽略的 `data/`，不会提交到GitHub。
