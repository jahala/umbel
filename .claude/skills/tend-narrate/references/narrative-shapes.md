# Narrative shapes reference

Generic guidance for narrating any polyglot in any project. Every rule
here is **checkable against your own output** — no "make it engaging"
vibes. Examples use invented neutral ids (`checkout`, `auth`,
`inventory`); never a host project's real ids.

## Anti-uniformity caveat — read this first

The five shapes below are **reader contracts and sensible defaults, not a
mandatory heading list.** Do not stamp the same section skeleton onto
every page — that produces a project where every article reads like the
same form with different nouns, which is exactly the failure narrative
exists to prevent. A page earns each section by having something to say
there; a capability with no interesting trade-off skips "what it refuses
to do," a child page that's pure mechanism skips the scene.

**The acceptance bar is the cold-entry test (below), not heading
conformance.** A page passes if a cold reader can answer the four
questions in a glance — regardless of which section names you used. Use
the shapes to decide what a reader of *this class* expects to find; then
write the sections this *specific* page actually needs, and rewrite every
working title to its insight (see `section-themes.md`).

## Entry happens at every layer

A link gets sent; a search lands deep. So **every page answers four
questions in its first screen**: *where am I · what is this · is it proven
· where next.* This is the cold-entry test (last section) — the
acceptance bar for all five shapes.

**The funnel law:** abstraction inverts as you descend. The garden shows
the system working in product terms; capability pages deliver mechanism;
children carry API-grade detail. A page never does the layer-above's job —
children don't re-explain the capability, capability pages don't re-pitch
the project. Check: does this narrative restate what its parent already
said? If yes, cut it and link up.

## The five page-class shapes

Detect the class before drafting: `data.persona` set → persona page;
`data.opportunity` set → opportunity page; `kind: garden` → garden;
`parent` set → child; else → capability bet.

**A — Garden** (the project's "about" page). Orient a cold reader in 60s,
show the system working, invite drilling. Sections: **lede** (what this
project is, in product terms) → **the vision** (why it exists; told ONCE,
here) → **how the map is organized** (the capability clusters) → **how to
read any page** (the ONLY place the slots/checks/rail tutorial lives — one
short section; capability pages never re-teach it) → **where the edges
are** (the honest NOT-FOR). The cockpit (rail) is the proof block; cards
are navigation.

**B — Capability bet** (top-level features; the chapters).
Marketing-grade, cold-readable. Sections: **lede** (the story in 2–3
sentences: who hurts, what this does, what changed) → **scene** (one
persona moment — concrete situation, 2–4 sentences) → **how it works**
(mechanism; depth as the content earns it; one diagram only where it
carries load words can't) → **why this shape** (the load-bearing design
decision; link `decisions[]`) → **what it refuses to do** (the honesty
section) → **where next** (links woven through prose, not appended).

**C — Child / subsystem** (`parent` set). Technical depth is correct here
— this is where API-grade detail LIVES so capability pages stay readable.
Sections: **lede** (what this does for the parent, 2 sentences) → **how it
works** (deep) → **edge cases / limits**. Links UP (parent) + ACROSS (≥1
sibling) are mandatory.

**D — Persona** (`data.persona` set). Doubles as a segmentation page.
Sections: **archetype as lead quote** → **the week** (scenarios, in THEIR
voice) → **jobs** (the job-story list, validation clauses emphasized) →
**how the product serves them** (links to the capability pages that serve
each job) → **voice**. Shuffle test: no two personas share a register; a
product-copy paragraph is a defect — the persona describes their life,
never the tool's features.

**E — Opportunity** (`data.opportunity` set). Sections: **the scene**
(pain, felt) → **what good looks like** (observable) → **the riskiest
assumption** (honest) → **what solves it** (feature links). Bet-shape
sections (slots/checks/audit) do NOT apply — an opportunity is a pain, not
a bet.

## Lede rules

The lede earns the read. **Check each before shipping:**

1. The first sentence names a person, a pain, or a consequence — NOT a
   file path, a line count, or a mechanism.
2. By the end of the first paragraph the reader knows *what this is and
   why it matters* — not how it's built.
3. No hard-coded count opens the page (see voice constants).

GOOD (capability bet, neutral): *"A shopper fills a cart, taps pay, and
the page hangs for nine seconds. `checkout` cuts that to one — by settling
payment before the confirmation render, not after."*
— opens on the person and the consequence; mechanism arrives only to close
the promise.

BAD: *"`src/checkout/index.ts` is 240 lines. It exports four functions and
a `processOrder` switch with eight arms."*
— opens on trivia; the reader learns the shape of the file before learning
what the file is for. This is the single most common failure mode.

## Voice constants (all classes)

- **Honest > impressive.** Show the artifact; don't assert the adjective.
  Write "audited", not "reliable"; "passes the negative-control", not
  "robust".
- **Concrete > general.** Use real file paths, function names, command
  strings — backtick-bounded (`` `src/foo.ts` `` / `` `src/foo.ts:funcName` ``)
  so the validator flags drift. Check: could this sentence describe a
  different project unchanged? If yes, it's too general.
- **Name a person.** A page with zero humans is a defect at classes
  A/B/D/E (acceptable at C). Check: does a persona, in a concrete
  situation, appear in the prose?
- **Never duplicate the rail.** Checks, steps, smoke, CSS values, file
  inventories, status chips, maintenance-log notes, superseded notices all
  live in the rail. If a sentence restates a rail fact, cut it. Check: is
  this fact already visible at-a-glance on the right?
- **No hard-coded counts** ("the 19 codes", "37 lines", "exports four
  functions") UNLESS the count IS the story. Counts rot silently. Prefer
  "the reason-code table" over "the 19 codes". Check: if this number
  changed tomorrow, would the sentence become a lie? If yes, name the
  thing, not the count.
- **Insight headlines, not inventory labels.** A section title predicts
  its insight: "Reasons, not just a ranking" — not "How it works". The
  canonical section names above (Scene, How it works, etc.) are working
  titles; rewrite each to its insight before shipping (see
  `section-themes.md`). Check the TOC: does it read like a magazine
  contents page or a blank form?
- **Greenfield posture, present tense.** Write what IS. No "we will",
  "until now this was implicit", "binding X newly enables Y" — that's
  retrospective; it belongs in git history.
- **Every claim is demonstrable or marked aspirational.** A "the user gets
  X" claim must mirror a bound check's validation clause. Unproven claims
  are named as aspirations, not stated as facts.

## Link grammar

Every page links three directions:

- **UP** — to its parent (children, capability pages) or the garden.
- **ACROSS** — to ≥1 sibling.
- **INTO THE SPINE** — to ≥1 persona or opportunity it serves.

The garden links **DOWN** into capability pages; capability pages link
down into children. **Zero-link pages are defects.** Links are woven into
sentences, not appended as a "See also" list. Wiki forms: bare known ids
as inline markdown links (`the [order pipeline](order-pipeline.tend.html)`),
or `[[id]]` where the pipeline supports it.

Check: scan your draft for every named capability — does each name that
has a page appear as a live link?

## The cold-entry test (acceptance bar)

A cold reader landing on this page (no prior context) can answer all four
in 60 seconds:

1. **Where am I** — what kind of page, what part of the project.
2. **What is this** — the capability / persona / pain in one sentence.
3. **Is it proven** — the rail's audit verdict / evidence, or an honest
   "aspiration".
4. **Where next** — at least one link onward.

If any answer takes longer than a glance, the page fails. Apply at
spot-review and owner review.
