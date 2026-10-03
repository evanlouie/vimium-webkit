/**
 * Vocabulary that every directory shares.
 *
 * The repeated pieces of Effect idiom, named once. Nothing here touches the
 * DOM or a global, so every directory may import it.
 */

import type { Record } from "effect";

/**
 * The fields of a variant that carries no data of its own.
 *
 * The type `{}` would mean any value that is not nullish.
 */
export type NoFields = Record.ReadonlyRecord<never, never>;
