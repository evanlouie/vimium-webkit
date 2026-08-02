/**
 * How a failure reaches the user.
 *
 * One rule, in one place. No service decides for itself how to speak to the
 * user, and no service has to depend on the HUD to say something.
 *
 * The queue is unbounded, and it is a queue and not a broadcast. The HUD does
 * not exist when the application first reads storage, and a message that nobody
 * heard is exactly the failure that this service exists to prevent.
 */

import { Context, Effect, Layer, Queue, Stream } from "effect";

export type MessageLevel = "info" | "error";

export interface UserMessage {
  readonly level: MessageLevel;
  readonly text: string;
}

export class Report extends Context.Service<Report, {
  /** Tell the user that something did not work. */
  readonly error: (text: string) => Effect.Effect<void>;
  /** Tell the user what happened. */
  readonly info: (text: string) => Effect.Effect<void>;
  /** Every message, in order, from the start of the application. */
  readonly messages: Stream.Stream<UserMessage>;
}>()("vimium/core/Report") {
  static readonly layer: Layer.Layer<Report> = Layer.effect(
    Report,
    Effect.gen(function*() {
      const queue = yield* Queue.unbounded<UserMessage>();
      const put = (level: MessageLevel) => (text: string) =>
        Effect.asVoid(Queue.offer(queue, { level, text }));
      return Report.of({
        error: put("error"),
        info: put("info"),
        messages: Stream.fromQueue(queue),
      });
    }),
  );
}
