# Skill: Querying Data And Visualizing

## Purpose
Use this skill when a user asks for data analysis, reporting, dashboard-like outputs, trends, comparisons, or visualizations from configured data sources.

This skill combines:
- Server-side data tools for connection discovery and querying data: `listDataConnections`, `postgres`, `mysql`, `mssql`, `mongo`, and search tools such as `searchContent` where relevant.
- Client-side visualization tools for rendering results in the chat side panel: `chart` and `d3`.

## When To Use
- The user asks to analyze records from SQL or MongoDB sources.
- The user asks for summaries, aggregations, top-N reports, or trend analysis.
- The user asks for a chart/graph to inspect results visually.
- The user asks for side-by-side comparisons between categories/time periods.

## Tool Capabilities

### Server-Side Data Access
- `listDataConnections`
	- First tool to call before any database query macro.
	- Returns only connections available to the current user/agent after role checks.
	- Provides valid `connectionId` values and their `variant` for safe tool routing.

- `postgres`, `mysql`, `mssql`
	- Read queries only (SELECT semantics enforced by validation).
	- Supports `format`: `json`, `csv`, `markdown`, `text`.
	- Returns structured payload in `data.result.rows`, `data.result.columns`, `data.result.rowCount`.

- `mongo`
	- Read operations for MongoDB (`filter`, `projection`, `sort`, `limit`, `skip`, `pipeline`).
	- Supports aggregation pipelines for grouped/trended analysis.

- `mongoWrite`
	- Write operations. Do not use for analysis unless user explicitly requests data mutation.

- Search helpers (`searchContent`, etc.)
	- Useful when the user asks to search indexed content rather than query a transactional DB.

### Client-Side Visualization
- `chart`
	- Good for fast business charts (`pie`, `bar`, `line`, `funnel`, `composed`).
	- Supports side panel `add`, `update`, `remove` with `referenceId`.

- `d3`
	- Good for richer visualization types (`bar`, `line`, `area`, `pie`, `donut`, `scatter`, `histogram`, `tree`, `force`).
	- Supports side panel `add`, `update`, `remove` with `referenceId`.

- `side_panel_state`
	- Always use this before `update`/`remove` to get current `referenceId`s.

## Operational Workflow

1. Discover available connections first.
	 - Call `listDataConnections` with no filters.
	 - If needed, call `listDataConnections` with `variant` or `variants` to narrow choices.
	 - Select `connectionId` from returned results only; do not guess IDs.

2. Clarify the analysis intent.
	 - Identify metric(s), dimensions, time range, filters, grouping, and desired output shape.

3. Choose the right backend tool.
	 - Match tool to chosen connection `variant`:
	 - `postgres` -> PostgreSQL connection
	 - `mysql` -> MySQL connection
	 - `mssql` -> MSSQL connection
	 - `mongo` -> MongoDB connection
	 - For indexed content search (not DB connections), use `searchContent`.

4. Query minimally first.
	 - Run a `COUNT(*)` / count pipeline first to estimate result size before selecting full rows.
	 - Start with small limits and focused fields.
	 - Validate data types and column names.

5. Refine query for analysis.
	 - Add grouping/aggregation, date bucketing, sorting, and null handling.
	 - If count indicates a large/bloated dataset, avoid loading full records into chat context.

6. Handle large datasets with export + notebook runtime.
	 - Export the dataset in `csv` format using the query macro (`postgres`/`mysql`/`mssql` or `mongo`).
	 - Prefer `file: true` for large extracts to persist data to disk.
	 - Use Jupyter notebook/runtime analysis on exported CSV instead of forcing huge in-chat payloads.
	 - Return a concise summary and key statistics in chat; keep deep exploration in notebook cells.

7. Build analysis summary.
	 - Report key insights, totals, outliers, and caveats.
	 - If numbers drive decisions, include exact values and calculation basis.

8. Visualize when useful.
	 - Use `chart` for quick standard visuals.
	 - Use `d3` for advanced chart semantics or network/hierarchy views.

9. Manage side-panel lifecycle.
	 - For updates/removals, call `side_panel_state` first.
	 - Reuse `referenceId` to update instead of adding duplicates.

## Connection Discovery Patterns

### Discover All Usable Connections

```json
{
	"tool": "listDataConnections",
	"arguments": {}
}
```

### Discover Only SQL Connections

```json
{
	"tool": "listDataConnections",
	"arguments": {
		"variants": ["postgres", "mysql", "mssql"]
	}
}
```

### Discover Only Mongo Connections

```json
{
	"tool": "listDataConnections",
	"arguments": {
		"variant": "mongo"
	}
}
```

## Data Query Patterns

### Count-First Pattern (Required For Unknown Sizes)
Use this pattern before selecting large record sets.

