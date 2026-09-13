/** Simple className combiner. Filters out falsy values. */
export function cn(...args: Array<string | false | null | undefined | 0>): string {
  return args.filter(Boolean).join(' ');
}
