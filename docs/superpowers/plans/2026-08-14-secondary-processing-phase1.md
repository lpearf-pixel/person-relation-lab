# 二次加工第一阶段实施计划

> **供智能开发执行者使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，严格按任务顺序执行。所有步骤使用复选框（`- [ ]`）追踪。

**目标：** 在不修改现有人物身份和 `relation-v3` 的前提下，交付 `normalizer-v1` 标准观察、全库属性频率画像、可恢复批处理以及只含聚合数据的质量报告。

**架构：** PostgreSQL 保存权威派生数据；Node.js 工作器按来源和原始记录 ID 进行有界 keyset 分页，每批数据和检查点在同一事务提交。属性频率按渠道和哈希前缀分桶计算，避免再次产生全来源人物自连接和超大事务。

**技术栈：** Node.js 24、TypeScript、PostgreSQL 16、Vitest、ESLint、Docker Compose、macOS Bash 3.2。

## 全局约束

- 规格来源：`docs/superpowers/specs/2026-08-14-secondary-processing-design.md`。
- 原始数据、现有 `core.person`、`core.person_observation`、`relation-v3` 和 Docker 数据卷均不得修改或删除。
- 生产数据不进入 Git、测试夹具、日志、Ollama 或外部服务；测试只使用合成人物。
- 第一阶段固定使用 `normalizer-v1`，不得通过未记录的环境默认值改变语义。
- 缺失地址必须保持 null 和中性，不能生成空字符串哈希。
- 所有长任务按已提交批次恢复；禁止单个事务覆盖整个来源。
- 所有 shell 脚本兼容 macOS Bash 3.2 和 BSD 工具。
- 每个任务完成后运行聚焦测试；整个阶段完成后运行 `npm run verify`。

---

## 文件边界

- `src/domain/normalized-value.ts`：二次加工公共类型、版本常量和哈希函数。
- `src/domain/address-normalizer.ts`：保守的地址标准化、粒度和质量标记。
- `src/domain/company-normalizer.ts`：单位主体与部门的保守拆分。
- `src/domain/secondary-record-normalizer.ts`：把一条 raw JSON 转换为 `normalizer-v1` 观察结果。
- `migrations/005_secondary_processing_foundation.sql`：分析表和通用检查点。
- `src/db/secondary-processing-sql.ts`：批量写入、覆盖验证和频率分桶 SQL。
- `src/db/secondary-processing-builder.ts`：来源级标准观察工作器。
- `src/db/value-profiler.ts`：渠道/哈希前缀级频率画像工作器。
- `src/db/run-secondary-processing.ts`：串行处理所有已完成来源的命令入口。
- `scripts/run-secondary-processing.sh`：本地长任务启动与固定日志。
- `scripts/watch-secondary-processing.sh`：只读进度、资源和错误摘要。
- `scripts/secondary-quality-report.sh`：只读聚合质量报告。
- `docs/secondary-processing-operations.md`：运行、停止、恢复和验收说明。

---

### 任务 1：版本化地址与单位标准化

**文件：**

- 新建：`src/domain/normalized-value.ts`
- 新建：`src/domain/address-normalizer.ts`
- 新建：`src/domain/company-normalizer.ts`
- 测试：`tests/address-normalizer.test.ts`
- 测试：`tests/company-normalizer.test.ts`

**接口：**

- 产出：`NORMALIZER_VERSION = "normalizer-v1"`。
- 产出：`digestNormalized(value: string): string`。
- 产出：`normalizeAddress(value: string | null | undefined): NormalizedAddress`。
- 产出：`normalizeCompany(value: string | null | undefined): NormalizedCompany`。

- [ ] **步骤 1：编写地址标准化失败测试**

```ts
expect(normalizeAddress(null)).toEqual({
  value: null,
  region: null,
  detailLevel: 0,
  version: "normalizer-v1",
  flags: ["address_missing_neutral"]
});
expect(normalizeAddress(" 上海市 浦东新区 上南路 5290 号 ")).toMatchObject({
  value: "上海市浦东新区上南路5290号",
  region: "上海市浦东新区",
  detailLevel: 3
});
```

- [ ] **步骤 2：运行测试并确认因模块不存在而失败**

运行：`npm test -- tests/address-normalizer.test.ts`

预期：失败，并提示无法解析 `address-normalizer.js`。

- [ ] **步骤 3：实现公共类型和保守地址标准化**

