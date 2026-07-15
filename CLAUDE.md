# Project Rules

## Core Philosophy

- Prefer changes that keep the code easy to modify.
- Avoid duplicating knowledge or intent.
- Choose readable, obvious solutions over clever ones.
- Reuse proven solutions before inventing new ones.
- Give each function, component, and module one clear job.
- Prefer composition and factory functions over inheritance-heavy designs.

## Before You Touch Anything

- Read the file before making assumptions based on its name.
- Confirm the blast radius of a change before making it, especially for anything touching shared state, the ECS world, or the game loop.
- Stop and ask before adding dependencies or changing unrelated files.
- Never refactor and add features in the same pass.
- Prefer `TODO:` comments over silent assumptions when context is ambiguous.

## TypeScript

- Prefer `type` and `interface` over `any` or broad `unknown`; narrow types early.
- Use discriminated unions over boolean flags when a value has multiple distinct states.
- Let the type system document intent. If a type needs a comment, it is probably not specific enough.

## ECS Rules

- Components are pure data: no logic, no methods.
- Systems own the logic for their component domain.
- Do not let component access bleed across system boundaries.

## Functions and Modules

- Create helper functions when they improve readability, isolate logic, or reduce noise in the main flow.
- Use objects when they clarify ownership or lifecycle; otherwise prefer plain functions.
- Prefer one primary export per file.
- Use barrel `index.ts` files only when the API surface is intentionally grouped.
- Co-locate tests with the module they cover.

## React

- Compute before return; keep JSX declarative.
- Keep exported APIs stable unless a change is explicitly requested.

## Comments and Naming

- Use names for what; use comments for why, tradeoffs, and non-obvious context.
- Delete comments that merely restate the code.

## Logging

- Log debug messages using the method defined in `logging.ts`.
- Debug logs must be disabled by default but easy to enable.

## Testing and Black Boxes

- Break code into distinct, testable chunks. Once tested, treat them as functioning black boxes.
- Do not re-run a black box's tests unless its code changes.
- Do not modify an existing black box unless explicitly instructed to do so; flag it instead.
- If a requested change requires touching an existing black box, stop and surface that fact before proceeding.

## Black Box Specs

- For each black box module or subsystem, maintain a short mini spec that explains the box without requiring source review, under the centralized `specs/` tree (see File Pattern below).
- Examples include netcode, ECS loop, replication, input pipeline, prediction, reconciliation, and rendering bridge.
- Specs describe **architecture, not minutia**: current-state ins, outs, and medium-level logic — never a changelog. History lives in git.

### Altitude and Layering

- `specs/README.md` is the top-level index — every spec and ADR is linked from there.
- `specs/architecture/README.md` is the cross-cutting entry point: how the subsystems fit together, the per-tick sequence, and contracts that span more than one box (e.g. NET flags). Keep it high-level.
- Each component spec (`specs/<crate-or-package>/README.md`) sits one level lower. It fills in the details the architecture doc deliberately glosses over — the mechanics and non-obvious "why" specific to that box.
- **Do not repeat yourself across specs.** A contract is documented in exactly one spec and referenced by name elsewhere. If two specs describe the same thing, one of them is wrong.

### Decisions (`specs/decisions/`)

- Before making a nontrivial design call, check `specs/decisions/` — if the question was already settled, follow that decision (or explicitly revisit it in a new ADR) instead of re-deriving it from scratch.
- When you make a real architectural decision — especially one with a non-obvious rationale, a rejected alternative, or a real consequence someone could get bitten by later — record it as a new numbered ADR (`specs/decisions/00NN-slug.md`, `Status` / `Context` / `Decision` / `Consequences`, per `specs/decisions/README.md`'s log) and link it from that README.
- ADRs record decisions, not open questions — an unresolved design question or deferred idea belongs in a spec's own notes or the conversation, not a new ADR.

### Requirements

- Each black box must have a mini spec document.
- If code behavior, boundaries, assumptions, invariants, inputs or outputs, dependencies, or test coverage change, update the spec to reflect the new current state in the same pass.
- If a black box is modified and its spec is not updated, the task is incomplete.
- Prefer updating an existing spec over creating duplicate documentation.
- Keep specs short, concrete, and review-oriented.

### Mini Spec Contents

Include only the sections that carry real information for the box; omit the rest. Never add a running change log.

- Purpose: what the black box is responsible for.
- Boundaries: what it owns and what it must not do (when non-obvious).
- Inputs and Outputs: key data in and out.
- Key Logic: the medium-level mechanics and non-obvious "why" a reviewer needs.
- Invariants: rules that must remain true.
- Dependencies: other boxes, shared state, timing assumptions, and external services.
- Verification: tests, assertions, or manual checks relevant to the box.

### Workflow

- When changing a black box, edit its mini spec so it reads as if the new behavior were always the design — update the affected sections in place rather than appending notes about the change.
- If the requested change conflicts with the current spec, rewrite the spec to the new intended behavior.
- Surface black box contract changes explicitly in the final summary (the summary is where change history belongs, not the spec).

### File Pattern

- Specs live centrally under `specs/`, not next to the code — one directory per crate/package, named after it, containing a `README.md`. Cross-cutting docs (the architecture overview, ADRs) get their own top-level `specs/` subdirectory.

Examples:
- `crates/engine` -> `specs/engine/README.md`
- `packages/system-rendering` -> `specs/system-rendering/README.md`
- a cross-cutting decision -> `specs/decisions/00NN-slug.md`

### Spec Style

- Write for a reviewer, not an implementer.
- Use bullets and short sections.
- Describe behavior and constraints, not line-by-line implementation details.
- Avoid comments that merely restate the code.