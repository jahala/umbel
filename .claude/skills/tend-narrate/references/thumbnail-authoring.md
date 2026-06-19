# Thumbnail authoring reference

## Authoring thumbnails (for card components)

When a feature is shown as a card (in a parent polyglot's card grid),
its `thumbnail` field provides the illustration band at the top of the
card. **A thumbnail is a tiny iconic UI mockup of the feature itself,
not a generic geometric pattern.**

### The test that matters: "remove the title."

If you removed the card's title text, would the thumbnail alone hint
at what the feature is about? If the thumbnail could just as easily
sit on a card for an unrelated feature, it's failed — go back and
think harder about what *this specific feature* looks like.

A hub-and-spokes diagram could be the thumbnail for *any* feature
that connects things. A grid of boxes could be *any* set. A timeline
could be *any* sequence. These shapes are too generic to identify
the feature. They're starting points to refine, not finished work.

### The shuffle test — differentiation across a grid

When you're authoring thumbnails for multiple sibling features (a
parent's subpages, or the garden's top-level features), apply the
**shuffle test** before shipping any of them:

> If I shuffled the titles randomly among these cards, would each
> thumbnail still obviously match its (new random) title? If yes,
> the thumbnails are interchangeable — they aren't differentiating.

Two thumbnails that both render as "list with accent row" or "3
columns" or "hub with spokes" have failed the shuffle test even if
the *intent* of each was different. At thumbnail size with the same
primitive vocabulary, similar compositions collapse visually into
the same icon — the viewer can't tell them apart at a glance.

**Force differentiation:**

1. Before drawing any thumbnail in a sibling set, list every sibling's
   feature title.
2. For *each* sibling, name 3 candidate visual metaphors (NOT just one).
   Drawing from the 8 UI categories below, pick metaphors that come
   from *different categories* across siblings — e.g., one feature gets
   a code panel, another a kanban board, another a file tree, another
   a chart.
3. If two siblings would naturally pick the same metaphor (both look
   like list views), force one of them to a less-obvious metaphor that
   still fits — even at slight loss of accuracy. Visual differentiation
   matters more than perfect literal fit.

The goal: scanning a row of 5 cards in a grid, each thumbnail has its
own distinctive silhouette. Same color palette, same primitive
vocabulary — but recognizably different shapes.

### Domain-first thinking — what does this feature LOOK like?

Before drawing, brainstorm: if this feature had a tiny screenshot on
a marketing site, what would the screenshot show?

- **Code-related** → tabs, code panel with syntax-highlighted lines,
  terminal with prompt + commands, file tree, diff with +/− gutter
- **Workflow / process** → kanban board with columns + cards, timeline
  with milestone nodes, swimlane, RED→GREEN test progression
- **Data / coverage / inventory** → file grid with status dots, table
  with rows, list with checkmarks, progress bar
- **Configuration** → toggle switches, form fields, settings panel
- **Communication** → comment thread, PR with margin annotations,
  message bubbles, mention chips
- **Graph / network / structure** → tree of connected boxes, dependency
  arrows, hierarchy nodes, modules with imports
- **Analytics / status** → bar chart, line graph, status pills,
  dashboard with KPI cards
- **Validation / audit** → checklist, verdict stamps (✓/✗), evidence
  paths, traffic-light row

Pick the visual metaphor that *this specific feature* most resembles.
"This feature is about X, and X traditionally looks like Y" — then
draw Y.

### Canvas + size

- **`viewBox="0 0 120 80"`** — every thumbnail. The card's CSS centers
  the SVG inside a 132px-tall band (max-width 180px, max-height 100px).
- Leave ~6-10px breathing room around the composition.

### Three color roles per thumbnail — non-negotiable

Every thumbnail uses three distinct color "roles":

1. **Borders / lines** (gray) — applied via the `.tc-frame` modifier
   on LARGE container shapes, and via `.tc-ln` on loose `<line>`
   connectors. Small accent shapes (dots, highlights, inner pills)
   should NOT carry a frame — strokes on tiny shapes read as
   cluttered noise. Frame the cards; leave the dots clean.
2. **Container fills** (sand / white) — `.tc-bg` for the recessive
   tone (sand), `.tc-wh` for the prominent tone (paper). Mix both
   to create depth — a `.tc-wh` card on top of `.tc-bg` background
   reads as foreground vs background.
