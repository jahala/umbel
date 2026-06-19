---
name: tend-narrate
description: Author the article-style narrative body and inline SVG diagrams for a feature, subpage, or garden polyglot. Writes the `narrative` (markdown) and `media` (inline SVG / base64) fields. Trigger when a polyglot has slots + checks but its main content reads as a structured form rather than a focused essay — or after `/tend run` lands implementation when there's a clear story to tell about how the feature actually works.
user-invocable: true
---

# Narrate: Slots + Code -> Article + Diagrams

**Owns**: `narrative` (markdown body, optional) and `media` (inline SVG /
base64 images keyed by id, optional) on any kind — feature, subpage,
garden.

## How this skill must be invoked

This skill produces *narrative content*. It must be exercised end-to-end
— not bypassed.

- **Invoke via the Skill tool** (the agent reads this file and follows
  the workflow) — or via `/tend narrate` on the command line for human
  use. When an upstream agent needs many narratives written, it
  dispatches **one subagent per polyglot** with this skill loaded; it
  does **not** write a python loop that calls `tend_update_feature`
  with pre-baked strings.
- **No external helper scripts** that bake narratives outside the skill.
  Anything that touches `oo-data.narrative` must come from a Skill run
  on that specific polyglot — that's how the quality bar is enforced.
  Scripts that *orchestrate* parallel skill runs are fine; scripts that
  *substitute for* a skill run are not.
- **Reads always go through tend's surfaces** — `bash <file>.tend.html data
  | jq` for one polyglot, MCP `tend_get_context({ id, include_project_context })`
  for the project index. Don't reinvent oo-data extraction with regex
  in a node-eval script when the bash verb exists.

## Purpose

Tend's main column is the *article*. The bet (six slots) is the lead. The
rail holds graph and schema metadata. **The narrative is the body** —
prose that ties the bet's one-liners into a coherent story, with embedded
diagrams where pictures carry the load words can't.

A page with only slots reads like a form. A page with rich narrative reads
like a focused essay — the difference between someone scanning your
project and someone understanding it.

## What this skill assumes

- The feature has slots, checks, and decisions written (output of `/tend brainstorm`).
- The catalog has `personas[].archetype` and `personas[].jobs[]` populated, and `opportunities[].personas` bound. If empty, redirect to `/tend position` — without the spine, narrative defaults to declarative voice.
- The feature's checks carry `validates_job` where personas are bound. The narrative reads those pointers to find which persona-jobs to ground the story in.
- The `coverage_files` exist on disk and are readable — narrative grounds itself in real code, not abstraction.

## Persona / opportunity polyglots have a different shape

When the polyglot has `data.persona` set (detect via `bash <file> data | jq '.persona // .opportunity'`), it is a catalog description, not a feature bet. Write persona-shape narrative sections instead of slot prose:

- `## Voice` — how this persona talks, with sample lines
- `## Scenarios` — one or two concrete moments (e.g. "11pm Tuesday, kids asleep…")
- `## Why this archetype matters` — context the rail's truncated archetype tease can't carry

When the polyglot has `data.opportunity` set, write:

- `## What good looks like` — paragraph elaborating `outcome_metric` (why this is the right measurable, how to read it)
- `## The riskiest assumption` — paragraph elaborating `riskiest_assumption` (why it's risky, what would disconfirm it)
- `## Where the signal came from` — paragraph elaborating `source` / `signals` (historical context, related conversations, evidence base)

The structured fields provide the section headings; narrative fills the bodies. Do NOT repeat structured rail content (value/confidence chips, bound_features list, etc.) — that's the rail's job.

## Reads

- The polyglot's `oo-data` (slots, checks, steps, decisions, references,
  cost, audit, status)
- The garden's `catalog` (phases / personas / opportunities / components)
  for cross-references
- **Each check's `validates_job`** — `<persona_id>:<job_index>`, resolves
  to `catalog.personas[<id>].jobs[<idx>]`. The persona-job's `situation`
  is the scenario opener for any narrative that proves it; the
  `validation` clause is the measurable truth-claim the narrative must
  honor when it says "the user gets X". Follow every bound check up to
  its persona-job before drafting.
- **`opportunity.personas`** — for every opportunity the feature
  `solves`, the bound personas are who feels that pain. The "why this
  matters" beat in narrative names those personas concretely, not
  "users" in the abstract.
