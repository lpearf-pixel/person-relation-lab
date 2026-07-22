import type { RelationshipResponse } from "../app.js";
import { FIND_PATHS_SQL, type Queryable } from "./repository.js";

export class PgRelationshipService {
  constructor(private readonly database: Queryable) {}

  async query(personA: string, personB: string): Promise<RelationshipResponse | null> {
    const left = await this.resolveUnique(personA);
    if (!left) return null;
    const right = await this.resolveUnique(personB);
    if (!right) return null;
    const paths = await this.database.query(FIND_PATHS_SQL, [left, right, 10]);
    const best = paths.rows[0];
    if (!best || !Array.isArray(best.edge_ids)) return null;
    const details = await this.database.query(
      `SELECT DISTINCT ev.explanation, rel.relation_type, rel.completeness
       FROM projection.relationship rel
       LEFT JOIN evidence.relationship_evidence ev
         ON ev.person_a_id = rel.person_a_id
        AND ev.person_b_id = rel.person_b_id
        AND ev.algorithm_version = rel.algorithm_version
       WHERE rel.id = ANY($1::uuid[]) ORDER BY ev.explanation NULLS LAST`,
      [best.edge_ids]
    );
    const depth = Number(best.depth);
    const first = details.rows[0];
    return {
      relationType: depth === 1 ? String(first?.relation_type ?? "direct_association") : "indirect_association",
      confidence: Number(best.strength),
      completeness: Number(first?.completeness ?? 0.5),
      evidence: details.rows.map((row) => String(row.explanation)).filter((value) => value !== "undefined" && value !== "null"),
      disclaimer: "该结果仅表示数据关联，不能证明恋爱、亲属或婚外关系，需结合合法资料人工核验。"
    };
  }

  private async resolveUnique(name: string): Promise<string | null> {
    const result = await this.database.query(
      "SELECT id FROM core.person WHERE canonical_name = $1 ORDER BY id LIMIT 2", [name]
    );
    return result.rows.length === 1 ? String(result.rows[0]?.id) : null;
  }
}
