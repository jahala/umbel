# Section themes reference

## Section titles are headlines, not labels

This is the highest-leverage rule. A reader scanning the TOC should be
able to predict what each section says — and want to read it. The h2 is
the **headline** of that section, not a structural label.

The transform: take the working title, then write the *headline* that
the section actually delivers — the mechanism, the bet, the trade.

| ✗ Working title (label) | ✓ Shipping headline shape |
|---|---|
| `## How it works` | the *mechanism* that makes it work |
| `## Why this shape` | the *bet* you made (and what alternative you rejected) |
| `## What this project is` | the *capability* it delivers, named directly |
| `## Trade-offs` | what you *gave up* to get what you wanted |
| `## Architecture` | the *shape* of the structure (one phrase) |
| `## How it relates` | the *role* this plays in the larger graph |
| `## Examples` | the *moment* it pays off |
| `## Scenario` (opener) | a *real moment* — name + time + situation |

Examples of the transform on imagined projects (any domain works):

- `## How it works` → `## The cache invalidates on every write`
- `## Why this shape` → `## Why we picked a queue over webhooks`
- `## What this project is` → `## A lighter way to onboard customers`
- `## Trade-offs` → `## We accept eventual consistency to scale writes`
- `## Architecture` → `## Three services share one event log`
- `## How it relates` → `## The seam between auth and billing`
- Scenario opener → `## Sam opens the dashboard at 8am before the standup`

Working titles ("How it works", "Why this shape", "Trade-offs") are useful
**while drafting** — they tell you what the section is *for*. But before
shipping, rewrite each h2 to deliver the section's actual insight.
Otherwise the TOC reads like a generic form template; an article TOC
should read like a magazine table of contents.

Subheadings (`###`) inside a section can be more conventional — they
narrate within an already-headlined arc.

## Section themes — pick what your narrative needs

These are working titles. Use them to outline; rewrite to insight
headlines before shipping (per the rule above).

| Theme (working) | Use when | Insight to deliver |
|---|---|---|
| how-it-works | The feature has a runtime story worth a walkthrough | Name the mechanism that makes it work |
| why-this-shape | Design has a non-obvious shape and alternatives were considered | Name the bet you made |
| trade-offs | The feature accepts a deliberate compromise | Name what you gave up to get what you wanted |
| edge-cases | Real-world inputs the bet's one-liners don't cover | Name the case that worried you |
| examples | Concrete usage worth showing | Name the moment it pays off |
| how-it-relates | Knot of cross-references — graph position matters | Name the role this plays in the graph |
| performance | Non-obvious performance characteristics | Name the cost dimension |
| security | Trust boundaries the feature crosses | Name the threat shape |

For **gardens**, the narrative has to do something feature narratives
don't: tell the reader **what the project actually does in practice**.
The bet says what the project IS; the narrative must connect that to
what a user DOES. Typical garden-level themes — name them with insight
headlines, never as labels:

- **Scenario opener (when positioning is in place)** — start the
  article in-scene with a real moment from a Job Story. Persona, time,
  situation, micro-decision. If `catalog.personas[].jobs[]` has
  populated entries, draft your opening section around the most
  load-bearing one. When the feature's checks carry `validates_job`,
  use the job *they actually point at* — not just any well-written
  job. That's the job whose validation the feature claims to prove;
  the narrative should open in its situation, not an unrelated one.
  If multiple checks point at different jobs, pick the most central
  one (often the check whose `validates: "what"` or `"why"` is the
  headline claim).
- **The runtime story / day-in-the-life** — pick the most common user
  flow and walk through it. What happens, in what order, between which
  pieces. This is where the project earns trust.
- **The architecture / how the pieces connect** — the surfaces, the
  services, the layers. Often a diagram opportunity.
- **The mental model / first principles** — the invariants that recur,
  the trade-offs the design takes a stance on.
- **What's in scope / what isn't** — the boundary of the bet. What
  this project will not become. (Often more valuable than what it
  will.)
- **Where it fits / how to adopt it** — onboarding, prerequisites,
  what the user replaces or augments.

Pick what the project actually needs; not all apply to every garden.
A garden narrative that's only "what" and "why" with no runtime story
leaves the reader without the picture they need to use the thing.

For **subpages** (smaller scope), usually just one runtime story
section is enough. Don't pad a subpage's narrative.
