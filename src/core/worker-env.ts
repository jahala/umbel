// ---------------------------------------------------------------------------
// worker-env: what of the caller's environment a worker inherits (umbel#93)
// ---------------------------------------------------------------------------
//
// A worker used to receive the caller's whole environment, so every key and
// token in a conductor's shell reached every worker. It now inherits only what
// any CLI needs to run as its user (paths, locale, proxies, CA bundles, the ssh
// agent) and the configuration its own provider reads. Anything else must be
// passed explicitly (--env, env:, {fromEnv}).
//
// Entries are exact names, or prefixes written with a trailing `*`.
//
// Terminal-description variables are absent on purpose: inside tmux they must
// describe tmux's pane, which tmux sets itself, not the caller's terminal.

const INHERITED: readonly string[] = [
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
  'LC_*',
  'XDG_*',
];

const matches = (name: string, entry: string): boolean =>
  entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry;

// PURE. The subset of `source` a worker inherits, given the entries its provider
// reads.
export function inheritedEnv(
  source: Record<string, string | undefined>,
  providerEnv: readonly string[],
): Record<string, string> {
  const wanted = [...INHERITED, ...providerEnv];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && wanted.some((entry) => matches(k, entry))) out[k] = v;
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
