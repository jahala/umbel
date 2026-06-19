## tend — Feature Map

tend tracks planned work across sessions. If it's not updated, the next session starts blind.

### Start here
1. `/tend position` — define who you're building for (personas + jobs)
2. `/tend brainstorm` — shape your first feature into slots + checks
3. `/tend plan` — break it into testable steps
4. `/tend run` — build it
5. `/tend audit` — verify it with real evidence

When you need it: `/tend discover` (map an existing codebase into features) · `/tend change` (requirement changes) · `/tend narrate` (write the article body)

### Daily loop
1. `/tend` — see status + what's unblocked
2. Pick the suggested feature or choose from the list
3. No plan? → `/tend plan` creates implementation steps
4. Implement steps — `tend_update_feature` with steps[] (by-id merge) as you complete each
5. All done? → `/tend audit` verifies code matches checks

### Before you build
When asked to implement multi-file changes, check tend first:
1. `ls docs/tend/features/` (or `tend_get_unblocked`) — does this work map to a feature?
2. No match → `/tend brainstorm` to create one (minimal draft is fine)
3. Match → `tend_update_feature` with the touched step's status as you complete each

### MCP tools
- `tend_get_context` — full feature context in one call
- `tend_get_unblocked` — what to work on next
- `tend_update_feature` — single write surface; step status is one of many fields
- `tend_get_gaps` — what needs attention; each gap names the closing skill
- `npx tend-cli ui` — generate web dashboard and open in browser

For reads of a single feature, use the polyglot: `bash docs/tend/<id>.tend.html data | jq`.
