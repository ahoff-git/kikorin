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

- For each black box module or subsystem, maintain a short colocated mini spec that explains the box without requiring source review.
- Examples include netcode, ECS loop, replication, input pipeline, prediction, reconciliation, and rendering bridge.

### Requirements

- Each black box must have a mini spec document.
- If code behavior, boundaries, assumptions, invariants, inputs or outputs, dependencies, or test coverage change, update the spec in the same pass.
- If a black box is modified and its spec is not updated, the task is incomplete.
- Prefer updating an existing spec over creating duplicate documentation.
- Keep specs short, concrete, and review-oriented.

### Mini Spec Contents

Each mini spec should include:

- Purpose: what the black box is responsible for.
- Boundaries: what it owns and what it must not do.
- Inputs and Outputs: key data in and out.
- Invariants: rules that must remain true.
- Dependencies: other boxes, shared state, timing assumptions, and external services.
- Change Notes: what changed in this pass and why.
- Verification: tests, assertions, or manual checks relevant to the box.

### Workflow

- When changing a black box, update its mini spec in the same pass.
- If the requested change conflicts with the current spec, update the spec to reflect the new intended behavior and call out the contract change clearly.
- Surface black box contract changes explicitly in the final summary.

### File Pattern

- Co-locate specs near the code.

Examples:
- `NetDriver.ts` -> `NetDriver.spec.md`
- `ecs/updateLoop.ts` -> `ecs/updateLoop.spec.md`

### Spec Style

- Write for a reviewer, not an implementer.
- Use bullets and short sections.
- Describe behavior and constraints, not line-by-line implementation details.
- Avoid comments that merely restate the code.