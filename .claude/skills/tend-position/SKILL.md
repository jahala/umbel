---
name: tend-position
description: Establish the who-for / for-what-job spine of a project — ICP archetypes plus Klement-style Job Stories on each persona, refined opportunities, and scenario seeds. The catalog of "real people in real moments" that every downstream skill (especially tend-narrate) reads to keep features grounded in human stories rather than technical taxonomy. Trigger when a garden's bet is written but the catalog lacks ICPs / personas / jobs, when narratives are reading too declaratively, or when the user asks "who is this for?" / "what job does this do?".
user-invocable: true
---

# Position: Who is this for, what job do they hire it for

**Owns**: `catalog.personas[]` (id, name, description, **archetype**,
**jobs[]**) and `catalog.opportunities[]` (id, description, value,
confidence, source, signals, **`personas: string[]`**) on the garden
polyglot.

> **Job indexing is a load-bearing contract.** Each persona's `jobs[]` is
> an ordered array. Downstream checks anchor to a specific job via
> `validates_job: "<persona_id>:<job_index>"` — `"founder:0"` means
> "persona founder, first Klement Job Story." Reordering jobs after
> publication silently retargets every check pointing at them, so treat
> the array like an append-only list once features start referencing it.
> If a job must be reordered or removed, `/tend change` requires an
> explicit reindex map so it can rewrite every dependent `validates_job`.

## What this skill assumes

- The garden polyglot exists and has at least a draft bet (the project knows roughly what it is).
- The user has *some* sense of who the project is for — at minimum a few interview notes, sales-call snippets, or strong founder intuition. This skill structures what the user already knows; it does not generate ICPs from nothing.
- It's OK if the catalog has shallow personas (`name` only) — this skill fills in `archetype`, `jobs[]`, and `opportunity.personas` from there.
- Downstream skills (`/tend brainstorm`, `/tend audit`) will be unwired without this skill's output. Run this before they need it.

## Purpose

Tend's six slots tell you *what* you're building and *why technically*. They
don't tell you *who* you're building it for or *what job* that person hires
your product to do in a specific moment of their week. Without that, every
downstream artifact — feature pages, narratives, evals — drifts toward
technical-taxonomy voice.

This skill plants the spine:

- **ICP archetypes** — one phrase per persona that names a real human with
  real stakes. Not roles ("Backend Engineer"), but situated archetypes
  ("Solo founder running a SaaS side project on weekends; values speed
  over polish; can't justify a day of tooling").
- **Klement Job Stories** — 3–5 per persona, in the form:
  *"When [situation], because [motivation], we believe [outcome]. We'll
  know we got it right when [validation]."*
- **Refined opportunities** — pains felt by which persona, value level,
  confidence (and source / signals if known).
- **Scenario seeds** — 2–3 concrete moments per persona (a sentence or
  two each), captured in the persona's `description` or jobs. These are
  the openers tend-narrate uses to start feature pages with a story
  rather than a label.

Tend ships zero opinionated personas. Every project plants its own.

## Reads

- The garden polyglot's `oo-data` — current bet (slots), narrative, and
  existing `catalog.personas` / `catalog.opportunities`.
- Any user-supplied context: interview notes, support ticket themes,
  analytics flags, sales-call snippets. (No on-disk format required —
  paste into the conversation.)
- Feature polyglots' `personas` / `solves` refs — to see which catalog
  entries are actually load-bearing across the project.

## Writes

Only to the garden polyglot, only on `catalog.personas[]` and
`catalog.opportunities[]`. Via `tend_update_catalog` (MCP).

The schema (see `schema/catalog.schema.json`):

```jsonc
// catalog.personas[]
{
  "id": "solo-founder-saas",
  "name": "Solo SaaS Founder",
  "description": "Builds and operates a small SaaS alone. Ships on nights and weekends.",
  "archetype": "A solo founder running a SaaS side project — values speed over polish; can't justify a day of tooling.",
  "jobs": [
    "When I sit down on Saturday morning to ship a feature, because I have only this one block of focus before family obligations, we believe a single command should put me back in flow with the right context loaded. We'll know we got it right when I'm coding within 60 seconds of opening the laptop."
  ]
}

// catalog.opportunities[]
{
  "id": "context-switch-tax",
  "description": "Re-loading where I left off on a feature costs 15–30 minutes every session.",
  "value": "high",
  "confidence": "medium",
  "source": "10 interviews with side-project devs",
  "signals": 7,
  "personas": ["solo-saas-founder"]
}
```

`archetype` and `jobs[]` are optional in the schema, but this skill's
output should always fill them — that's the whole point.

**Propagation flow.** `tend_update_catalog` is the canonical write. For each **approved** persona / opportunity, MCP side-effects materialize its catalog-description polyglot at `docs/tend/features/<id>.tend.html` — **creating the file if it doesn't exist yet** and mirroring the catalog data into its `data.persona` / `data.opportunity` block. (Catalog-description polyglots live in `features/`, the same directory as bet features — they're discriminated by the `data.persona` / `data.opportunity` block, *not* a separate `personas/` or `opportunities/` folder. There is no `tend_create_catalog_entry` tool and you do **not** call `tend_create_feature` by hand for these — the catalog write scaffolds them. **Draft** entries — auto-stubbed from an unknown feature ref — are not scaffolded until approved.) Derived snapshots — `bound_features`, `solving_features`, and similar cross-refs — refresh on every feature write that touches `personas` or `solves`. No manual create or aggregate step is needed under normal flow; the write keeps everything consistent. (`tend aggregate` also re-materializes any missing catalog-description polyglots, as a recovery path for hand-edited or imported catalogs.)

