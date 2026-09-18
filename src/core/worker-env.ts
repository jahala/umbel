// ---------------------------------------------------------------------------
// worker-env: what of the caller's environment a worker inherits (umbel#93)
// ---------------------------------------------------------------------------
//
// A worker used to receive the caller's whole environment, so every key and
// token in a conductor's shell reached every worker. It now inherits only what
// any CLI needs to run as its user (paths, locale, proxies, CA bundles, the ssh
// agent) and the variables its own provider reads, named by prefix. Anything
// else must be passed explicitly (--env, env:, {fromEnv}).
//
// Terminal-description variables are absent on purpose: inside tmux they must
// describe tmux's pane, which tmux sets itself, not the caller's terminal.

const INHERITED_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]);

const INHERITED_PREFIXES: readonly string[] = ['LC_', 'XDG_'];

// PURE. The subset of `source` a worker of a provider reading `providerPrefixes`
// inherits.
export function inheritedEnv(
  source: Record<string, string | undefined>,
  providerPrefixes: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const wanted =
      INHERITED_NAMES.has(k) ||
      INHERITED_PREFIXES.some((p) => k.startsWith(p)) ||
      providerPrefixes.some((p) => k.startsWith(p));
    if (wanted) out[k] = v;
  }
  return out;
}

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// PURE. The environment as the exports the launch wrapper evaluates: one per
// variable, the value single-quoted with each ' written as '\''. That quoting
// round-trips every byte an environment value can hold. A name no shell can
// export is skipped, since writing it would break the exports that follow.
export function envExports(env: Record<string, string>): string {
  let out = '';
  for (const [k, v] of Object.entries(env)) {
    if (!SHELL_NAME.test(k)) continue;
    out += `export ${k}='${v.replaceAll("'", "'\\''")}'\n`;
  }
  return out;
}
