export interface InvariantIssue {
  code: string;
  message: string;
  path?: string;
}

export type InvariantRule<T> = (value: Readonly<T>) => InvariantIssue | readonly InvariantIssue[] | undefined;

/**
 * A small, domain-owned invariant companion. The same rules are applied to
 * freshly proposed state and state restored from disk, so recovery cannot
 * silently accept a relationship that a live command would reject.
 */
export class InvariantSet<T> {
  constructor(
    readonly name: string,
    private readonly rules: readonly InvariantRule<T>[],
  ) {}

  inspect(value: Readonly<T>): InvariantIssue[] {
    return this.rules.flatMap((rule) => {
      const result = rule(value);
      return result === undefined ? [] : Array.isArray(result) ? [...result] : [result];
    });
  }

  assert(value: Readonly<T>, error: (message: string) => Error): void {
    const issues = this.inspect(value);
    if (!issues.length) return;
    const details = issues.map((issue) => `${issue.code}${issue.path ? ` at ${issue.path}` : ""}: ${issue.message}`).join("; ");
    throw error(`${this.name} invariant violation: ${details}`);
  }
}