`NormalizedAddress` 必须包含 `value`、`region`、`detailLevel`、`version`、`flags`。只执行 Unicode NFKC、空白和常见标点规范化；行政区提取失败时保留完整标准值并增加 `address_region_unparsed`，不得猜测缺失行政区。

```ts
export const NORMALIZER_VERSION = "normalizer-v1" as const;
export type NormalizedAddress = {
  value: string | null;
  region: string | null;
  detailLevel: 0 | 1 | 2 | 3 | 4;
  version: typeof NORMALIZER_VERSION;
  flags: string[];
};

export function normalizeAddress(input: string | null | undefined): NormalizedAddress {
  const value = input?.normalize("NFKC").replace(/[，,；;]+/g, " ").replace(/\s+/g, "").trim() || null;
  if (!value) return { value: null, region: null, detailLevel: 0, version: NORMALIZER_VERSION, flags: ["address_missing_neutral"] };
  // 使用受测试约束的行政区正则提取 region；不能命中时保留 value 并标记。
}
```

- [ ] **步骤 4：编写单位标准化失败测试**

```ts
expect(normalizeCompany("上海江达机械加工部 总经办")).toEqual({
  organization: "上海江达机械加工部",
  department: "总经办",
  version: "normalizer-v1",
  flags: []
});
expect(normalizeCompany(" ")).toMatchObject({
  organization: null,
  department: null,
  flags: ["company_missing_neutral"]
});
```

- [ ] **步骤 5：实现单位主体与部门保守拆分**

首版只识别末尾明确部门词：`总经办`、`采购部`、`财务部`、`经理室`、`人事部`、`销售部`。无法可靠拆分时，完整值作为 `organization`，`department` 为 null，并增加 `department_unparsed`；不得删除 `有限公司`、`集团` 等主体组成部分。

```ts
const DEPARTMENT_SUFFIX = /(总经办|采购部|财务部|经理室|人事部|销售部)$/u;
const match = normalized.match(DEPARTMENT_SUFFIX);
const department = match?.[1] ?? null;
const organization = department ? normalized.slice(0, -department.length) || null : normalized;
```

- [ ] **步骤 6：运行聚焦测试和静态检查**

运行：

```bash
npm test -- tests/address-normalizer.test.ts tests/company-normalizer.test.ts
npm run lint
```

预期：两个测试文件和 ESLint 全部通过。

- [ ] **步骤 7：提交标准化器**

```bash
git add src/domain/normalized-value.ts src/domain/address-normalizer.ts src/domain/company-normalizer.ts tests/address-normalizer.test.ts tests/company-normalizer.test.ts
git commit -m "feat: add versioned field normalizers"
```

---

### 任务 2：标准观察记录构建器

**文件：**

- 新建：`src/domain/secondary-record-normalizer.ts`
- 测试：`tests/secondary-record-normalizer.test.ts`
- 复用：`src/domain/identity.ts`
- 复用：`src/domain/normalized-value.ts`

**接口：**

- 输入：`normalizeSecondaryRecord(rawRecordId: string, personId: string, sourceFileId: string, values: Record<string, unknown>)`。
- 产出：`SecondaryNormalizedRecord`，只包含哈希、粒度、版本和质量标记，不包含身份证、手机号、地址、邮箱或单位明文。

- [ ] **步骤 1：编写隐私和缺失值失败测试**

```ts
const result = normalizeSecondaryRecord("1", "person-1", "source-1", {
  Descriot: "测试甲",
  Mobile: "+86 138-0013-8000",
  Address: null,
  Company: "测试制造有限公司 财务部",
  EMail: " Test@Example.COM "
});
expect(result).toMatchObject({
  rawRecordId: "1",
  personId: "person-1",
  sourceFileId: "source-1",
  normalizerVersion: "normalizer-v1",
  addressHash: null,
  addressDetailLevel: 0
});
expect(JSON.stringify(result)).not.toContain("13800138000");
expect(JSON.stringify(result)).not.toContain("Test@Example.COM");
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`npm test -- tests/secondary-record-normalizer.test.ts`

预期：失败，并提示模块不存在。

- [ ] **步骤 3：实现记录构建器**

手机号复用 `normalizeMobile`；邮箱执行 trim 和小写后验证基础格式；地址和单位复用任务 1 接口。所有非空标准值通过 `digestNormalized` 转换为 SHA-256 哈希；质量标记去重后排序，保证重跑结果稳定。

```ts
export type SecondaryNormalizedRecord = {
  rawRecordId: string;
  personId: string;
  sourceFileId: string;
  normalizerVersion: typeof NORMALIZER_VERSION;
  nameHash: string | null;
  mobileHash: string | null;
  emailHash: string | null;
  addressHash: string | null;
  addressRegionHash: string | null;
  addressDetailLevel: 0 | 1 | 2 | 3 | 4;
  organizationHash: string | null;
  departmentHash: string | null;
  qualityFlags: string[];
};

