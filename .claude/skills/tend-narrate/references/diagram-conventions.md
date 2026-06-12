# Diagram conventions reference

## Visual verification

After authoring or modifying a diagram SVG in `oo-data.media`, visual verification is required.
Use the same CLI command that covers thumbnails — the `--diagram` mode handles arbitrary viewBox dimensions:

```bash
npx tend-cli preview-thumbnail --diagram <media_id> --feature <feature-id>
```

This emits two paths: `/tmp/tend-thumb-<media_id>-light.png` and `-dark.png`. Read both via your
Read tool and walk the 5-item checklist in
[`thumbnail-authoring.md#visual-verification-shared-with-diagrams`](thumbnail-authoring.md).

Same 5-item checklist from `thumbnail-authoring.md` — diagrams differ only in dimensions; class
taxonomy, fill-vs-stroke rules, and verification rigor are identical.

## Diagrams — when an SVG carries more than prose

Humans need and enjoy visuals. Prose can carry a lot but not everything —
some shapes only land as pictures. The question isn't "should I add a
diagram?" — it's "is there a relationship/structure here that would be
*harder to grasp without* a picture?" If yes, draw. If no, don't.

### Shapes worth drawing

- **Structure** — boxes + arrows for "X depends on Y depends on Z" or
  "these three surfaces share one data block"
- **Flow** — pipelines, loops, sequences. The brainstorm → plan → run →
  audit loop; the seven-step side-effects pipeline; the request lifecycle
- **Hierarchy** — garden contains features contain subpages; class
  inheritance; data nesting
- **Comparison** — before/after; option A vs option B; what we chose vs
  what we considered
- **State machines** — when a thing has discrete states with named
  transitions

Not a shape, not a diagram. A list-rendered-as-boxes is not a diagram;
prose is better. A flowchart of "user clicks button → server processes
request" is a label, not insight.

### Trigger check — when to draw, instead of why not to

Agents often default to "skip the diagram, prose is enough" because diagrams
take effort and feel optional. The default is too aggressive. Before
shipping a narrative with zero diagrams, walk the prose and answer one
question for each section: **is the section describing a structural
relationship?**

Triggers — if any of these patterns appear in your prose, a diagram is
likely doing real work and prose alone is leaving signal on the floor:

