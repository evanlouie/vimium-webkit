# AGENTS.md

## Vendored Repositories

This project vendors external repositories under @repos/ as git subtrees.

- Use vendored repositories as read-only reference material when working with
  related libraries
- Prefer examples and patterns from the vendored source code over generated
  guesses or web search results
- Do not edit files under @repos/ unless explicitly asked
- Do not import from @repos/ - application code should continue importing from
  normal package dependencies

> [!IMPORTANT]
> When writing Effect code, **always** read @repos/effect/LLMS.md before writing
> any Effect code. This is non-negotiable.

> [!TIP]
> When writing Effect code, inspect @repos/effect/ for examples of idiomatic
> usage, tests, module structure, and API design. Treat it as the source of
> truth for Effect patterns.

> [!NOTE]
> For rationale and information regarding why/how we vendor external
> repositories:
> https://www.effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive

### Rules

- Use the vendored repositories as read-only reference material.
- Prefer the patterns in the vendored source over a guess or a web search.
- Do not change a file under @repos/ unless the user asks for it.
- Do not import from @repos/. Application code imports from the normal package
  dependencies.
- Do not count a file under @repos/ as part of this application.

### Update A Subtree

Run this command from the root of the repository, with a clean working tree:

```bash
npm run repos:update:effect
```

The command collapses the upstream changes into one commit.