const hashOrNull = (value: string | null): string | null => value ? digestNormalized(value) : null;
```

- [ ] **步骤 4：增加确定性和空字符串测试**

同一输入运行两次必须完全相等；空白手机号、邮箱、地址和单位必须生成 null，不能生成 SHA-256 空值。

- [ ] **步骤 5：运行聚焦测试**

运行：`npm test -- tests/secondary-record-normalizer.test.ts`

预期：全部通过。

- [ ] **步骤 6：提交记录构建器**

```bash
git add src/domain/secondary-record-normalizer.ts tests/secondary-record-normalizer.test.ts
git commit -m "feat: build privacy-safe normalized observations"
```

---

### 任务 3：二次加工数据库基础

**文件：**

- 新建：`migrations/005_secondary_processing_foundation.sql`
- 修改：`tests/schema.test.ts`

**接口：**

- 产出：`analytics.normalized_observation`。
- 产出：`analytics.value_profile`。
- 产出：`ingest.processing_checkpoint`。

- [ ] **步骤 1：编写迁移合同失败测试**

```ts
const sql = await readFile(new URL("../migrations/005_secondary_processing_foundation.sql", import.meta.url), "utf8");
expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS analytics");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.normalized_observation");
expect(sql).toContain("PRIMARY KEY (raw_record_id, normalizer_version)");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.value_profile");
expect(sql).toContain("CREATE TABLE IF NOT EXISTS ingest.processing_checkpoint");
expect(sql).toContain("NULLS NOT DISTINCT");
```

- [ ] **步骤 2：运行 schema 测试并确认失败**

运行：`npm test -- tests/schema.test.ts`

预期：因迁移文件不存在而失败。

- [ ] **步骤 3：实现迁移**

`normalized_observation` 增加 `source_file_id` 以支持来源覆盖验证；对 `normalizer_version` 与各属性哈希建立复合索引，并为 `left(hash, 2)` 分桶建立表达式索引。`processing_checkpoint` 使用 bigint 主键和包含 `source_file_id` 的 `UNIQUE NULLS NOT DISTINCT` 约束，使全局画像阶段可以使用 null 来源且保持幂等。

```sql
BEGIN;
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.normalized_observation (
  raw_record_id BIGINT NOT NULL REFERENCES raw.record(id),
  person_id UUID NOT NULL REFERENCES core.person(id),
  source_file_id UUID NOT NULL REFERENCES ingest.source_file(id),
  normalizer_version TEXT NOT NULL,
  name_hash CHAR(64), mobile_hash CHAR(64), email_hash CHAR(64),
  address_hash CHAR(64), address_region_hash CHAR(64),
  address_detail_level SMALLINT NOT NULL CHECK (address_detail_level BETWEEN 0 AND 4),
  organization_hash CHAR(64), department_hash CHAR(64),
  quality_flags TEXT[] NOT NULL DEFAULT '{}',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (raw_record_id, normalizer_version)
);

CREATE TABLE IF NOT EXISTS analytics.value_profile (
  channel TEXT NOT NULL CHECK (channel IN ('mobile','email','address','organization')),
  normalized_hash CHAR(64) NOT NULL,
  normalizer_version TEXT NOT NULL,
  observation_count BIGINT NOT NULL CHECK (observation_count > 0),
  person_count BIGINT NOT NULL CHECK (person_count > 0),
  source_count BIGINT NOT NULL CHECK (source_count > 0),
  classification TEXT NOT NULL CHECK (classification IN ('private','shared_household','organization','public','noisy')),
  quality_flags TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, normalized_hash, normalizer_version)
);

