const CREDENTIAL_PATTERNS = [
  /\b(?:api[_ -]?key|access[_ -]?token|password|secret|authorization)\s*[:=]\s*(?:bearer\s+)?\S{8,}/i,
  /\bbearer\s+[a-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|rk|pk)-(?:live|test|proj)?[-_a-z0-9]{12,}/i,
  /\b(?:gh[pousr]|github_pat)_[a-z0-9_]{12,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function containsObviousCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertCredentialSafe(values: readonly (string | null | undefined)[]): void {
  if (values.some((value) => value !== null && value !== undefined && containsObviousCredential(value))) {
    throw new Error('Free text appears to contain a credential; store a secure reference instead');
  }
}
