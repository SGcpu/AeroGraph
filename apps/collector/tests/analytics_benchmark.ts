import Database from "better-sqlite3";
import { runMigrations } from "../src/sqlite/migrate";
import { SqliteTraceStore } from "../src/sqliteStore";

export async function runBenchmark() {
  console.log("=== AeroGraph Analytics Benchmark (100k events) ===");
  const db = new Database(":memory:");
  runMigrations(db);
  const store = new SqliteTraceStore(db);

  // Generate 100k mock events
  console.log("Generating 100,000 mock events...");
  const startInsert = Date.now();
  const insertStmt = db.prepare(`
    INSERT INTO events (
      trace_id, span_id, parent_span_id, occurred_at, kind, event_data,
      model_name, model_provider, model_version,
      usage_input_tokens, usage_output_tokens, usage_total_tokens, usage_cached_tokens,
      duration_ms, project_id, environment, tags_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((events: any[]) => {
    for (const e of events) {
      insertStmt.run(
        e.trace_id, e.span_id, e.parent_span_id, e.occurred_at, e.kind, e.event_data,
        e.model_name, e.model_provider, e.model_version,
        e.usage_input_tokens, e.usage_output_tokens, e.usage_total_tokens, e.usage_cached_tokens,
        e.duration_ms, e.project_id, e.environment, e.tags_json
      );
    }
  });

  const mockEvents = [];
  for (let i = 0; i < 100000; i++) {
    const traceNum = Math.floor(i / 5); // 5 events per trace
    const isResponse = i % 5 === 4;
    mockEvents.push({
      trace_id: `t_bench_${traceNum}`,
      span_id: `s_bench_${i}`,
      parent_span_id: i % 5 === 0 ? null : `s_bench_${i - 1}`,
      occurred_at: new Date(Date.now() - i * 1000).toISOString(),
      kind: isResponse ? "response" : "prompt",
      event_data: "{}",
      model_name: isResponse ? "gpt-4-turbo" : null,
      model_provider: isResponse ? "openai" : null,
      model_version: isResponse ? "2024-05-13" : null,
      usage_input_tokens: isResponse ? 150 : null,
      usage_output_tokens: isResponse ? 80 : null,
      usage_total_tokens: isResponse ? 230 : null,
      usage_cached_tokens: isResponse ? 0 : null,
      duration_ms: isResponse ? 850 : 120,
      project_id: `proj_${traceNum % 10}`, // 10 projects
      environment: i % 2 === 0 ? "production" : "development",
      tags_json: '{"version":"1.0.0"}'
    });
  }

  transaction(mockEvents);
  console.log(`Inserted 100,000 events in ${Date.now() - startInsert}ms.`);

  // Verify Project / Environment filtering query
  console.log("\n1. Verifying Project/Environment Filtering Performance:");
  const filterStart = Date.now();
  const filterRows = db.prepare("SELECT COUNT(*) as count FROM events WHERE project_id = ? AND environment = ?").get("proj_3", "production") as any;
  const filterDuration = Date.now() - filterStart;
  console.log(`- Found ${filterRows.count} events in ${filterDuration}ms (Target: <500ms)`);

  const planFilter = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE project_id = ? AND environment = ?").all("proj_3", "production") as any[];
  console.log("- Query Plan:");
  planFilter.forEach(p => console.log(`  ${p.detail}`));

  // Verify Token Aggregations
  console.log("\n2. Verifying Token Aggregations Performance:");
  const tokenStart = Date.now();
  const tokenRows = db.prepare("SELECT SUM(usage_total_tokens) as total FROM events WHERE project_id = ?").get("proj_3") as any;
  const tokenDuration = Date.now() - tokenStart;
  console.log(`- Sum: ${tokenRows.total} tokens in ${tokenDuration}ms (Target: <500ms)`);

  const planTokens = db.prepare("EXPLAIN QUERY PLAN SELECT SUM(usage_total_tokens) FROM events WHERE project_id = ?").all("proj_3") as any[];
  console.log("- Query Plan:");
  planTokens.forEach(p => console.log(`  ${p.detail}`));

  // Verify Duration Aggregations
  console.log("\n3. Verifying Duration Aggregations Performance:");
  const durationStart = Date.now();
  const durationRows = db.prepare("SELECT AVG(duration_ms) as avg_dur FROM events WHERE project_id = ?").get("proj_3") as any;
  const durationDuration = Date.now() - durationStart;
  console.log(`- Avg Duration: ${durationRows.avg_dur}ms in ${durationDuration}ms (Target: <500ms)`);

  const planDuration = db.prepare("EXPLAIN QUERY PLAN SELECT AVG(duration_ms) FROM events WHERE project_id = ?").all("proj_3") as any[];
  console.log("- Query Plan:");
  planDuration.forEach(p => console.log(`  ${p.detail}`));

  // Closing
  db.close();
  console.log("\n=== Benchmark Completed ===");
}

runBenchmark().catch(console.error);