CREATE TABLE IF NOT EXISTS ingest.processing_checkpoint (
  id BIGSERIAL PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  source_file_id UUID REFERENCES ingest.source_file(id),
  stage TEXT NOT NULL,
  last_raw_record_id BIGINT NOT NULL DEFAULT 0 CHECK (last_raw_record_id >= 0),
  processed_rows BIGINT NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','running','complete','failed')),
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX processing_checkpoint_scope_uq
  ON ingest.processing_checkpoint(pipeline_name, pipeline_version, source_file_id, stage) NULLS NOT DISTINCT;
COMMIT;
```

- [ ] **步骤 4：加入约束测试**

测试必须要求状态只允许 `pending/running/complete/failed`，`last_raw_record_id` 和 `processed_rows` 非负，`address_detail_level` 在 0 到 4 之间，并要求 `value_profile` 只允许既定渠道与分类。

- [ ] **步骤 5：运行迁移合同测试**

运行：`npm test -- tests/schema.test.ts`

预期：全部通过。

- [ ] **步骤 6：提交数据库基础**

```bash
git add migrations/005_secondary_processing_foundation.sql tests/schema.test.ts
git commit -m "feat: add secondary processing schema"
```

---

### 任务 4：可恢复标准观察工作器

**文件：**

- 新建：`src/db/secondary-processing-sql.ts`
- 新建：`src/db/secondary-processing-builder.ts`
- 测试：`tests/secondary-processing-builder.test.ts`

**接口：**

- 产出：`class PgSecondaryProcessingBuilder`。
- 产出：`processSource(sourceFileId: string): Promise<{ processedRecords: number }>`。
- 构造：`new PgSecondaryProcessingBuilder(database: ConnectableDatabase, pageSize = 2000)`。

- [ ] **步骤 1：编写分页、锁和事务失败测试**

使用现有假数据库模式记录 SQL 和参数。测试要求：

```ts
expect(sql).toContain("pg_try_advisory_lock");
expect(sql).toContain("r.id > $2::bigint");
expect(sql).toContain("ORDER BY r.id LIMIT $3");
expect(sql).toContain("BEGIN");
expect(sql).toContain("ON CONFLICT (raw_record_id, normalizer_version)");
expect(sql).toContain("COMMIT");
```

- [ ] **步骤 2：运行聚焦测试并确认失败**

运行：`npm test -- tests/secondary-processing-builder.test.ts`

预期：因工作器不存在而失败。

- [ ] **步骤 3：实现来源级锁和断点读取**

锁键使用 `secondary-normalization:normalizer-v1:<sourceFileId>`。只读取已有 `core.person_observation` 的 raw 记录；游标来自 `ingest.processing_checkpoint`。发现另一个进程持锁时必须立即返回明确错误，不能并发执行同一来源。

```ts
export class PgSecondaryProcessingBuilder {
  constructor(private readonly database: ConnectableDatabase, private readonly pageSize = 2_000) {
    if (pageSize <= 0) throw new Error("pageSize must be positive");
  }

  async processSource(sourceFileId: string): Promise<{ processedRecords: number }> {
    const lockKey = `secondary-normalization:${NORMALIZER_VERSION}:${sourceFileId}`;
    // 获取 advisory lock，读取检查点，循环 keyset 分页，最终验证覆盖率并释放锁。
  }
}
```

分页 SQL 必须采用：

```sql
SELECT r.id::text, o.person_id::text, r.values
FROM raw.record r
JOIN core.person_observation o ON o.raw_record_id = r.id
WHERE r.source_file_id = $1 AND r.id > $2::bigint
ORDER BY r.id
LIMIT $3;
```

- [ ] **步骤 4：实现批次原子写入**

每页先在内存中调用 `normalizeSecondaryRecord`，再用 `jsonb_to_recordset` 批量 upsert。`BEGIN` 后写入观察记录并推进检查点，成功后 `COMMIT`；任何错误执行 `ROLLBACK`，检查点不得前进。

```ts
await client.query("BEGIN");
try {
  await client.query(UPSERT_NORMALIZED_OBSERVATIONS_SQL, [payload, sourceFileId, lastRawRecordId]);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
}
```

- [ ] **步骤 5：实现覆盖验证**

来源完成前比较：

```text
raw.record 数量
core.person_observation 数量
analytics.normalized_observation(normalizer-v1) 数量
```

三者必须相等，检查点才能标记 `complete`。无效计数或数量不一致必须失败且写入安全错误代码，不记录数据载荷。

- [ ] **步骤 6：增加中断恢复和幂等测试**

模拟第二批失败，断言第一批检查点已提交；重新运行从上一游标继续。重复处理同一页后，派生表行数不增加。

- [ ] **步骤 7：运行聚焦测试和构建**

```bash
npm test -- tests/secondary-processing-builder.test.ts
npm run build
```

预期：测试和 TypeScript 构建通过。

- [ ] **步骤 8：提交工作器**

```bash
git add src/db/secondary-processing-sql.ts src/db/secondary-processing-builder.ts tests/secondary-processing-builder.test.ts
git commit -m "feat: add resumable normalized observation worker"
```

---

### 任务 5：分桶属性频率画像

**文件：**

- 修改：`src/db/secondary-processing-sql.ts`
- 新建：`src/db/value-profiler.ts`
- 测试：`tests/value-profiler.test.ts`

**接口：**

- 产出：`PROFILE_CHANNELS = ["mobile", "email", "address", "organization"]`。
- 产出：`class PgValueProfiler`。
- 产出：`rebuild(normalizerVersion = "normalizer-v1"): Promise<{ profiledValues: number }>`。

- [ ] **步骤 1：编写分桶和前置覆盖失败测试**

测试要求画像开始前确认全部 complete 来源均有 `normalizer-v1` 完整检查点；每个渠道按 `00` 到 `ff` 的哈希前缀处理，并使用 `profile:<channel>:<prefix>` 全局检查点。

- [ ] **步骤 2：运行聚焦测试并确认失败**

运行：`npm test -- tests/value-profiler.test.ts`

预期：因 `PgValueProfiler` 不存在而失败。

- [ ] **步骤 3：实现渠道白名单和 SQL 构造**

列名必须由代码内固定映射产生，绝不能由外部字符串直接拼接。每个桶聚合 `COUNT(*)`、`COUNT(DISTINCT person_id)` 和 `COUNT(DISTINCT source_file_id)`，写入 `analytics.value_profile` 后在同一事务推进检查点。

```ts
export const PROFILE_CHANNELS = {
  mobile: "mobile_hash",
  email: "email_hash",
  address: "address_hash",
  organization: "organization_hash"
} as const;
export type ProfileChannel = keyof typeof PROFILE_CHANNELS;

export function profileBucketSql(channel: ProfileChannel): string {
  const column = PROFILE_CHANNELS[channel];
  return `SELECT ${column} AS normalized_hash, COUNT(*)::text AS observation_count,
    COUNT(DISTINCT person_id)::text AS person_count,
    COUNT(DISTINCT source_file_id)::text AS source_count
    FROM analytics.normalized_observation
    WHERE normalizer_version = $1 AND left(${column}, 2) = $2
    GROUP BY ${column}`;
}
```

- [ ] **步骤 4：实现第一阶段报告型分类**

第一阶段不把统计分布固化为关系阈值：

- `person_count = 1` 标记 `private`；
- 手机或邮箱 `person_count > 1` 暂标记 `shared_household` 并增加 `threshold_pending_review`；
- 地址 `person_count > 1` 暂标记 `shared_household` 并增加 `threshold_pending_review`；
- 单位统一标记 `organization`；
- 无效或带严重质量标记的值标记 `noisy`。

这些分类仅用于质量报告，第三阶段必须根据实测分布另行确定配对阈值。

- [ ] **步骤 5：增加重跑与失败恢复测试**

相同桶重跑必须覆盖同版本统计而不是累加。模拟桶失败时，只保留之前已提交桶；恢复后从第一个未完成桶继续。

- [ ] **步骤 6：运行聚焦测试**

运行：`npm test -- tests/value-profiler.test.ts`

预期：全部通过。

- [ ] **步骤 7：提交画像工作器**

```bash
git add src/db/secondary-processing-sql.ts src/db/value-profiler.ts tests/value-profiler.test.ts
git commit -m "feat: add resumable value frequency profiles"
```

---

### 任务 6：命令入口和本地运维脚本

**文件：**

- 新建：`src/db/run-secondary-processing.ts`
- 修改：`package.json`
- 新建：`scripts/run-secondary-processing.sh`
- 新建：`scripts/watch-secondary-processing.sh`
- 修改：`tests/production-scripts.test.ts`

**接口：**

- 产出：`npm run process:secondary`。
- 产出：`/tmp/person-relation-secondary-processing-latest.log`。
- 产出：`/tmp/person-relation-secondary-watch-latest.log`。

- [ ] **步骤 1：编写脚本合同失败测试**

测试要求两个脚本包含 `set -Eeuo pipefail`、固定 `/tmp` 日志和 `docker compose`，且不得包含 `down -v`、`DROP TABLE`、`TRUNCATE`、`DELETE FROM raw.record` 或真实记录输出。

- [ ] **步骤 2：运行生产脚本测试并确认失败**

运行：`npm test -- tests/production-scripts.test.ts`

预期：因脚本和 npm 命令不存在而失败。

- [ ] **步骤 3：实现串行命令入口**

入口只选择 `ingest.source_file.state = 'complete'` 的来源，按 `discovered_at` 串行调用 `PgSecondaryProcessingBuilder`；所有来源覆盖验证成功后调用 `PgValueProfiler`。日志事件只输出来源 ID、阶段、计数、耗时和错误代码。

```ts
const sources = await pool.query(
  "SELECT id::text FROM ingest.source_file WHERE state = 'complete' ORDER BY discovered_at, id"
);
for (const source of sources.rows) {
  const result = await builder.processSource(String(source.id));
  console.info(JSON.stringify({ event: "SECONDARY_SOURCE_COMPLETE", sourceFileId: source.id, ...result }));
}
await profiler.rebuild(NORMALIZER_VERSION);
```

- [ ] **步骤 4：实现启动脚本**

脚本顺序固定为：检查 db 健康、停止常驻 app、防止并发、构建镜像、运行迁移、执行 `process:secondary`、验证成功后恢复 app。失败时保留 db 和检查点，不自动恢复 app，以免掩盖失败状态。

```bash
docker compose ps db
docker compose stop app
docker compose build app
docker compose run --rm app npm run migrate
docker compose run --rm app npm run process:secondary
docker compose up -d app
```

- [ ] **步骤 5：实现监控脚本**

每 30 秒输出来源级标准化覆盖、当前流水线检查点、活跃数据库操作、表大小、WAL 和临时 I/O 增量；不查询或打印 raw JSON。支持 `ONCE=1` 单次输出，便于用户把一个日志文件传回排查。

- [ ] **步骤 6：校验 shell 和聚焦测试**

```bash
bash -n scripts/run-secondary-processing.sh scripts/watch-secondary-processing.sh
npm test -- tests/production-scripts.test.ts
```

预期：语法和测试全部通过。

- [ ] **步骤 7：提交运行入口**

```bash
git add src/db/run-secondary-processing.ts package.json scripts/run-secondary-processing.sh scripts/watch-secondary-processing.sh tests/production-scripts.test.ts
git commit -m "ops: add secondary processing runner and monitor"
```

---

### 任务 7：只读质量报告和验收门禁

**文件：**

- 新建：`scripts/secondary-quality-report.sh`
- 新建：`tests/secondary-quality-report.test.ts`
- 新建：`docs/secondary-processing-operations.md`
- 修改：`docs/progress.md`

**接口：**

- 产出：`/tmp/person-relation-secondary-quality-latest.log`。
- 成功标记：`SECONDARY_QUALITY_PASS`。
- 失败标记：`SECONDARY_QUALITY_FAIL`，并返回非零退出状态。

- [ ] **步骤 1：编写只读报告合同失败测试**

```ts
expect(script).toContain("SET TRANSACTION READ ONLY");
expect(script).toContain("SECONDARY_QUALITY_PASS");
expect(script).toContain("SECONDARY_QUALITY_FAIL");
expect(script).toContain("/tmp/person-relation-secondary-quality-latest.log");
expect(script).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\s+/i);
```

- [ ] **步骤 2：运行报告测试并确认失败**

运行：`npm test -- tests/secondary-quality-report.test.ts`

预期：因脚本不存在而失败。

- [ ] **步骤 3：实现聚合报告**

报告必须输出：

- 每个来源 raw、person observation 和 `normalizer-v1` 数量；
- 完成和未完成来源数量；
- 每个渠道的非空覆盖率；
- 每个渠道按 `person_count` 分段的属性数量；
- 各质量标记数量；
- 当前活跃二次加工 SQL；
- 所有检查结果的 JSON 汇总。

报告不得输出姓名、身份证、手机号、邮箱、地址、单位明文或单个属性哈希。

报告 SQL 必须从只读事务开始，并只返回计数：

```sql
BEGIN READ ONLY;
SELECT f.relative_path,
  COUNT(DISTINCT r.id) AS raw_rows,
  COUNT(DISTINCT o.raw_record_id) AS projected_rows,
  COUNT(DISTINCT n.raw_record_id) AS normalized_rows
