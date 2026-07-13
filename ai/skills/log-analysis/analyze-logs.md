# Reactory Log Analysis Skill

## Overview
This skill provides guidelines and best practices for analyzing JSON log files within the Reactory environment. Reactory logs are typically stored in the `REACTORY_DATA/logging` directory. Because log files can grow exceptionally large, it is critical to use targeted, token-efficient strategies when searching and reading them.

## Core Directives

1. **NEVER use `readFile` on log files.**
   Log files can easily exceed your token context limit. Always use the `shell` tool with command-line utilities (`grep`, `tail`, `head`, `jq`, `awk`) to extract only the information you need.

2. **Smart Directory Listing.**
   The logging directory may contain hundreds of files. Do not run a plain `ls` or `listDirectory`.
   - Use `ls -lt | head -n 20` to see the most recently modified log files.
   - Use `find . -name "*.log" -mtime -1` to find files modified in the last day.

3. **Start Specific, Then Broaden.**
   - **Specific First:** Always begin your search with specific identifiers if you have them (e.g., a `correlationId`, a specific `userId`, or a precise timestamp).
   - **Broaden as Needed:** If your specific search yields no results, gradually remove constraints (e.g., search for "ERROR" in a specific 5-minute window).

4. **Filter and Format with `jq`.**
   Reactory logs are formatted as JSON (often JSONL/ndjson). Using `jq` is the most effective way to extract meaningful data while stripping out verbose, token-heavy fields.
   - *Example:* Extracting only the timestamp, level, and message from the last 100 lines:
     `tail -n 100 server.log | jq -c '{time: .timestamp, level: .level, msg: .message, err: .error}'`
   - *Example:* Searching for a specific correlation ID and pretty-printing:
     `grep "req-12345" server.log | jq .`

5. **Limit Output.**
   Always pipe your results through `head` or use `jq` limits if you expect a large number of matches.
   - *Example:* `grep "ERROR" server.log | head -n 50 | jq .`

## Recommended Workflow

1. **Identify the Target File(s):**
   ```bash
   cd $REACTORY_DATA/logging && ls -lt | head -n 10
   ```
2. **Scan Recent Errors (if investigating an incident):**
   ```bash
   tail -n 1000 application.log | grep -i "error" | jq -c '{time: .timestamp, msg: .message}' | head -n 20
   ```
3. **Deep Dive on a Correlation ID:**
   Once you find an error, extract its correlation ID and fetch the full request lifecycle:
   ```bash
   grep "corr-8f7d6" application.log | jq -c '{time: .timestamp, level: .level, msg: .message}'
   ```

## Summary
By using `shell`, `grep`, `tail`, and `jq`, you ensure that you only bring the necessary diagnostic data into your context window. This preserves your tokens for reasoning and analysis rather than wasting them on raw log ingestion.