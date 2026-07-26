/**
 * The count prefix.
 *
 * One implementation, because there were two: normal mode capped at 9999 with a
 * comment naming the exact hang it was preventing, and visual mode
 * re-implemented the same parsing with no cap at all — while suppressing every
 * keyboard event, so Escape could not abort the freeze either.
 */

/** Cap on the count prefix, so `999999999G` cannot be used to hang a tab. */
export const MAX_COUNT = 9999;

/**
 * Is this key a count digit *right now*?
 *
 * `0` is only a digit once a count is under way; otherwise it is a bindable key
 * in its own right, which is what makes upstream's `map 0 scrollToLeft` work.
 */
export const isCountDigit = (notation: string, started: boolean): boolean => {
  if (notation.length !== 1) return false;
  return started
    ? notation >= "0" && notation <= "9"
    : notation >= "1" && notation <= "9";
};

/** Fold one digit into a count, saturating at `MAX_COUNT`. */
export const appendCountDigit = (current: number, notation: string): number =>
  Math.min(MAX_COUNT, current * 10 + Number(notation));
