# Renderer support reference

## What the renderer supports (and what it doesn't)

The polyglot's markdown parser is intentionally narrow. Know it before
you write — otherwise you'll waste tokens producing syntax that renders
as raw text.

**Supported markdown:**

| Syntax | Renders as |
|---|---|
| `## Heading` / `### sub` / `#### sub-sub` | `<h2>` / `<h3>` / `<h4>` (h2 + h3 feed the TOC) |
| Paragraph (blank-line separated) | `<p>...</p>` |
| ` ```lang ... ``` ` | `<pre><code class="lang-lang">...</code></pre>` |
| `- item` or `* item` | `<ul><li>...</li></ul>` |
| `1. item` | `<ol><li>...</li></ul>` |
| `` `code` `` | `<code>...</code>` |
| `**bold**` | `<strong>...</strong>` |
| `_em_` | `<em>...</em>` |
| `[text](url)` | `<a href="url">text</a>` |

**NOT supported (will render as raw text):**

- Markdown tables (`| col | col |\n|---|---|`) — use raw `<table>` HTML
- Blockquotes (`> ...`) — use `<aside>` or rephrase as prose
- Strikethrough (`~~text~~`)
- Footnotes
- Definition lists
- Setext headings (underline syntax)
- Reference-style links (`[label][1]`)

**Raw HTML pass-through (use for the unsupported cases above):**

The parser preserves raw HTML for these top-level tags:
`<svg>`, `<table>`, `<figure>`, `<details>`, `<div>`, `<section>`,
`<aside>`, `<nav>`. Open the tag at the start of a line and close it
the same way; the parser passes everything between through verbatim.

**Tables — when prose isn't structured enough.** Write `<table>` HTML
inline, in the markdown body:

```markdown
## The same shape at every level

<table>
  <thead>
    <tr><th>Level</th><th>Bet</th><th>Steps mean</th></tr>
  </thead>
  <tbody>
    <tr><td>Project</td><td>The whole product</td><td>Child features</td></tr>
    <tr><td>Feature</td><td>A capability</td><td>Inline implementation steps</td></tr>
    <tr><td>Sub-aspect</td><td>One focused dimension</td><td>Steps that prove the parent's claim</td></tr>
  </tbody>
</table>

The recursion is structural, not metaphorical.
```

Tables work best for short rows of structured content — comparisons,
matrices, before/after. If a row has more than a sentence of body, the
shape probably wants prose with subheadings instead.

**Callouts / asides — when one paragraph needs visual lift.** Use
`<aside>`:

```markdown
<aside>
A note: this section assumes the reader has installed and run
the project at least once.
</aside>
```

The `<aside>` carries semantic meaning (this is supporting commentary,
not the main argument) and can be styled distinctly.

**Collapsible details — for "skip if you trust me" content.** Use
`<details>`:

```markdown
<details>
<summary>Why we picked this shape (long version)</summary>

Three considerations drove the choice... [several paragraphs]
</details>
```

Don't hide critical information behind `<details>`. It's for context
that some readers want and others don't.

**Reserved card-grid tokens — inline entity grids in the garden narrative.**
Three tokens are reserved and resolve to full card grids when used in the
`narrative` field of a garden polyglot:

| Token | Renders |
|---|---|
| `[personas]` | Card grid of `catalog.personas` |
| `[features]` | Card grid of `features_aggregate` (top-level only) |
| `[opportunities]` | Card grid of `catalog.opportunities` |

Usage: place the token on its own line inside the narrative, surrounded by blank lines, like any block-level element:

```markdown
## Who it's for

[personas]

## What we're building

[features]
```

Reserved tokens take precedence over any `media` key with the same name. When
the source data is empty (e.g., no personas defined yet), the token is stripped
silently — no empty section is emitted. These tokens are only meaningful in
garden narratives; they work in feature narratives too but will find no data to
render (the card grid section is omitted).

**Diagram preview** — `npx tend-cli preview-thumbnail` supports both `--id` (thumbnails, 120×80 viewBox)
and `--diagram <media_id> --feature <id>` (any viewBox — renders at 4× the SVG's viewBox width).
Use the `--diagram` mode to visually verify any `oo-data.media` SVG before shipping.