- The text describes a DAG, a pipeline, or a sequence of named gates
  ("step 1 → step 2 → step 3", "parse → validate → respond", "draft →
  review → publish")
- The text names a state machine with discrete transitions
  ("idle → loading → ready → error", "draft → submitted → approved → published")
- The text describes a hierarchy with ≥ 2 levels
  ("garden contains features contain subpages")
- The text describes a matrix relationship (X owns Y, Y depends on Z,
  topic-A uses topic-B's CSS)
- The text uses an enumerated list with 4+ items and explicit cross-references
  between them (a "tour of the parts" that the reader has to mentally
  reconstruct as a shape)

If two or more of these are present, you are almost certainly under-
diagrammed. One precise SVG will compress the prose by 30–50% and make
the structure jump off the page.

**Counter-triggers** — keep prose-only when the section is:
- A single decision (one trade-off, one rationale)
- A taxonomy / list of options without inter-dependencies
- A historical or motivational paragraph ("before X existed, every
  feature had this problem…")
- A short single-axis story (cause → effect, one hop)

### Quality bar for a diagram that earns its place

A diagram passes the bar when **the picture is harder to do as prose**.
Walk through these before shipping each SVG:

1. **One strong diagram > three weak ones.** A page with one carefully
   composed diagram beats a page with three small box-and-arrow
   filler diagrams. Quality compounds; quantity dilutes. Most feature
   narratives need 0–1 diagrams; gardens 1–2.
2. **Element budget — ≤ 6 primary elements.** Count nodes + key labeled
   arrows (markers, defs, legends excluded). If your draft exceeds 6,
   you're drawing two diagrams stitched together — split or drop the
   secondary. A 6-step request pipeline IS one diagram (6 boxes + 5
   flow arrows). Add a sub-table inside it for a field-level diff and
   you have two diagrams masquerading as one.
3. **No compound diagrams.** One SVG = one shape. If you find yourself
   adding a sub-table, sub-grid, separate panel, or second flow inside
   the same `<svg>`, move the secondary to prose or split into two
   diagrams in different sections. Compound diagrams confuse hierarchy
   and dilute the focal claim.
4. **No floating annotations.** Text labels belong on arrows or inside
   nodes. If a label doesn't fit on an edge or in a box, that's a
   signal — move it to the surrounding prose or to a single
   `<figcaption>`. Loose "aborts on failure" / "atomic write" labels
   floating at SVG edges turn the diagram into a wall of text.
5. **Layout matches semantics.** Each shape category from "Shapes worth
   drawing" has a canonical arrow topology — match it. Stacking boxes
   without thinking about edge direction produces diagrams whose shape
   contradicts the prose.

   - **Pipeline / flow** — one chain: `A → B → C`.
   - **Fanout (1→N)** — arrows BRANCH from one source: `A → B`, `A → C`,
     `A → D`. Stacking B/C/D vertically with arrows between them
     (`A → B → C → D`) reads as serial — wrong topology for a fanout.
   - **Hierarchy** — containment or parent-to-children edges; never
     child-to-next-sibling.
   - **State machine** — labeled transitions between states; never a
     plain linear chain unless the machine is actually linear.
   - **Comparison** — parallel side-by-side regions; never stacked.

   Before shipping: re-read the prose this diagram supports. If it says
   "one X yields multiple Ys," your arrows must branch from X. If it
   says "X then Y then Z," your arrows form a chain. Topology must
   match the semantic claim.
6. **Information lives on the edges, not just the nodes.** Arrows say
   what the relationship is. "→ invalidates upward", "→ cites as
   evidence", "→ debounced 200ms". Boxes are nouns; arrows are the
   verbs that make the diagram non-trivial. A diagram where the arrows
   are unlabeled tells you "these things relate" — barely more than
   listing them.
7. **Use concrete examples, not abstract types.** In *your project's*
   diagram, show its real IDs (e.g. `user-login → session-store`),
   not `Service A → Service B`. Real IDs ground the reader. Even when
   the diagram is about an architectural pattern, anchor it in this
   project's instances.
8. **Visual hierarchy carries meaning.** Make the load-bearing node
   bigger, bolder, or accented. Make secondary nodes muted. If
   everything is the same weight, the diagram is a list. Use
   `var(--accent)` for the focal node; `var(--text-muted)` for
   supporting detail.
9. **Don't recapitulate prose.** If a paragraph just listed
   "garden contains features contain subpages", a diagram of three
   boxes with the same labels adds nothing. The diagram should show a
   *property of the relationship* the prose didn't carry — invalidation
   direction, scale of the contents, recursion depth.
10. **Show only what the diagram uniquely conveys.** Anything the
    reader already understood from prose should be implicit, not
    re-stated in box labels. Trim ruthlessly.
11. **Title or caption only when the diagram doesn't self-explain.**
    An SVG with clear box labels + arrow labels doesn't need
    "*Figure 1: System Architecture*" beneath it. The diagram speaks.
    If it needs a caption to be understood, the diagram is incomplete.

### SVG conventions (mechanics)

- **Width**: ≤ 720px (fits the main column). Never exceed 800.
- **Height**: unbounded — prefer tall to wide when content doesn't fit.
  Vertical layouts breathe; horizontal layouts cram. A pipeline of 6 steps
  reads better as a vertical stack than a 6-box-wide row that forces every
  label to wrap.
- **Type sizes**: 11–12px for primary labels, 9–10px for secondary,
  8–9px for captions inside the SVG. Smaller than 8 fails on retina.
- **Color via tokens — never hardcoded hex.** `currentColor` for
  strokes/text (theme-aware). For fills use CSS variables
  (`var(--accent)` focal, `var(--bg-2)` default,
  `var(--accent-weak)` highlighted-but-secondary,
  `var(--text-muted)` captions). Two application patterns —
  pick one per SVG, don't mix:
  - **Inline attributes** (default for standalone diagrams):
    `fill="var(--accent)"` on each primitive. Self-contained — the
    SVG carries its own colors.
  - **Class names + shared stylesheet** (when the SVG lives inside
    a hovering affordance, e.g. a card): apply class names to
    primitives; define each class's fill/stroke once in CSS using
    the same tokens. Enables `<container>:hover .class { fill: ... }`
    palette swaps via cascade. Inline `fill=` blocks the cascade, so
    omit it when using this pattern.
- **Stroke weights**: focal edges 2px, default edges 1.5px with
  `stroke-opacity="0.4"–"0.6"` for muted strokes. Heavy black borders
  read as harsh in dark mode.
- **Arrow markers**: define once, reuse:
  ```xml
  <defs>
    <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L6,3 z" fill="currentColor" opacity="0.5"/>
    </marker>
  </defs>
  ```
  Then `<line ... marker-end="url(#arr)"/>` on each edge.
- **Arc / curve connector labels**: place the label at the curve's
  *visual midpoint* with a small perpendicular offset *off* the curve —
  never centered on the path (the stroke bisects the glyphs) and never
  overlapping a node. For a quadratic `path d="M x0 y0 Q cx cy x1 y1"`,
  the midpoint is `( (x0 + 2cx + x1)/4 , (y0 + 2cy + y1)/4 )`; nudge it
  ~6–8px to the convex (outer) side. Set `text-anchor` by which side the
  label sits: `end` when it sits left of the curve, `start` when right,
  `middle` only when the curve is near-vertical and the label clears both
  sides. If the offset label still collides with the path or a box, the
  curve is too crowded — straighten it, move the node, or drop the label
  to prose.
- **No external resources**: no `<image href="...">`. Everything inline.
- **No SVG-internal animation or scripts.** No `<animate>`, `<set>`,
  or `<script>` tags; no JS event handlers inside the SVG. CSS
  transitions and animations on the SVG (or its container) are fine
  when purposeful — the standard pattern is a container `:hover` state
  that cascades a class-fill swap into the SVG (see Color above). Wrap
  any motion in `@media (prefers-reduced-motion: reduce)` to honor user
  preference.
- **Self-contained**: labels live in the SVG. Don't rely on prose
  immediately above/below to name the boxes — readers may arrive at
  the section via TOC scroll.

### Common SVG anti-patterns

- **Decorative diagrams.** A box labeled "User" with an arrow to a box
  labeled "System". Filler. Either the diagram carries real
  structural content or it doesn't earn its place.
- **Lists in box form.** Five labeled boxes in a row that the prose
  also lists — a bullet list does this better.
- **Unlabeled arrows.** Arrows without text say "things connect" —
  trivial. Every arrow earns at least a one-word verb.
- **Stale examples.** A diagram naming features that no longer exist
  or have been renamed. After any feature rename / removal, search
  the project for SVGs that reference the old name. (Use the
  `project_index` to spot-check after major renames.)
- **Repeat boxes for repeat concepts.** If the same node appears in
  three diagrams across three sections, it might be over-illustrated.
  Pick the one diagram where the node is load-bearing; in the others,
  refer in prose.
- **Compound diagrams.** A pipeline with a field-level diff table
  beneath it inside the same `<svg>` is two diagrams glued together.
  Split or move the secondary to prose.
- **Floating annotation soup.** Loose text labels at SVG edges
  describing exceptions ("aborts on failure", "returns affected IDs",
  "atomic write") belong in the surrounding prose, not in the picture.
- **Wide-and-cramped layouts.** Forcing 6+ nodes horizontally to honor
  the 720px width constraint produces walls of tiny wrapped text. Go
  vertical.
