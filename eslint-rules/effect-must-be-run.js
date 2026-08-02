/**
 * `void someEffect` and `await someEffect` do nothing at all.
 *
 * An `Effect` is an inert description. Creating one and discarding it compiles,
 * type-checks, and silently performs none of the work it describes. During the
 * migration this bug appeared eight times in code that had been reviewed —
 * settings writes, the find history, the frecency index, the zoom level and the
 * known-tab list were all being computed and thrown away.
 *
 * Nothing in the type system prevents it, because discarding a value is always
 * legal. So it is prevented here instead: an expression statement whose value
 * is an `Effect` has to be handed to a runtime, or explicitly named and passed
 * on. `void` does not count, and neither does `await`, which resolves an
 * `Effect` to itself.
 */

/** @type {import("eslint").Rule.RuleModule} */
export const effectMustBeRun = {
  meta: {
    type: "problem",
    docs: {
      description:
        "require an Effect to be run rather than discarded as a statement",
    },
    schema: [],
    messages: {
      discarded:
        "This Effect is created and discarded, so none of its work happens. " +
        "Run it (`runtime.runFork` / `runSync` / `runPromise`), yield it in an " +
        "`Effect.gen`, or return it.",
    },
  },

  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
    const checker = services.program.getTypeChecker();

    /** Is this the type of an Effect value? */
    const isEffect = (node) => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      if (!tsNode) return false;
      const type = checker.getTypeAtLocation(tsNode);
      const text = checker.typeToString(type);
      // `Effect<A, E, R>` and the aliases that resolve to it. Deliberately
      // textual: the alternative is reaching for Effect's internal type brand,
      // which is not part of its public surface and changes between betas.
      return /^Effect</.test(text) || /^Effect\.Effect</.test(text);
    };

    const report = (node) => context.report({ node, messageId: "discarded" });

    return {
      // `onPersist: () => someEffect` — a concise arrow body whose value is
      // discarded because the callback returns `void`. This is the dominant
      // callback shape in this codebase, and the one syntactic position the
      // statement check below cannot see.
      ArrowFunctionExpression(node) {
        if (node.body.type === "BlockStatement") return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        if (!tsNode) return;
        const signature = checker.getSignatureFromDeclaration(tsNode);
        const declared = signature === undefined
          ? undefined
          : checker.typeToString(checker.getReturnTypeOfSignature(signature));
        // Only when the *contextual* return type is void: an arrow that
        // genuinely returns an Effect is how every combinator is written.
        const contextual = checker.getContextualType(tsNode);
        if (contextual === undefined) return;
        const call = checker.getSignaturesOfType(contextual, 0)[0];
        if (call === undefined) return;
        const expected = checker.typeToString(
          checker.getReturnTypeOfSignature(call),
        );
        if (expected !== "void" && expected !== "undefined") return;
        if (declared !== undefined && /^Effect</.test(declared)) report(node);
      },

      ExpressionStatement(node) {
        let expression = node.expression;
        // `void e` and `await e` both leave the effect undone.
        while (
          (expression.type === "UnaryExpression" &&
            expression.operator === "void") ||
          expression.type === "AwaitExpression"
        ) {
          expression = expression.argument;
        }
        // A bare `runtime.runFork(...)` is fine; its own type is not an Effect.
        if (isEffect(expression)) report(node);
      },
    };
  },
};

export default { rules: { "effect-must-be-run": effectMustBeRun } };
