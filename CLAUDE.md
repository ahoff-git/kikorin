# Project rules

- Prefer changes that keep the code easy to modify.
- Code reuse is ideal.
- Avoid duplicating knowledge or intent.
- Choose readable, obvious solutions over clever ones.
- Log debugging messages using the method defined in logging.ts, they should be disabled by default but easily enabled. 
- Give each function, component, and module one clear job.
- Prefer composition and factory functions over inheritance-heavy designs.
- Create helper functions when they improve readability, isolate logic, or reduce noise in the main flow. 
- Reuse proven solutions before inventing new ones.
- Use comments for why, tradeoffs, and context; use names for what.
- In React, compute before return; keep JSX declarative.
- Use objects when they clarify ownership or lifecycle; otherwise prefer plain functions.
- Keep exported APIs stable unless a change is explicitly requested.
- Reuse existing utilities and patterns when possible.
- Stop and ask before adding dependencies, or changing unrelated files.