```json
{
	"tool": "postgres",
	"arguments": {
		"connectionId": "analytics-db",
		"name": "Orders Count (Date Range)",
		"query": "SELECT COUNT(*) AS total FROM orders WHERE created_at >= NOW() - INTERVAL '12 months'",
		"format": "json",
		"cache": true
	}
}
```

Decision rule:
- If count is small/moderate, continue with in-chat analysis queries.
- If count is large (data bloat risk), switch to CSV export + notebook workflow.

### Large Dataset Export Pattern (CSV)

```json
{
	"tool": "postgres",
	"arguments": {
		"connectionId": "analytics-db",
		"name": "Orders Export 12 Months",
		"query": "SELECT id, created_at, status, amount, customer_id FROM orders WHERE created_at >= NOW() - INTERVAL '12 months' ORDER BY created_at DESC",
		"format": "csv",
		"file": true,
		"cache": false
	}
}
```

After export:
- Use notebook/runtime tooling for heavy joins, profiling, and iterative exploration.
- Use chat for executive summaries, decisions, and next-step recommendations.

### SQL Aggregation Pattern
Use for top-N, grouped summaries, and time-series rollups.

First call `listDataConnections` and choose a returned PostgreSQL `connectionId`.

```json
{
	"tool": "postgres",
	"arguments": {
		"connectionId": "analytics-db",
		"name": "Revenue By Month",
		"query": "SELECT DATE_TRUNC('month', created_at) AS month, SUM(amount) AS revenue FROM orders WHERE created_at >= NOW() - INTERVAL '12 months' GROUP BY 1 ORDER BY 1",
		"format": "json",
		"cache": true
	}
}
```

### Mongo Aggregation Pattern
Use for document analytics and grouped summaries.

First call `listDataConnections` with `variant: "mongo"` and use a returned `connectionId`.

```json
{
	"tool": "mongo",
	"arguments": {
		"connectionId": "mongo-analytics",
		"name": "Orders By Status",
		"collection": "orders",
		"pipeline": [
			{ "$match": { "createdAt": { "$gte": "2026-01-01T00:00:00.000Z" } } },
			{ "$group": { "_id": "$status", "count": { "$sum": 1 }, "totalAmount": { "$sum": "$amount" } } },
			{ "$sort": { "count": -1 } }
		],
		"format": "json"
	}
}
```

## Visualization Patterns

### Quick Business Chart (chart)

```json
{
	"tool": "chart",
	"arguments": {
		"action": "add",
		"type": "bar",
		"title": "Orders By Status",
		"data": [
			{ "name": "PENDING", "value": 124 },
			{ "name": "COMPLETED", "value": 980 },
			{ "name": "FAILED", "value": 37 }
		],
		"options": {
			"showLegend": false,
			"showGrid": true,
			"xAxisKey": "name",
			"dataKeys": ["value"]
		}
	}
}
```

### Advanced Scatter/Distribution (d3)

```json
{
	"tool": "d3",
	"arguments": {
		"action": "add",
		"type": "scatter",
		"title": "Latency vs Throughput",
		"data": [
			{ "rps": 120, "latency": 45, "tier": "free" },
			{ "rps": 800, "latency": 22, "tier": "pro" }
		],
		"xKey": "rps",
		"yKey": "latency",
		"y2Key": "tier",
		"showLegend": true
	}
}
```

### Update Existing Visualization
First call `side_panel_state`, then update by `referenceId`.

```json
{
	"tool": "chart",
	"arguments": {
		"action": "update",
		"referenceId": "existing-chart-id",
		"title": "Updated Revenue Trend",
		"data": [
			{ "name": "Jan", "value": 42000 },
			{ "name": "Feb", "value": 51000 }
		]
	}
}
```

## Guardrails

1. Do not mutate data for analysis unless explicitly requested.
	 - Avoid `mongoWrite` by default.
	 - Never infer or fabricate connection IDs; always obtain them via `listDataConnections`.

2. Prefer server-side aggregation over client-side heavy computation.
	 - Push filtering/grouping into SQL/Mongo pipelines.

3. Keep result sets bounded.
	 - Count first before full-row selection when dataset size is unknown.
	 - Use `LIMIT` (SQL) or `limit` (Mongo).
	 - Summarize before visualizing.
	 - For bloated datasets, export CSV and analyze in notebook/runtime.

4. Preserve numeric fidelity.
	 - Avoid rounding too early.
	 - State units (currency, ms, counts, percentage).

5. Be explicit about assumptions.
	 - Timezone, date bucketing, null treatment, and excluded records.

## Response Style For Users
- Lead with findings, not raw dumps.
- Include: key insight, supporting numbers, and recommended next drill-down.
- Use a chart when it improves comprehension.
- If query fails, provide likely fix (connectionId, field name, permissions, malformed filter/query).

## Skill Completion Checklist
- Correct data source tool selected.
- Query executed successfully and validated.
- Results summarized with key findings.
- Visualization added or updated when helpful.
- Side panel state managed correctly for update/remove flows.