## When to invoke

- The garden's bet is written but `catalog.personas` is empty / shallow
  (`name` only, no `archetype` / `jobs`).
- A narrate / brainstorm run is producing technical-taxonomy prose that
  doesn't name a real person in a real moment.
- The user explicitly asks: "who is this for", "what job does this do",
  "where are we positioned", "who's our ICP".
- Before `/tend brainstorm` at garden scope — get the ICPs / opportunities
  in place first, so brainstorm has them to cite.

## Workflow

### 1. Load all the project's evidence — first

**Before drafting or asking anything, ingest what the project already
knows about itself.** The user has been building tend's understanding
of its users for months across decisions, slot copy, feature narratives,
and research notes. Synthesize from that evidence; don't ask discovery
questions that the codebase already answers.

Use the MCP tool when available:

```javascript
tend_get_context({ id: "garden", include_project_context: true })
```

The response includes `project_index`: every polyglot's id, title, kind,
path, narrative, and parent. That's your evidence pool — every
feature's narrative names the people it serves and the moments it
serves them in.

Offline fallback (no MCP):

```bash
# Current garden bet + catalog
bash docs/tend/overview.html data | jq '{
  title, what, why, impact, fit,
  personas: .catalog.personas,
  opportunities: .catalog.opportunities
}'

# Every feature's narrative
for f in docs/tend/features/*.tend.html; do
  echo "─── $(basename "$f" .tend.html) ───"
  bash "$f" data | jq -r '.narrative // "(empty)"'
  echo
done
```

**Also read** (these change per project — search and load what's there):
- `docs/research/` — any positioning, competitive analysis, user
  research, or interview notes the project has already gathered.
- `CLAUDE.md` — the project's positioning context, value alignment,
  what it explicitly is and is not.
- Recent commits — `git log --oneline -20` for context on what direction
  the user has been pushing.
- Any memory file about the project's competitive landscape, ICPs,
  prior conversations about who it's for.

If `personas[].archetype` and `personas[].jobs` are already populated,
you're refining. If absent, you're planting.

If the garden's bet itself is unwritten, redirect to `/tend brainstorm`
first — without a `what` and `why`, there's nothing for personas to be
*for*.

### 2. Synthesize a draft from the evidence

**Don't ask discovery questions the evidence already answers.** From
step 1's reading, draft:

- 3 ICPs (sometimes 2, rarely more than 4). Each gets an `archetype`
  written as a situated phrase, not a role. Feature narratives in
  `project_index` are usually rich with persona context the catalog
  hasn't captured yet — mine them.
- 3–5 Job Stories per ICP (see step 4 for shape).
- Refinements to existing opportunities + any new ones the evidence
  surfaces.

**Personas are users, not channels.** A user has constraints and
judgments that shape what you build. A channel is how a user reaches
the product. The test: would this entity's *constraints* (context
window, latency budget, no GUI, runs in CI, audits itself, etc.)
materially change at least one feature's design? If yes, it's a user.
If it's just the conduit (the browser, the terminal — passively
rendering / dispatching), it's a channel. Machine clients, automated
integrations, and AI agents are often *users* despite having no
opinions of their own — their constraints still drive feature design.

**One persona = one week.** If two proposed personas have the same
week (same context, same constraints, same stakes), they're one
persona; consolidate.

Present the draft with an *evidence trail*: cite which narratives /
decisions / docs each ICP came from. Pushback gets sharper when the
user can say "you missed the evidence in feature Y" instead of
relitigating from scratch.

**Only ask when the evidence is missing, contradictory, or
ambiguous** — and ask focused, not generic:

- Good: "Narratives consistently treat the billing admin as the
  operator of the flow. But `payment-friction` reads as a pain *the
  end customer* feels. Is the ICP the admin managing billing, or the
  customer experiencing checkout? The framing changes every downstream
  narrative."
- Bad: "Who's your ICP?"

### 3. Audit coverage before committing

