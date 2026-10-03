/**
 * Vocabulary that every directory shares.
 *
 * The repeated pieces of Effect idiom, named once. Nothing here touches the
 * DOM or a global, so every directory may import it.
 */

import { Context, Effect, Option, type Record, Scope, pipe } from "effect";

/**
 * The fields of a variant that carries no data of its own.
 *
 * The type `{}` would mean any value that is not nullish.
 */
export type NoFields = Record.ReadonlyRecord<never, never>;

/**
 * Run `f` on a value that is present. Absence does nothing.
 *
 * `Effect.transposeOption` runs an effect for a present value as well, but it
 * keeps the absence as its result. A caller that wants nothing back would
 * then need `Effect.asVoid` after it.
 */
export const whenSome =
  <A, E = never, R = never>(f: (value: A) => Effect.Effect<void, E, R>) =>
  (option: Option.Option<A>): Effect.Effect<void, E, R> =>
    pipe(option, Option.match({ onNone: () => Effect.void, onSome: f }));

/**
 * The requirements of work that runs later, with the scope taken out.
 *
 * A listener, a mode or a command body runs long after the code that
 * registered it, and the scope of that code is usually a layer scope, which
 * lasts as long as the page. A resource that the work acquired there would
 * stay for the life of the page, and nothing would release it when the work
 * is done. Work that needs a scope makes its own with `Effect.scoped`. Type
 * the work with this, so that work that asks for the caller's scope does not
 * compile.
 */
export type Unscoped<R> = Exclude<R, Scope.Scope>;

/**
 * The services of the caller, for work that runs later, without its scope.
 *
 * `Effect.context` gives the whole context, whatever its type says, and the
 * context of a layer holds the layer scope. Read `Unscoped`.
 */
export const captureServices = <R>(): Effect.Effect<Context.Context<Unscoped<R>>, never, R> =>
  pipe(Effect.context<R>(), Effect.map(Context.omit(Scope.Scope)));

/** Take the scope out of the context that an effect runs in. */
const withoutScope = (context: Context.Context<never>): Context.Context<never> =>
  pipe(context, Context.omit(Scope.Scope));

/**
 * Bind work that runs later to the services of the caller.
 *
 * The work also runs with the services of the code that runs it, as
 * `Effect.provideContext` does, but with no scope from either. A fiber that a
 * layer forked holds the layer scope as well.
 */
export const bindServices = <R>(): Effect.Effect<
  <A, E>(work: Effect.Effect<A, E, Unscoped<R>>) => Effect.Effect<A, E>,
  never,
  R
> =>
  pipe(
    captureServices<R>(),
    Effect.map(
      (services) =>
        <A, E>(work: Effect.Effect<A, E, Unscoped<R>>): Effect.Effect<A, E> =>
          pipe(work, Effect.provideContext(services), Effect.updateContext(withoutScope)),
    ),
  );