- Each file listed in `coverage_files` (the actual code that implements
  the feature) — narrative grounds itself in the code, not in abstraction
- Related features' slot text (the ones in `dependencies` / `enables` /
  `subpages` / `parent`) for context
- Existing `decisions[]` — these often *are* the narrative; weave them in,
  don't list them separately
- **The full project index** via
  `tend_get_context(id, { include_project_context: true })` — returns
  `project_index: [{id, title, kind, path, parent?, narrative}]`
  for every polyglot (garden + features + subpages). This is your
  inline-link target list and your existing-voice survey, both in one
  call. Use it before drafting.

## Writes

- `oo-data.dek` — 2–3 authored sentences: the standfirst. Who hurts, what
  this does, what changed — the story the slots can't tell as a form. The
  renderer places it deterministically: as the standfirst above the bet
  article AND as the lead copy of the page's masthead band (the full-width
  header carrying title, status card, and hero visual). You never write
  masthead HTML — the band is a pure render-time projection of fields you
  author here; a page without a dek keeps the compact header, and authoring
  one is what upgrades it. The dek is staleness-tracked against the six
  slots (`dek_stale` surfaces in the refinement backlog when slots drift;
  rewrite the dek to clear it).
- `oo-data.narrative` — markdown string. Article body. Renders in main
  between bet article and decisions section. Renderer parses `## h2` and
  `### h3` to populate the left TOC at view time.
- `oo-data.media` — `{ <media_id>: { kind: "diagram" | "svg" |
  "image_base64", ... } }`. Prefer `kind: "diagram"`: author a typed `spec`
  (flow / layers / journey / compare / anatomy) and the write side-effect
  renders it to deterministic, on-palette SVG — never hand-write SVG for
  shapes the specs cover. The FIRST media entry also becomes the masthead's
  hero visual, so lead with the diagram that best orients a cold reader.
  Freehand `svg` / `image_base64` remain for shapes the typed specs can't
  express (the visual-consistency contract + preview loop govern them).
  Referenced from narrative via `[diagram_id]` (renderer resolves).

All fields are written via `tend_update_feature` (atomic; MCP runs the
schema validate + auto-side-effects, renders diagram specs, and stamps
`dek_sha` / `spec_sha`).

## Quality bar — what makes a narrative good

This skill exists because narrative quality decays without discipline.
Every section, every paragraph, every diagram must clear these bars:

1. **Every paragraph adds signal.** No filler. No "this feature is important
   because important things are important." Some echo of the bet is fine
   where it anchors the reader for what comes next — but the narrative
   must go *deeper* than the bet's one-liners, not paraphrase them.
2. **Don't duplicate what other polyglots already say.** Each polyglot
   tells *its own slice* of the story. When the prose touches another
   polyglot's content, **link to it inline**, don't restate it.
   - Garden narrative (`docs/tend/overview.html`): tells the project story.
     Link form to a feature: `the [auth system](features/auth.tend.html)`
     (garden lives one level *up* from features, so the path includes
     `features/`). The garden should NOT re-explain how a feature
     works, what its endpoints do, what each flow returns, etc.
   - Feature narrative (`docs/tend/features/<id>.tend.html`): tells one
     capability's story. Link form to a sibling feature or subpage is
     **bare**: `the [order pipeline](order-pipeline.tend.html)`. Do **NOT**
     prefix with `features/` — feature pages are already in that directory.
     Link form to the garden is `../overview.html#anchor`.
   - Subpage narrative: focuses on one dimension. Same link rules as features.
3. **Concrete > abstract.** Use actual file paths, function names, command
   strings. Reference the code in `coverage_files` directly. **Cite convention**:
   write first-party file paths as `` `src/foo.ts` `` or `` `src/foo.ts:funcName` ``
   (backtick-bounded). The validator extracts these cites and checks each path
   resolves on disk — when the code moves, the narrative drifts loudly as
   `narrative_cite_stale` instead of silently.
4. **Inline links, woven into the sentence.** Every named polyglot in
   `project_index` should be a live link. Run a quick scan before shipping.
5. **One angle per section.** A section explains one thing. If you find
   yourself adding "also" in a section, it probably needs its own heading.
6. **No "TBD" sections.** If you don't have anything to say in a section,
   don't write the heading. The renderer auto-elides empty narrative.
7. **Voice is direct, present-tense, plain.** Avoid "we will" / "would
   need to" / "should consider". Write what *is*.