FROM ingest.source_file f
LEFT JOIN raw.record r ON r.source_file_id = f.id
LEFT JOIN core.person_observation o ON o.raw_record_id = r.id
LEFT JOIN analytics.normalized_observation n
  ON n.raw_record_id = r.id AND n.normalizer_version = 'normalizer-v1'
GROUP BY f.id, f.relative_path;
COMMIT;
```

- [ ] **步骤 4：实现失败条件**

存在以下任一情况即返回非零：来源未完成、标准观察与 person observation 数量不一致、检查点未完成、出现空字符串哈希、画像桶不完整或出现数据库错误。

- [ ] **步骤 5：编写中文运维说明**

说明启动、查看单次状态、持续监控、安全停止、恢复、生成验收报告和日志路径。明确生产规模首次运行只生成 `normalizer-v1` 和画像，不生成 `relation-v4`。

- [ ] **步骤 6：运行聚焦测试和完整门禁**

```bash
bash -n scripts/secondary-quality-report.sh
npm test -- tests/secondary-quality-report.test.ts tests/production-scripts.test.ts
npm run verify
```

预期：所有测试、ESLint 和 TypeScript 构建通过。

- [ ] **步骤 7：提交报告和文档**

```bash
git add scripts/secondary-quality-report.sh tests/secondary-quality-report.test.ts docs/secondary-processing-operations.md docs/progress.md
git commit -m "ops: add secondary quality acceptance report"
```

---

### 任务 8：合成 PostgreSQL 冒烟和交付检查

**文件：**

- 新建：`scripts/smoke-secondary-processing.sh`
- 修改：`tests/production-scripts.test.ts`
- 修改：`docs/progress.md`

**接口：**

- 产出：只使用临时合成数据库的 `SECONDARY_SMOKE_PASS` 冒烟门禁。

- [ ] **步骤 1：编写冒烟脚本合同失败测试**

测试要求脚本创建独立 Compose project name 和临时 volume，只插入合成数据，并在 trap 中清理自身创建的资源；不得连接默认生产数据库或读取 `/imports`。

- [ ] **步骤 2：实现合成数据冒烟**

夹具覆盖：有效身份证重复记录、无效身份证、缺失地址、共享私人手机号、公共单位和可恢复的中断点。执行迁移、标准观察、频率画像和质量报告，断言 `SECONDARY_QUALITY_PASS`。

- [ ] **步骤 3：运行 shell 和完整验证**

```bash
bash -n scripts/smoke-secondary-processing.sh
npm run verify
```

如果当前环境有 Docker，再运行：

```bash
./scripts/smoke-secondary-processing.sh
```

预期：仓库门禁通过；有 Docker 时输出 `SECONDARY_SMOKE_PASS`。

- [ ] **步骤 4：核对数据安全和版本隔离**

运行：

```bash
rg -n "CtfId|Mobile|Address|EMail" tests scripts docs
rg -n "relation-v3" migrations/005_secondary_processing_foundation.sql src/db/secondary-processing-*.ts src/db/value-profiler.ts
```

预期：测试只包含合成值；二次加工代码没有更新或删除 `relation-v3` 的 SQL。

- [ ] **步骤 5：记录阶段交付状态并提交**

```bash
git add scripts/smoke-secondary-processing.sh tests/production-scripts.test.ts docs/progress.md
git commit -m "test: add secondary processing smoke gate"
```

---

## 生产规模执行门槛

代码合并前只允许在合成数据上执行完整写入冒烟。目标 Mac 的 20,051,414 条数据首次运行必须由 `scripts/run-secondary-processing.sh` 启动，并先确认：

1. 基线仍为 `BASELINE_PASS`；
2. PostgreSQL 至少保留预计派生表增长两倍的可用磁盘空间；
3. app 已停止且没有旧关系投影 SQL；
4. 监控日志能够输出批次速度、WAL、临时 I/O 和预计完成时间；
5. 本次只启用 `normalizer-v1` 与属性频率画像，不启用 `relation-v4`。

生产执行完成后，以 `SECONDARY_QUALITY_PASS` 作为第一阶段验收证据，并把聚合计数写入 `docs/progress.md`；不得提交真实日志或个人记录。
