const BASE36_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const SUFFIX_LENGTH = 6;
const SESSION_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

function buildSuffix(rng: () => number): string {
  let result = '';
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    result += BASE36_CHARS[Math.floor(rng() * 36)];
  }
  return result;
}

export function generateSessionName(prefix?: string, rng: () => number = Math.random): string {
  const base = prefix ?? 'anon';
  return `${base}-${buildSuffix(rng)}`;
}

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_REGEX.test(name);
}