The load-bearing test for whether the ICP set is right. Two checks:

- **Every feature must find a home.** Walk `project_index`. For each
  feature, can you point to a persona that would plausibly own it?
  If a feature has no plausible owner in your proposed set, either
  the persona set is incomplete or that feature is unowned drift
  (surface it). A feature dropping out of coverage usually means you
  dropped or renamed the wrong persona.
- **Every persona must own at least one feature.** A persona with no
  features that exist primarily for them is invented demand —
  either drop the persona or name which features need to exist for
  them (and surface that as a gap to the user).

This is the structural test that catches "we collapsed the wrong
entity" before you write to disk.

### 4. Draft Job Stories per persona

For each ICP, draft 3–5 Job Stories. Each follows Klement's structure:

> **When** [situation — concrete, time-bound, sensory if possible],
> **because** [motivation — what's making it matter right now],
> **we believe** [outcome — the change the user wants],
> **we'll know we got it right when** [validation — observable / testable
> outcome].

> **The validation clause is the downstream spec.** `/tend brainstorm`
> writes checks with `validates_job: "<persona_id>:<job_index>"` pointing
> at one specific job. `/tend audit` reads `validation` as the pass
> criterion the test must assert. So validation must be *measurable*
> (timing, error-message text, end-state, count). A vanity validation
> ("users will love it") corrupts every downstream check, test, and
> audit verdict that anchors to it.

Anti-patterns to avoid:

- **Vague situation**: "When using the product" → not a moment.
- **Role-restated motivation**: "because I'm a developer" → not a
  motivation.
- **Outcome restating the situation**: "we believe it'll be easy to use"
  → say what *change* in the user's day.
- **Vanity validation**: "we'll know when users love it" → unmeasurable.
- **Jobs that don't differentiate**: if two ICPs would word the same
  job identically, either you have one persona pretending to be two,
  or you haven't named what's specific to each ICP's week. Tighten
  the situation/motivation until the jobs only fit one persona.

Show drafts to the user one persona at a time. Their pushback is
information about the ICP — capture it.

### 5. Refine opportunities

For each entry in `catalog.opportunities[]`:

- **description** — phrase as a pain, in the user's voice. "Re-loading
  where I left off costs 15–30 min" not "Context loss is high".
- **value** — `critical | high | medium | low`. Critical = blocks the
  job; users would switch products.
- **confidence** — `high | medium | low`.
- **source** — where the signal came from. **Label internal vs
  external explicitly.** Internal: founder intuition, our own docs,
  team discussions, competitive analysis we did. External: user
  interviews, support tickets, analytics, sales-call notes, GitHub
  issues from real users. `confidence: high` requires at least one
  external signal — internal-only evidence caps at `medium`
  regardless of how convincing it feels. The echo chamber is real.
- **signals** — independent observation count, if known. Optional.
- **personas** — the list of persona IDs feeling this pain. Required;
  an opportunity with no `personas[]` is invented demand. Bind to
  every persona who lives the pain (often one, sometimes a few). A
  feature's `personas[]` should overlap with the `personas[]` on
  every opportunity it `solves` — `/tend brainstorm` surfaces the
  mismatch as a coherence warning.

New opportunities? Add them. Existing ones with weak description?
Rewrite. Don't keep an opportunity around just because it's there —
confidence=low + value=low is clutter.

### 6. Scenario seeds for tend-narrate

For each persona, write 2–3 scenario seeds. Each is a sentence or two
naming a concrete moment — name, time, situation, micro-decision. These
go in the persona's `description` (or richer `jobs[]` entries) and feed
tend-narrate's scenario-led openers.

Example scenario seed (embedded in description):

> Maria opens her laptop at 9pm after the kids are down. She has 90
> minutes before she crashes. She's been thinking about the new pricing
> page all week but can't remember which decisions she'd already locked
> in. She types one command…

Tend-narrate will pick this up when drafting the related feature page
and start the article in-scene rather than with a label.

### 7. Write to the garden via MCP

```javascript
tend_update_catalog({
  personas: [
    {
      id: "solo-founder-saas",
      name: "Solo SaaS Founder",
      description: "...",
      archetype: "...",
      jobs: ["When ...", "When ...", "When ..."]
    },
    // ...
  ],
  opportunities: [
    {
      id: "context-switch-tax",
      description: "...",
      value: "high",
      confidence: "medium",
      source: "...",
      signals: 7,
      personas: ["solo-founder-saas"]
    }
  ]
})
```

`tend_update_catalog` deep-merges. Existing personas / opportunities
keep their unmentioned fields; new ones append; updates overwrite by id.

### 8. Surface gaps and cascade work

After writing:

- **Refreshable features**: list features whose `personas` or `solves`
  refer to anything you enriched. They inherit the new framing —
  narrate or brainstorm runs over them will produce sharper output.