3. **Accent** (rust / clay) — `.tc-ac` on exactly one focal shape,
   or a small set of "highlighted" status items. One thumbnail =
   one focal accent zone.

A thumbnail with only 2 color roles reads as flat. A thumbnail with
no visible borders (no `.tc-frame` modifiers) reads as solid-color
patches with no structure.

### Class table

| Class       | Purpose                                          | Where to apply             |
|-------------|--------------------------------------------------|----------------------------|
| `.tc-wh`    | Paper / white fill                               | Cards, panels, foreground  |
| `.tc-bg`    | Sand / recessive fill                            | Background bands, recessed |
| `.tc-fg`    | Dark fill (text color)                           | Small dark dots, indicators|
| `.tc-ac`    | Accent / clay fill                               | One focal shape, accent dots|
| `.tc-ln`    | Gray stroke (no fill)                            | Loose `<line>` connectors  |
| `.tc-la`    | Muted-gray stroke (no fill)                      | Subtle/dotted lines        |
| `.tc-frame` | **Modifier** — adds gray stroke to a shape       | Combine with a fill class on large containers |

Author usage:

```xml
<rect class="tc-wh tc-frame" .../>   <!-- white card WITH border -->
<rect class="tc-bg tc-frame" .../>   <!-- sand card WITH border -->
<rect class="tc-ac" .../>            <!-- accent shape, no border -->
<circle class="tc-fg" .../>          <!-- small dark dot, no border -->
<line class="tc-ln" .../>            <!-- connector line -->
```

### Element budget

Target 8-14 primitives for most thumbnails. UI-mockup compositions
(kanban, file tree, code panel) often land at 12-18 — that's fine
when each element earns its place. The goal is *legibility of the
metaphor*, not minimalism for minimalism's sake.

Use a varied primitive mix: `<rect>` (containers, cells, panels),
`<circle>` (dots, status markers, nodes), `<line>` (content lines,
connectors, dividers), occasional `<path>` (checkmarks, arrows,
custom shapes like a folder tab or chart curve).

### Worked example — domain-driven, not pattern-driven

