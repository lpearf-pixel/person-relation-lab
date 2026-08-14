# 二次加工第一阶段运维说明

本文说明 `normalizer-v1` 标准观察和属性频率画像的本地运行、恢复、监控与验收。第一阶段不会修改 `core.person`、`core.person_observation`、现有 `relation-v3` 证据或关系，也不会生成 `relation-v4`。

## 运行前检查

先确认基础导入与人物投影已经完整：

```bash
./scripts/verify-baseline.sh
```

只有输出 `BASELINE_PASS` 且退出状态为 0 时才启动二次加工。生产规模运行前还应确认 Docker 可用、PostgreSQL 健康，并为派生表和 WAL 预留足够磁盘空间。

## 启动或恢复

```bash
./scripts/run-secondary-processing.sh
```

脚本会停止常驻 `app`，编译、执行迁移，然后串行处理已完成来源。每个批次的数据与检查点在同一事务中提交；命令中断后再次执行同一脚本，会从已提交检查点继续。只有全部成功后才重新启动常驻 `app`。

固定日志：

```text
/tmp/person-relation-secondary-processing-latest.log
```

## 查看进度

单次快照：

```bash
ONCE=1 ./scripts/watch-secondary-processing.sh
```

每 30 秒持续刷新：

```bash
./scripts/watch-secondary-processing.sh
```

自定义刷新间隔：

```bash
INTERVAL_SECONDS=60 ./scripts/watch-secondary-processing.sh
```

监控日志：

```text
/tmp/person-relation-secondary-watch-latest.log
```

监控只输出来源级计数、检查点、聚合表大小、活跃 SQL 以及 WAL/临时写入增量，不读取原始 JSON 或个人明文。

## 安全停止与继续

在运行二次加工的终端按 `Ctrl+C`。已提交批次和检查点会保留，当前未提交事务由 PostgreSQL 回滚。确认命令退出后，可执行：

```bash
docker compose exec -T db psql -U person_relation -d person_relation -c "
SELECT pipeline_name, pipeline_version, COALESCE(source_file_id::text, 'global') AS scope,
  stage, state, last_raw_record_id, processed_rows, updated_at, last_error_code
FROM ingest.processing_checkpoint
WHERE pipeline_version = 'normalizer-v1'
ORDER BY updated_at DESC
LIMIT 40;
"
```

随后再次运行 `./scripts/run-secondary-processing.sh` 即可续传。不要删除数据库卷、清空分析表或手工推进检查点。

## 生成验收报告

二次加工退出成功后运行：

```bash
./scripts/secondary-quality-report.sh
```

报告在只读事务中生成，检查：

- 每个来源的 raw、person observation、标准观察数量一致；
- 所有来源及来源级标准化检查点均完成；
- 手机、邮箱、地址、单位四个渠道共 1024 个画像桶均完成；
- 标准观察和画像中不存在空字符串哈希；
- 渠道覆盖率、属性人数分段、分类和质量标记仅以聚合计数输出。

验收成功输出 `SECONDARY_QUALITY_PASS`；任一门禁不满足则输出 `SECONDARY_QUALITY_FAIL` 并返回非零状态。固定日志：

```text
/tmp/person-relation-secondary-quality-latest.log
```

数据库错误同样返回非零状态。日志不得提交到 Git，因为即使只有聚合信息，也属于本地生产运行记录。

## 独立合成数据冒烟

默认方式会为独立 Compose project 构建应用镜像：

```bash
./scripts/smoke-secondary-processing.sh
```

如果 Docker Hub 元数据访问受代理影响，可先使用本机统一构建工具生成当前项目镜像，再让冒烟脚本复用它。例如本机 `dcb` 已配置时：

```bash
dcb
SMOKE_APP_IMAGE=person-relation-lab-app ./scripts/smoke-secondary-processing.sh
```

复用模式会先验证本地镜像存在，只给它增加一个当前冒烟 project 的临时标签；退出时删除临时标签、临时数据库卷和空导入目录，不删除原始 `person-relation-lab-app` 镜像，也不接触生产数据库卷。代码更新后必须先重新运行 `dcb`，避免使用旧镜像。

## 第一阶段边界

本阶段只建立版本化的标准观察和属性频率画像，用于评估地址、联系方式和单位字段的覆盖率与区分度。它不会直接判断配偶、恋爱或情人关系，也不会把单一共享地址、单位或联系方式提升为伴侣关系。后续 `relation-v4` 必须在质量报告验收、阈值标注和离线评估完成后另行开发。
