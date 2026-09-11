// Hand-split plan generator for umbel's conducted loops, adapted from pleach's
// docs/dogfood/make-plan.ts. tend2 emit-plan emits ONE node per loop (jahala/tend#158) and no
// phased work, so this takes a loop spec (one file per loop beside its plan.json) and writes one
// PHASED node per check: RED writes the failing test at the check's evidence path, IMPL builds,
// GREEN proves `bun run check`. Every node's smoke is `weeder check --strict`; its audit is the
// tend2 verifier on that one check, run cross-provider (opencode/DeepSeek) as audit egress.
//
//   bun docs/dogfood/make-plan.ts docs/dogfood/<loop>/loop.ts > docs/dogfood/<loop>/plan.json
//
// The spec's payload is the loop page's payload pin as `tend2 emit-plan` computes it; regenerate
// the plan whenever the page changes (a Tried line moves it).

export interface Check {
  n: number; // the check's position on the page (1-based) — what `tend2 verify --check N` takes
  id: string; // node id
  claim: string;
  evidence: string;
  needs: string[];
  how: string; // how this node fits: where it lives, what to reuse, what NOT to touch
  timeoutMs?: number;
}

export interface LoopSpec {
  loop: string; // the page, repo-relative
  payload: string; // tend2's payload pin for the page as shaped
  title: string; // one line: what the loop is
  goal: string; // the dek's Goal, for the worker's context
  issue: string; // the GitHub issue the loop closes, e.g. jahala/umbel#53
  sink: string; // the node whose audit verifies the whole page
  checks: Check[];
}

const VERIFY = '/opt/homebrew/bin/tend2';
const WEEDER = '/Users/jahala/.local/bin/weeder';
const WORKER = { provider: 'claude', model: 'claude-opus-5' };
// The cross-provider auditor: opencode + DeepSeek V4 Pro (codex 404s inside umbel, 2026-09-08).
const AUDITOR =
  process.env.PLEACH_AUDITOR === 'opencode'
    ? { provider: 'opencode', model: 'deepseek/deepseek-v4-pro' }
    : { provider: 'codex', model: undefined };

const specPath = process.argv[2];
if (specPath === undefined) {
  process.stderr.write('usage: bun docs/dogfood/make-plan.ts docs/dogfood/<loop>/loop.ts\n');
  process.exit(2);
}
const spec = (await import(`${process.cwd()}/${specPath}`)).default as LoopSpec;
const LOOP = spec.loop;
const loopId = LOOP.replace(/^docs\/tend2\//, '').replace(/\.tend2\.html$/, '');

function verify(check?: number): string {
  const scope = check === undefined ? '' : ` --check ${check}`;
  return `${VERIFY} verify ${LOOP} --repo-root .${scope} --force --runner 'bun test {evidence}' --audit-egress --expect-payload ${spec.payload}`;
}

const ENV = `## Your environment
- You are at the repository root of an isolated git worktree of umbel. Work here directly.
- Read CLAUDE.md FIRST and conform to it (it is binding: S.U.P.E.R. with strict downward layers core → adapters → operations → faces, test first against the fake binaries in test/fixtures/fake-*.sh, no daemon, files as IPC, typed errors in src/core/errors.ts caught at the face, one zod schema per concept, never \`rm\`). Then read docs/architecture-v3.md §3–§5 and §9–§10. Then read the loop file ${LOOP} including its narrative and Tried — it is your full context and it is READ-ONLY for you (check states belong to the verifier; a Tried line moves the payload pin).
- Leave your changes in the working tree; do not create branches, commit, or push.
- \`bun run check\` (typecheck + biome on src and test + unit, integration and e2e tests) is the repository's green; it must be green when you finish. The smoke suites under test/smoke need real binaries and UMBEL_SMOKE=1; they are not part of check and you must not run them.
- Never launch a real provider binary from a test and never run \`bun run install:bin\` or touch ~/.local/bin/umbel: the installed umbel is the binary driving you.
- Probe/scratch files go in \`.loop-scratch/\` only. If genuinely blocked, write BLOCKED.md at the repo root — what you tried, what stopped you, what a fix needs — instead of faking a green.`;

const RULES = `## Rules
- Solve the CLASS of problem the claim names, not the test's example inputs; no answer keys.
- Never weaken, skip, or mock the unit under test; integration and e2e tests drive the fake binaries and real tmux, never behaviour mocks.
- Production quality only; match the surrounding style; the smallest change that is honest.
- Your FINAL message must end with one line of the form \`Tried: YYYY-MM-DD <what you did, what you rejected and why, anything the next worker must know>\` — the conductor transcribes it into the loop page.`;

function prompt(c: Check, phase: 'red' | 'impl' | 'green'): string {
  const head = `You are a worker in a build loop. Make the check below pass, honestly. Nobody reviews your prose — only the verifier's verdict counts.\n\n## The loop\n${spec.title} (closes ${spec.issue}; loop ${LOOP}). ${spec.goal}\n\n## Your check (c${c.n})\n- (code) ${c.claim} · evidence: ${c.evidence}\n\n## How this node fits\n${c.how}\n\n${ENV}`;
  if (phase === 'red') {
    return `${head}\n\n## This phase: RED\nWrite the failing test FIRST at ${c.evidence} — a real test of the claim above, against real behaviour (no mocks of the unit under test). Do not implement anything yet. Run \`bun test ${c.evidence}\` yourself and confirm it FAILS for the right reason (the missing behaviour, not a typo or import error). The conductor will run \`bun run check\` and require it to be RED. Then stop.\n\n${RULES}`;
  }
  if (phase === 'impl') {
    return `${head}\n\n## This phase: IMPLEMENT\nThe failing test at ${c.evidence} is in place. Now make it pass with the smallest honest change, per the How above and CLAUDE.md. Do not weaken the test. Run \`bun test ${c.evidence}\` yourself, then stop.\n\n${RULES}`;
  }
  return `${head}\n\n## This phase: GREEN\nRun \`bun run check\` (typecheck + biome + unit, integration and e2e tests) and fix anything red — including biome formatting of your new files (\`bunx biome check --write <file>\` on files you created is fine). The conductor requires \`bun run check\` to exit 0 and will then run \`${WEEDER} check --strict\` on your diff (no deleted tests, no weakened assertions, no stubs/TODOs, no secrets, no files outside the work) and the tend2 verifier on your check. Then stop, ending your final message with the dated Tried line.\n\n${RULES}`;
}

const plan = {
  goal: `${spec.title} (${spec.issue}) — ${LOOP}`,
  source: LOOP,
  maxConcurrency: 2,
  nodes: spec.checks.map((c) => ({
    id: c.id,
    worker: WORKER,
    work: {
      test: 'bun run check',
      phases: [
        { phase: 'red', prompt: prompt(c, 'red') },
        { phase: 'impl', prompt: prompt(c, 'impl') },
        { phase: 'green', prompt: prompt(c, 'green') },
      ],
    },
    needs: c.needs,
    // A fresh worktree has no environment: dependencies are provisioned in setup, never in
    // acceptance text (that would change acceptance identity and re-dispatch verified nodes).
    setup: 'bun install --frozen-lockfile',
    accept: {
      smoke: `${WEEDER} check --strict`,
      audit: {
        command: verify(c.id === spec.sink ? undefined : c.n),
        provider: AUDITOR.provider,
        ...(AUDITOR.model !== undefined ? { model: AUDITOR.model } : {}),
        selfIntegrity: true,
      },
    },
    policy: { maxAttempts: 2, timeoutMs: c.timeoutMs ?? 1_800_000 },
    closes: [`${loopId}:c${c.n}`],
  })),
};

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