8. **Truth-claims honor the bound validation clauses.** When the feature's
   checks carry `validates_job`, every "the user gets X" claim in the
   narrative must mirror the bound persona-job's `validation` text.
9. **Greenfield posture.** A polyglot narrative is not a retrospective.
   The persona / feature / decision IS — write it as if it always was.
   Sections explaining *why it was missing until now* or *what its
   existence newly enables* belong in git commit messages, not the artifact.
10. **Section titles are headlines, not labels.** See
    [`references/section-themes.md`](references/section-themes.md) for
    the full rewrite table. The TOC will be the most-scanned part of
    the page — make it earn the scan.
11. **Diagrams earn their place.** See
    [`references/diagram-conventions.md`](references/diagram-conventions.md)
    for triggers, quality bar, and anti-patterns.

## Workflow

### 0. Read drift_verdict

Before drafting, check `drift_verdict` from `tend validate`. If it's `unclaimed`, the named file has no feature owner — claim it via `tend_update_feature({ id, changes: { coverage_files: [...] } })` *before* narrating. The narrative must point at code that's owned; orphan code is unfinished thinking. If `drift_verdict` is `narrative-cite-stale`, this skill's last output went stale — refresh the cited paths in the named feature's narrative before drafting elsewhere.

### 1. Load context

```bash
bash docs/tend/features/<id>.tend.html data | jq
bash docs/tend/overview.html data | jq '.catalog'
```

For each file in `coverage_files`, open and skim it. Narrative grounds in
the code; you can't write `## How it works` without having read the code.

For each related feature (deps + enables + subpages + parent),
read its bet at minimum:

```bash
bash docs/tend/features/<other-id>.tend.html data | jq '{what, why, impact, fit, where, how}'
```

### 1.5. Survey the whole project — your inline-link target list

**Before drafting, load the full project index.** You cannot write good
narrative in isolation — you don't know what's already been said, what
voice is established, what's worth linking to, what already covers the
ground you're about to write on.

Use the MCP tool when available:

```javascript
tend_get_context({ id: "<your polyglot id>", include_project_context: true })
```

The response includes `project_index` — an array of every polyglot in
the project with `{id, title, kind, path, parent?, status, narrative}`.
This is two things at once: your **inline-link target list** and your
**existing-voice survey**. Read the narratives of every polyglot whose
territory you might cross.

If MCP isn't available (working on a shipped polyglot offline):

```bash
for f in docs/tend/features/*.tend.html docs/tend/overview.html; do
  bash "$f" data 2>/dev/null | jq -r '
    "─── " + (.id // "?") + " ───",
    "  what: " + ((.what // "(empty)") | .[0:120]),
    "  narrative: " + ((.narrative // "") | length | tostring) + " chars",
    ""
  '
done

# Dump one narrative in full:
bash docs/tend/features/<id>.tend.html data | jq -r '.narrative'
```

**Also load the positioning data** — personas with archetype + Klement
Job Stories, and the opportunity catalog:

```bash
bash docs/tend/overview.html data | jq '{
  personas: .catalog.personas,
  opportunities: .catalog.opportunities
}'
```

**Hard early-detection — run this check before writing any prose.**
After loading positioning data, walk the persona list:

```javascript
const allPersonas = ctx.resolved_personas ?? [];
const personasWithJobs = allPersonas.filter(p => Array.isArray(p.jobs) && p.jobs.length > 0);
const personasMissingJobs = allPersonas.filter(p => !p.jobs || p.jobs.length === 0);
```

- If `personasMissingJobs.length === allPersonas.length` (no persona has
  jobs anywhere in the catalog), **stop**. Tell the user:
  > "This project has personas defined but no Klement Job Stories on
  > any persona. The narrative will default to declarative voice without
  > human moments. Recommended next step: run `/tend position` first to
  > plant Job Stories on the personas this feature touches
  > (`<list-the-feature's-personas>`). Want me to write the narrative
  > anyway in declarative voice, or pause and run `/tend position`?"

  Get explicit user direction before continuing.
- If some personas have jobs but the ones this feature binds via
  `feature.personas[]` do not — same gap, same prompt.
- If positioning exists, proceed.

**Follow the check-to-job pointers** before drafting. Use MCP — one call
to `tend_get_context` returns both the feature and its resolved personas:

```javascript
const ctx = await tend_get_context({ id: featureId });
const personasById = new Map(ctx.resolved_personas.map(p => [p.id, p]));

for (const c of ctx.feature.checks ?? []) {
  if (!c.validates_job) continue;
  const [personaId, idxStr] = c.validates_job.split(':');
  const job = personasById.get(personaId)?.jobs?.[Number(idxStr)];
  // job.situation / job.motivation → scenario-opener fuel
  // job.validation → the spec your truth-claims must mirror
}
```

### 2. Outline sections

Decide which themes this narrative genuinely needs. **First detect the
page class** (capability bet / child / garden / persona / opportunity) and
read its shape in
[`references/narrative-shapes.md`](references/narrative-shapes.md) — the
five shapes are reader contracts and defaults, *not* mandatory headings
(the anti-uniformity caveat there is binding: write the sections this
specific page earns, and let the cold-entry test be the bar, not heading
conformance). Most features land at 2–4 sections. Subpages often just 1.
Gardens often 4–6. See
[`references/section-themes.md`](references/section-themes.md) for the
headline-rewrite table and garden-specific guidance.

Write the outline as **working titles** first ("How it works", "Why this
shape"). You'll rewrite to headlines after the prose is drafted (step 3.5).

While outlining, walk each working title against the diagram triggers in
[`references/diagram-conventions.md`](references/diagram-conventions.md).
Note `→ needs [diagram_id]` beside any section that warrants an SVG.
Diagrams identified during outline are load-bearing; those added after
prose tend to be decorative or skipped entirely.

### 2.5. Draft gate — get approval before writing the full narrative

**Do not write 500 lines of prose unreviewed.** After outlining, present
two things for approval and stop:

1. **The proposed section list** — the working titles you'll write, in
   order, one line each, with a phrase on what each covers and any
   `→ needs [diagram]` notes.
2. **The opening paragraph** — actually draft the lede (the first
   paragraph the reader meets). It sets the voice and the entry; if the
   lede is wrong, the whole article is wrong. Per the lede rules in
   [`references/narrative-shapes.md`](references/narrative-shapes.md), the
   first sentence names a person, a pain, or a consequence — not a file
   path or a line count.

Then ask: *"Here's the shape and the opening — does the structure fit,
and does the lede land? Sections to add, drop, or reorder before I write
the bodies?"* Wait for approval (or revisions) before drafting the full
narrative in step 3. The cheapest moment to fix an article's shape is
before its body exists.

### 3. Write each section

- Lead with the most important thing for that section. No throat-clearing.
- Use code blocks for actual commands, file paths, identifiers.
- **Weave inline links into the prose** every time you reference a
  sibling that has a tend page:
  - Other features: `the [<feature-id>](<feature-id>.tend.html) handles...`
  - Garden catalog anchors: `during the [onboarding phase](../overview.html#phase-onboarding)...`
  - Subpages: `[<parent>.<aspect>](<parent>.<aspect>.tend.html) drills into...`
  - Decisions on the same page: `we chose this in d003` (no link needed)
- Use `` `backticks` `` for code paths, function names, and command strings.
- See [`references/renderer-support.md`](references/renderer-support.md)
  for what markdown syntax the polyglot renderer actually handles.

### 3.5. Rewrite working titles to insight headlines

Before shipping, walk through each `##` heading: does this title predict
the section's insight, or just label its structure?

See [`references/section-themes.md`](references/section-themes.md) for
the full headline-rewrite table. The TOC will be the most-scanned part of
the page — make it earn the scan.

### 4. Author SVG diagrams

For full diagrams in the narrative, see all conventions and anti-patterns
in [`references/diagram-conventions.md`](references/diagram-conventions.md).

Inline the SVG in the markdown narrative directly:

```markdown
## How it works

When a feature is updated via MCP, side-effects fire in order:

<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg">
  <!-- five-step pipeline -->
</svg>

The pipeline is atomic — either every step lands or none do.
```

OR add to `oo-data.media` and reference by id:

```markdown
The architecture has five layers, each with its own role: [arch_diagram].
```

with `media: { arch_diagram: { kind: "svg", content: "<svg ...>", alt: "...", caption: "..." } }`.

Use the `media` form when the diagram is referenced from multiple places
or when it deserves a caption. Use inline SVG when it's a one-off in the flow.

#### 4a-i. Visual verify diagrams (`oo-data.media` SVGs)

After drafting a diagram SVG that will live in `oo-data.media`, visual verification is REQUIRED
before writing to the polyglot. The `--diagram` mode handles any viewBox — it renders at 4× the
SVG's viewBox width so a 560×240 viewBox produces a 2240px-wide PNG.

1. Draft SVG markup (inline in your context, not yet written to the polyglot).
2. Run draft check via `--svg`:
   `npx tend-cli preview-thumbnail --svg "<draft-svg>"`
3. After writing via `tend_update_feature`, confirm the disk write then run:
   `npx tend-cli preview-thumbnail --diagram <media_id> --feature <feature-id>`
4. The command prints two PNG paths (light + dark).
5. **Read both PNGs via your Read tool.**
6. Apply the 5-item visual checklist in
   [`references/thumbnail-authoring.md`](references/thumbnail-authoring.md)
   § ["Visual verification (shared with diagrams)"](references/thumbnail-authoring.md#visual-verification-shared-with-diagrams).
7. If any check fails, revise the SVG and loop back to step 1.

### 4b. Visual verify thumbnails

After authoring or modifying a thumbnail (the iconic SVG that appears on
a feature's card), visual verification is REQUIRED — introspection on
raw SVG markup cannot catch the failure modes pixels reveal.

**Step 0 — Confirm the write landed (after `tend_update_feature`).**
The MCP return value is not sufficient confirmation. Independently
re-read the polyglot from disk:

```bash
bash docs/tend/features/<id>.tend.html data | jq -r '.thumbnail | keys'
```

Must output `["alt","content","kind"]`. If empty/null, the write
didn't persist — diagnose + retry. Do NOT proceed to visual verify
until the field exists on disk.

1. During DRAFT iteration (before writing to the polyglot):
   `npx tend-cli preview-thumbnail --svg "<draft-svg>"`
2. After writing the thumbnail via `mcp__tend__tend_update_feature` AND
   confirming the disk write (step 0 above):
   `npx tend-cli preview-thumbnail --id <feature-id>`
3. The command prints two PNG paths (light + dark themes).
4. **Read both PNGs via your Read tool.** Claude views images directly
   when given a PNG path.
5. Apply the 5-item visual checklist in
   [`references/thumbnail-authoring.md`](references/thumbnail-authoring.md)
   § ["Visual verification (shared with diagrams)"](references/thumbnail-authoring.md#visual-verification-shared-with-diagrams).
6. If any check fails, revise the SVG and loop back to step 1.

### 4c. Apply the shuffle test (sibling sets)

When authoring thumbnails for MULTIPLE features in the same parent's
card grid (garden's features, a feature's subpages, a persona's bound
features, an opportunity's solving features), the shuffle test is
REQUIRED before the set is considered done:

1. `npx tend-cli preview-cards --parent <parent-id>`
2. Output is a composite PNG showing all sibling cards side-by-side.
3. **Read the PNG via your Read tool.**
4. Apply the shuffle test described in
   [`references/thumbnail-authoring.md`](references/thumbnail-authoring.md)
   § "The shuffle test — differentiation across a grid".
5. If any two thumbnails have similar dominant silhouettes, iterate
   on the weaker one(s).

### 5. Write the update

```javascript
tend_update_feature({
  id: "<feature-id>",
  changes: {
    narrative: "## How it works\n\n...",
    media: { arch_diagram: { kind: "svg", content: "<svg ...>", alt: "...", caption: "..." } }
  }
})
```

MCP validates, splices, refreshes denorm, returns the new state.

### 6. Verify in browser

Open the polyglot. Confirm:
- Narrative renders below the bet article.
- h2 + h3 headings appear in the left TOC.
- Inline SVGs render and respect light/dark mode.
- No content from rail (checks/steps/smoke) appears in main.
- The page reads top-to-bottom as a focused essay.

If the page reads as a form (heading → list → heading → list), the
narrative isn't doing its job. Rewrite the prose so it carries the story.

### 7. Slop check — read your own output back

Before declaring the run complete, read the rendered narrative end-to-end
once. Score yourself honestly:

| Signal | Slop | Signal |
|---|---|---|
| Paragraphs | Re-state the bet's slot in different words | Add the mechanism / trade / edge the bet couldn't carry |
| Section titles | "How it works", "Why this shape" | A headline that predicts the section's insight |
| Voice | "We will" / "should consider" / "in the future" | Present-tense, what *is* |
| **Posture** | **"Until now this was implicit" / "binding X changes Y"** | **Describe what IS — reader meets this artifact for the first time** |
| Persona refs | "users" / "the developer" | A bound persona-job, named (situation + validation) |
| Diagrams | Boxes connected by unlabeled arrows | Edges carrying verbs / trade / quantity |
| Cross-refs | "see the order pipeline" | `the [order pipeline](order-pipeline.tend.html)` |
| Code refs | "in the relevant module" | Real file path + line range |

If any row reads as slop, fix it before shipping. Better to ship one
verified-tight section than three sections of padding.

## Done When

- The polyglot's `narrative` is non-empty and reads as a focused essay
  (not a form, not a wall of text, not stubs)
- Every paragraph adds signal (no padding, no theater)
- Diagrams exist where they earn their place (not for decoration)
- Headings (`##`, `###`) match the actual story the section tells
- All cross-references resolve (links to other features, garden
  anchors, code paths)
- Browser-rendered page reads top-to-bottom; left TOC reflects the
  actual h2/h3 structure
- `npm test` passes (no schema validation regressions)
- `bash <file>.tend.html data | jq '.narrative | length'` returns a
  number > 200 (a meaningful narrative, not a placeholder)

## Next move

Close the loop — don't leave the user guessing what comes next.

1. **Compute it.** Call `tend_get_next` (MCP preferred; CLI fallback
   `node dist/bin/tend.js next --json`). It reads on-disk state and
   returns the highest-leverage action with reason codes.
2. **Present it plainly.** State the recommended `action` verbatim and the
   reason in plain words (paraphrase the reason code, don't paste it).
   Example: *"Next: `/tend narrate order-pipeline` — its subpage still
   reads as a form, and your story here references it."*
3. **Offer to chain — never auto-execute.** Ask before continuing:
   *"Want me to narrate the subpage now?"* Only proceed on the user's yes.
   If they decline, route to whichever sub-skill matches their intent.

Common moves after a narrative: `/tend narrate` on its subpages (the
parent's story often references deep-dives that need their own focus);
`/tend audit` if narrating surfaced a check that's actually unmet;
`/tend change` if it surfaced a slot claim that doesn't match the code.
Let `tend_get_next` confirm rather than assuming.

## Anti-patterns

- **Labelly section titles.** `## How it works` / `## Why this shape` /
  `## What this project is` ship as working titles, not final headlines.
  Rewrite each h2 to deliver the section's actual insight.
  See `references/section-themes.md`.
- **Paraphrasing the bet.** The bet is the summary; the narrative is
  the elaboration. Add what the bet's one-liner couldn't carry: the
  mechanism, the trade-off, the edge case.
- **Aside references instead of inline links.** "We use the order pipeline
  (see the order-pipeline feature) to debounce writes" is friction.
  `the [order pipeline](order-pipeline.tend.html)` is the move.
- **Bullet-soup.** Three nested unordered lists is a form, not an
  article. If you find yourself nesting, the narrative wants prose.
- **TODO placeholders.** "This section will cover..." — no. Write the
  section or drop the heading.
- **Decorative diagrams.** Either the diagram carries real structural
  content (flow, hierarchy, comparison) or it doesn't earn its place.
  See `references/diagram-conventions.md` for the full anti-pattern list.
- **Voice drift.** Plain, direct, present-tense. Not "the developer
  should consider..." — write what is, not what someone *might* do.
- **Wall of paragraphs.** Break narrative with headings every ~200
  words. Reader needs landmarks.
- **All-declarative voice.** Every section claims a thing. No human
  moment, no scenario, no concrete person in a concrete situation.
  If the project has positioning data (`catalog.personas[].jobs[]`), use it.
  When the feature's checks carry `validates_job`, the narrative *must*
  reference at least one of the bound persona-jobs concretely
  (situation, validation clause).
- **Duplication of other polyglots' content.** Each polyglot covers
  *its own* slice. When prose enters another polyglot's territory, the
  move is to link, not to paraphrase. For every named capability in
  your narrative, ask "does this name appear in `project_index`? If yes,
  is it a link?"
- **Thumbnails shipped without visual verification.** Running
  `npx tend-cli preview-thumbnail` and reading the PNGs via the Read tool isn't
  optional. See `references/thumbnail-authoring.md`.
