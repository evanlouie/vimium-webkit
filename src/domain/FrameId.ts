/**
 * The identity of one frame.
 *
 * `platform/Realm.ts` makes it, and the wire carries it as a plain string. The
 * schemas of `domain/FrameMessage.ts` decode each frame id on the wire into
 * this brand, so no code after the decode brands a string by hand.
 */

import { Schema, pipe } from "effect";

/** A frame identity. Random, per frame, and never reused. */
export const FrameId = pipe(Schema.String, Schema.brand("FrameId"));
export type FrameId = typeof FrameId.Type;