- **Stale refs**: if you dropped or renamed any persona / opportunity,
  every feature that referenced it is now orphaned. List those refs
  explicitly. Either propose inline updates or invoke `/tend change`
  to cascade. `tend_validate` will flag the stale refs but won't
  auto-fix them.
- **Coverage gaps from step 3**: if you surfaced features without a
  plausible owner (or personas without features), name them as
  follow-ups — they're either a brainstorm prompt or a signal to
  revisit the ICP set.

## Done when

The spine is sound when every one of these is true — each is binary, check
it explicitly before declaring the run complete:

- [ ] **Every persona has a non-generic archetype.** A situated phrase
      with stakes and constraints ("solo founder shipping on weekends, can't
      justify a day of tooling"), NOT a role restatement ("Backend
      Engineer", "the admin user"). If the archetype just names the role,
      it isn't done.
- [ ] **Every persona has ≥3 Klement jobs, each with a MEASURABLE
      validation clause.** The "we'll know we got it right when…" clause
      names something observable and testable (timing, error-message text,
      end-state, count) — never vanity ("users will love it"). Three is
      the floor; a one-job persona is under-specified.
- [ ] **Every opportunity has ≥1 persona binding.** `opportunity.personas`
      is non-empty — no anonymous pain. An opportunity nobody feels is
      invented demand; drop it or bind it.
- [ ] **Every feature maps to ≥1 persona.** Walking `project_index`, each
      feature has a plausible persona owner. A feature with no owner is
      unowned drift — surface it.
- [ ] **`tend_validate` reports no `unbound_persona` warnings.** Run it;
      the spine isn't load-bearing until every persona is referenced by at
      least one feature.

## Next move

Close the loop — don't leave the user guessing what comes next.

1. **Compute it.** Call `tend_get_next` (MCP preferred; CLI fallback
   `node dist/bin/tend.js next --json`). It reads on-disk state and
   returns the highest-leverage action with reason codes.
2. **Present it plainly.** State the recommended `action` verbatim and the
   reason in plain words (paraphrase the reason code, don't paste it).
   With a fresh spine the move is usually `/tend brainstorm` — *"personas
   and jobs are planted; features can now anchor checks to them."*
3. **Offer to chain — never auto-execute.** Ask before continuing:
   *"Want me to start `/tend brainstorm` on the first feature now?"* Only
   proceed on the user's yes. If they decline, route to whichever
   sub-skill matches their intent.

Once the spine exists, `/tend brainstorm` (new features) and
`/tend narrate` (sharper, scenario-led prose on existing ones) both read
it. Let `tend_get_next` confirm which is the higher-leverage move.

## Composition with other skills

- **`/tend brainstorm`** (garden scope): if catalog.personas is empty,
  brainstorm should redirect to `/tend position` before drafting the
  garden's bet. The bet's WHO and FIT slots cite personas; they need
  to exist.
- **`/tend brainstorm`** (feature scope): cites existing personas /
  opportunities via `personas` and `solves` refs. Doesn't redefine
  them. If the feature names a new ICP, redirect to position first.
- **`/tend narrate`**: reads `catalog.personas[].archetype` and
  `personas[].jobs[]` as the *voice source*. Scenario-led openers come
  from these. A narrate run on a feature whose `personas` reference
  empty / shallow catalog entries should redirect here.
- **`/tend change`**: when an ICP shift comes in ("we're actually for
  enterprise SREs not solo devs"), this skill owns the catalog edit;
  change handles the cascade to feature `personas` / `solves` refs and
  to every check's `validates_job`. Reordering an existing persona's
  `jobs[]` after features have started citing them goes through
  `/tend change` too — it requires an explicit reindex map to rewrite
  every dependent `validates_job` together.

## What this skill is NOT

- **Not a CJM (Customer Journey Map).** No "awareness / consideration /
  retention" funnel stages. If a project needs that, it's a
  project-defined topic, not first-party.
- **Not full JTBD trees.** No big-job / small-job decomposition. Klement
  Job Stories are the minimum-viable form; deeper JTBD work belongs in
  a topic.
- **Not positioning statements.** "For X, who Y, our product is Z,
  which gives W, unlike V." This skill's output *informs* a positioning
  statement, but the statement itself is downstream (and project-
  specific).
- **Not market research.** This skill structures what the user already
  knows about their users. It doesn't generate ICPs from nothing. If
  the user says "I don't know who this is for", redirect them to talk
  to users — tend can't manufacture that signal.

The discipline: lean, but not spineless. Real people, real moments,
testable outcomes. Three ICPs > thirty.

## References

- `schema/catalog.schema.json` — the persona / opportunity field
  contract.
- Any positioning, competitive analysis, or interview notes the project
  has already gathered (commonly under `docs/research/`).
