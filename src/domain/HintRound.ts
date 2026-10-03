/**
 * The rules of a cross-frame hint round.
 *
 * Ported from the Vimium `content_scripts/link_hints.js` (`HintCoordinator`),
 * MIT.
 *
 * A round is one press of a hint key, across every frame of the page. The top
 * frame holds the one live round of the page. Every other frame that answered
 * the collection holds a record of the round that it answered, and that record
 * is what authorises an activation from another frame. The decisions over
 * those records are here, and they take plain data. The hints layer reads the
 * records, asks these functions, and carries out the answer.
 */

import { Array, Data, flow, Match, Option, pipe } from "effect";
import type { FrameId } from "~/domain/FrameId.ts";
import type { HintMode, MessageOf } from "~/domain/FrameMessage.ts";
import { drivenBy, type SessionRole } from "~/domain/HintSession.ts";
import type { NoFields } from "~/domain/Prelude.ts";

/**
 * How long a round keeps authorising a remote activation.
 *
 * It is the same value in every frame. Filter mode with
 * `waitForEnterForFilteredHints` can keep a session open while the user reads
 * the page, so this bounds a capability, and it is not a limit on an
 * interaction.
 */
export const ROUND_TTL_MS = 120_000;

/** How many ended rounds a frame remembers, so that a late message for one is dropped. */
const CANCELLED_ROUNDS_KEPT = 32;

/** What this frame remembers about the round that it answered. */
export interface LocalRound {
  readonly roundId: string;
  readonly coordinator: FrameId;
  readonly mode: HintMode;
  readonly openedAt: number;
  /** The frame that drives the round. It is known from the `COLLECT_HINTS`. */
  readonly origin: FrameId;
}

/** What the top frame remembers about the one live round of the page. */
export interface TopRound {
  readonly roundId: string;
  readonly origin: FrameId;
  readonly mode: HintMode;
  readonly startedAt: number;
}

/** A session of a round, as the round rules see it. */
export interface RoundSession {
  readonly roundId: string;
  readonly role: SessionRole;
}

/** Is this the record of the round that `origin` owns? */
export const isTopRoundOf =
  (roundId: string, origin: FrameId) =>
  (live: TopRound): boolean =>
    live.roundId === roundId && live.origin === origin;

/**
 * Does a live round of another frame keep a new round out?
 *
 * One live round for the whole page. An admitted frame could otherwise start
 * detection passes without a limit. The frame that owns the live round may
 * replace it, because a frame that asks again has left the round that it had.
 */
export const blocksRound =
  (from: FrameId, now: number) =>
  (live: TopRound): boolean =>
    now - live.startedAt <= ROUND_TTL_MS && live.origin !== from;

/**
 * Does an `ACTIVATE` name the round that this frame answered?
 *
 * A round exists in this frame only after it answered a `COLLECT_HINTS`.
 * Anything else is not a round that it takes part in. The origin of a round
 * drives its own session, and it never joins as a participant.
 */
export const joinsRound =
  (payload: MessageOf<"ACTIVATE">, self: FrameId, now: number) =>
  (round: LocalRound): boolean =>
    payload.originFrameId !== self &&
    now - round.openedAt <= ROUND_TTL_MS &&
    round.roundId === payload.roundId &&
    round.mode === payload.mode &&
    round.origin === payload.originFrameId;

/** What a frame does with an `ACTIVATE_HINT`. */
export type HintRequest = Data.TaggedEnum<{
  /** It is not for the round of this frame, or not from the frame that drives it. */
  Ignore: NoFields;
  /** The round is too old. It is forgotten. */
  Expire: NoFields;
  Admit: NoFields;
}>;

export const HintRequest = Data.taggedEnum<HintRequest>();

/**
 * Only the frame that owns the live round may drive it. This message ends in a
 * click, a hover, a focus or a clipboard write inside a document of another
 * origin.
 */
export const judgeHintRequest = (
  round: Option.Option<LocalRound>,
  payload: MessageOf<"ACTIVATE_HINT">,
  from: FrameId,
  now: number,
): HintRequest =>
  pipe(
    round,
    Option.filter((round) => round.roundId === payload.roundId),
    Option.match({
      onNone: () => HintRequest.Ignore(),
      onSome: (round) =>
        pipe(
          Match.value(round),
          Match.withReturnType<HintRequest>(),
          Match.when(
            (round) => now - round.openedAt > ROUND_TTL_MS,
            () => HintRequest.Expire(),
          ),
          Match.when(
            (round) => round.origin === from && round.mode === payload.mode,
            () => HintRequest.Admit(),
          ),
          Match.orElse(() => HintRequest.Ignore()),
        ),
    }),
  );

/** A `CANCEL_HINTS` from the origin or the coordinator of this round ends it here. */
export const cancelsLocalRound =
  (roundId: string, from: FrameId) =>
  (round: LocalRound): boolean =>
    round.roundId === roundId && (round.origin === from || round.coordinator === from);

/** A `CANCEL_HINTS` ends a session of the round that this frame follows. */
export const cancelsSession =
  (roundId: string, from: FrameId, localRound: Option.Option<LocalRound>) =>
  (session: RoundSession): boolean =>
    session.roundId === roundId &&
    pipe(
      localRound,
      Option.exists((round) => drivenBy(from)(session.role) || round.coordinator === from),
    );

/** A keystroke counts inside a participant session only, and only from the frame that drives it. */
export const followsKeysOf =
  (from: FrameId, roundId: string) =>
  (session: RoundSession): boolean =>
    session.roundId === roundId && drivenBy(from)(session.role);

/** The ended rounds, with one more. The oldest go when the list is full. */
export const withRound = (roundId: string): ((rounds: readonly string[]) => readonly string[]) =>
  flow(Array.union([roundId]), Array.takeRight(CANCELLED_ROUNDS_KEPT));
