import type { z } from 'zod';

/**
 * Typed validation error with a precise field path into the parsed document.
 *
 * All contract parsers return `{ ok: false, errors: ContractValidationError[] }`
 * instead of throwing. Field paths use dot/bracket notation rooted at the
 * document, e.g. `scene.cameraTracks[1].keyframes[2].tMs`.
 */
export interface ContractValidationError {
  /** Dot/bracket path from the document root to the offending field. */
  readonly fieldPath: string;
  /** Machine-readable error code (see {@link ContractErrorCode}). */
  readonly code: ContractErrorCode;
  /** Human-readable explanation, safe to render in UI and logs. */
  readonly message: string;
}

export type ContractErrorCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'invalid_format'
  | 'out_of_range'
  | 'too_short'
  | 'too_long'
  | 'unrecognized_key'
  | 'unsupported_version'
  | 'nonmonotonic_sequence'
  | 'outside_time_window'
  | 'invalid_time_range'
  | 'missing_reference'
  | 'duplicate_value'
  | 'unsafe_asset_reference'
  | 'constraint_violation';

const PATH_ROOT = '(root)';

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return PATH_ROOT;
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out;
}

/** Map zod issue codes onto the stable contract error codes. */
function codeFor(issue: z.core.$ZodIssue): ContractErrorCode {
  switch (issue.code) {
    case 'invalid_type':
      return 'invalid_type';
    case 'invalid_value':
      return 'invalid_value';
    case 'invalid_format':
      return 'invalid_format';
    case 'too_small':
      return 'too_short';
    case 'too_big':
      return 'too_long';
    case 'not_multiple_of':
      return 'out_of_range';
    case 'unrecognized_keys':
      return 'unrecognized_key';
    case 'custom':
      return 'constraint_violation';
    default:
      return 'invalid_value';
  }
}

/**
 * Convert a zod `ZodError` into contract validation errors.
 *
 * Union issues are flattened: only the union's most informative sub-issues
 * are kept, so callers never see opaque `invalid_union` entries.
 */
export function toContractValidationErrors(error: z.ZodError): ContractValidationError[] {
  const errors: ContractValidationError[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'invalid_union') {
      const subIssues = (issue as unknown as { errors: z.core.$ZodIssue[][] }).errors.flat();
      for (const subIssue of subIssues.slice(0, 4)) {
        errors.push({
          fieldPath: formatPath(subIssue.path),
          code: codeFor(subIssue),
          message: subIssue.message,
        });
      }
      continue;
    }
    errors.push({
      fieldPath: formatPath(issue.path),
      code: codeFor(issue),
      message: issue.message,
    });
  }
  return dedupe(errors);
}

function dedupe(errors: ContractValidationError[]): ContractValidationError[] {
  const seen = new Set<string>();
  const out: ContractValidationError[] = [];
  for (const error of errors) {
    const key = `${error.fieldPath}|${error.code}|${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(error);
  }
  return out;
}

/** Common result shape for every contract parser in this package. */
export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly errors: ContractValidationError[] };