For an "annotated pull request" feature, the metaphor is a code diff
with margin comments. The thumbnail shows a small file panel with diff
lines and a comment bubble in the margin. **Notice: the large file
panel and the comment bubble both carry `tc-frame` (they're container
shapes); the small pointer dot is unframed (it's an accent shape).**

```xml
<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg">
  <!-- file panel container (large → framed) -->
  <rect class="tc-wh tc-frame" x="8"  y="10" width="72" height="60" rx="3"/>
  <!-- diff lines (gray content, no fill) -->
  <line class="tc-la" x1="14" y1="22" x2="48" y2="22"/>
  <line class="tc-la" x1="14" y1="30" x2="44" y2="30"/>
  <line class="tc-ln" x1="14" y1="38" x2="60" y2="38"/>
  <line class="tc-la" x1="14" y1="46" x2="50" y2="46"/>
  <line class="tc-la" x1="14" y1="54" x2="42" y2="54"/>
  <!-- margin comment bubble (large enough → framed) -->
  <rect class="tc-ac tc-frame" x="86" y="20" width="26" height="20" rx="3"/>
  <!-- pointer dot (small accent → no frame) -->
  <circle class="tc-ac" cx="80" cy="38" r="2.5"/>
  <!-- connector line from dot to comment -->
  <line class="tc-ln" x1="80" y1="38" x2="86" y2="30"/>
</svg>
```

11 primitives. The shape is **recognizable**: a file panel with
content lines and a margin comment bubble. The accent is on the
comment (the "annotation" — the feature's verb). Three color roles:
gray borders (on the two containers) + sand panel + clay annotation.
The small accent dot stays clean — no stroke clutter.

### Common thumbnail anti-patterns

- **Generic abstract shape.** Hub-and-spokes, 3 columns, grid of boxes —
  all are starting templates that need to be SPECIALIZED. If the same
  shape could illustrate three unrelated features, refine more.
- **No visible borders.** Solid color patches without strokes look
  like flat color blocks, not "boxes." All container classes have
  strokes baked in; don't bypass them.
- **Only two color roles.** Sand + clay only = flat. Add gray
  borders/lines as the third role.
- **All same primitive.** Six identical rects in a grid is wallpaper.
  Mix shape types to add visual variety.
- **Inline `fill=` / `stroke=` attributes.** Blocks the hover cascade
  and the stylesheet's built-in stroke. Class names only.
- **viewBox other than 120×80.** The CSS expects this aspect ratio.
- **`<defs>`, `<animate>`, internal markers.** Thumbnails are static;
  the card's CSS handles all hover/transition behavior.
- **Lone shape floating in empty space.** A single rect or one centered
  hub with no context reads as a placeholder, not an illustration.
  Cluster elements; show internal structure.
- **Shipping without visual verification.** Running `npx tend-cli preview-thumbnail`
  and reading the PNGs via the Read tool isn't optional — it's the
  only way to catch composition failures pixels reveal that the raw
  SVG markup hides (the 4-identical-thumbnails trap is the canonical
  example). The agent's introspection is not a substitute.
- **Fill-only classes on stroke-needing primitives.** `.tc-wh` / `.tc-bg`
  / `.tc-fg` / `.tc-ac` set `fill` only — no stroke. Putting them on
  `<line>` or `<path stroke=...>` produces an invisible element. Lines
  and strokes need `.tc-ln` (gray) or `.tc-la` (muted). Caught in the
  wild: `cli-status`'s gauge needle was `<line class="tc-fg" .../>` —
  invisible at thumbnail size, only the arc + center dot rendered.
- **Trusting the MCP return value over independent disk verification.**
  An MCP write can return success but the polyglot may not actually
  carry the new field (rare but documented). After every
  `tend_update_feature` that writes a `thumbnail`, re-read the polyglot
  via jq and confirm the field landed before moving on.

## Authoring persona avatars

A persona avatar is a small portrait of the persona *doing their characteristic activity*. The `catalog.personas[id].archetype` and `jobs[]` fields are the source.

### Staging

1. **Identify the moment** from the archetype — verb + setting + state. Not "team-lead" — "team-lead reviewing four work streams at a coordination meeting." Not "ops engineer" — "ops engineer pulled into the incident channel mid-deploy."
2. **Stage the figure and what they're doing as ONE silhouette in connected space**, preferably not just side-by-side. Touching, overlapping, sharing an axis, or visibly interacting. A figure beside an unrelated panel reads as two icons glued together, not a portrait.
3. **Medium crop**: torso & head plus one or two core items the moment hinges on.
4. **Place the one accent on the moment's pivot** — the screen, the mic, the node, the bar that spiked — whatever the activity centers on.
5. **Verify by silhouette**: mentally fill the composition solid black. Can you identify *this* persona? Among the project's other persona avatars, is the silhouette visibly distinct?

### Rendering primitives at this scale

Humanoid subjects: the reliable person glyph is a **head circle sitting directly on a shoulders shape, touching** — never two stacked ovals or a circle-on-a-circle (that reads as a snowman or a lollipop, not a person). The shoulders are a wide arc / bell roughly **twice the head's width**; the head sits into the top of them with no gap. Head ≈ one third of the figure's height, shoulders ≈ two thirds. That head-and-shoulders bust is the one shape that reliably reads as "a person" at 120×80 — compose the scene (props, panels, context) *around* it.

The shoulders arc is the part that's easy to get wrong. A dependable primitive — generic; set your own position, size, tone, and accent:

```xml
<!-- head: a circle -->
<circle class="tc-bg tc-frame" cx="40" cy="28" r="11"/>
<!-- shoulders: a wide arc rising to meet the head, ~2× head width, same fill -->
<path class="tc-bg tc-frame" d="M18 60 a22 20 0 0 1 44 0 Z"/>
```

Keep the head and shoulders the **same fill** so they read as one figure. Differentiate one persona from another by **shoulder width, head tilt, and the single accent** — not by swapping the head or body to other shapes, which stops reading as human. Optionally one limb-line as a gesture cue (an arm reaching to the prop). Non-humanoid subjects (systems, AI agents, organizations) use an abstract geometric form (hexagon, layered shape) instead — no head, no shoulders.

**Landscape canvas (viewBox 120×80) is wider than tall.** Tall standing poses don't fit — figures crouch, sit, lean, gesture, or are cropped at the chest.

## Authoring opportunity glyphs

Opportunity polyglots (catalog-anchor polyglots whose `oo-data.opportunity`
is set) describe a *pain* the project addresses. The glyph evokes the
pain itself — not a UI screen, not a person, not the solution.

### Realism at thumbnail size

Same brutal honesty: at 120×80, the pain must read as a *silhouette
metaphor*, not detail. A "leaky bucket" survives as a rounded rect with
two small drops below; the leak detail itself is invisible. A "broken
chain" survives as two ovals with a clear gap; the broken link's edges
are noise. Design for the *silhouette of the pain*, not its texture.

### The "name the pain" test

Looking at the glyph alone (no title), could a reader name the pain in
one phrase? "Something is leaking", "a path is broken", "a stack is
collapsing", "a clock is running out", "a container is empty". If the
glyph is purely decorative, it failed.

### Composition: one metaphor, breathing room

1. **One metaphor object** — central, ~50-70% of canvas, framed via
   `tc-wh tc-frame` or `tc-bg tc-frame`. Examples (do not enumerate
   forever — read the opportunity's own description first): a tilted
   stack, a fraying line, a clouded panel, a stopped indicator, a
   crowded box, an empty plate.
2. **One pain signal** — small accented detail naming the pain's
   *nature*: a drip, a crack, a gap, an arrow, a question mark, an
   off-position pointer. `.tc-ac` lands here.
3. **Negative space.** Pain is often felt as absence. Glyphs should
   feel emptier than feature thumbnails. Element budget: **5-9
   primitives**.

### Opportunity glyph anti-patterns

- **UI screenshot.** No code panels, kanban boards, or app chrome.
  The opportunity is upstream of any specific solution.
- **Person silhouette.** Personas have figures; opportunities don't.
  An opportunity glyph with a person blurs the distinction.
- **Multiple metaphors fighting.** One pain metaphor per glyph. Don't
  stack "broken chain + leaky bucket + clock". Pick one; let it breathe.
- **Resolution-focused.** The glyph represents the *pain*, not the
  fix. A patched bucket isn't an opportunity glyph — it's already a
  feature thumbnail.
- **Decorative pattern.** Repeating dots, abstract waves, gradients.
  The viewer must be able to name the pain; pretty is not enough.

## Visual verification (shared with diagrams)

Same loop applies to inline diagrams via `npx tend-cli preview-thumbnail --diagram <media_id> --feature <feature-id>`.

After authoring or modifying a thumbnail or diagram, visual verification is
REQUIRED. Introspecting raw SVG markup cannot catch the failure modes
that pixels reveal.

### 5-item review checklist

Walk these before marking a thumbnail done:

1. **Remove-title test.** Would the thumbnail alone identify the feature
   if the card's title text were removed? If it's interchangeable with
   any other feature's thumbnail, it's failed.
2. **Three color roles present.** Confirm gray borders/lines, container
   fills (sand/white), and at least one accent shape are all visible.
   Two-role thumbnails read flat.
3. **Border discipline.** Large containers carry `.tc-frame`; small
   accent shapes do not. Strokes on tiny shapes read as clutter.
4. **Both themes render correctly.** Light mode and dark mode PNGs both
   look legible. Color tokens handle this when class names are used
   correctly; inline `fill=` attributes break it.
5. **Composition density.** The thumbnail has internal structure — not
   a lone shape floating in empty space. Cluster elements; show what
   the feature does.

### Iteration loop

1. Draft SVG markup.
2. Run `npx tend-cli preview-thumbnail --svg "<svg ...>"` (before writing to polyglot) or `--id <feature-id>` (after writing).
3. The script prints two PNG paths (light + dark themes).
4. **Read both PNGs via your Read tool.** Claude views images directly when given a PNG path.
5. Walk the 5-item checklist above.
6. If any check fails, revise the SVG and loop back to step 1.

### The shuffle test — differentiation across a grid

When authoring thumbnails for a sibling set, use the cards preview:

1. `npx tend-cli preview-cards --parent <parent-id>`
2. Output is a composite PNG showing all sibling cards side-by-side.
3. **Read the PNG via your Read tool.**
4. Scan for thumbnails with similar dominant silhouettes — same basic
   shape, same structural composition. If two or more thumbnails look
   interchangeable at a glance, iterate on the weaker one(s) until
   each has a distinctive silhouette.

### Anti-pattern: skipping visual verification

The 4-identical-thumbnails trap: authoring four sibling thumbnails
with different intentions but similar primitive compositions — they
all end up looking like "rows of boxes" at card size. The agent
cannot detect this by reading SVG markup. Only rendering to pixels
reveals that `tc-wh tc-frame` rects with `tc-la` lines inside them
all collapse to the same visual pattern at 120×80 viewBox scale.

Running the preview script and reading the PNG is the only check
that catches this before shipping.
