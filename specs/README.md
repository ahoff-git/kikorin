# Kikorin Specs

Lightweight wiki-style specs for the kikorin project. Start here and branch out by area.

## Architecture

- [Architecture](./architecture/README.md) — the big picture: ownership split, crate layering, per-tick data flow, cross-cutting contracts, constraints, verification.

## Rust crates

- [Engine orchestrator (WASM entry point)](./engine/README.md)
- [ECS world](./ecs/README.md)
- [Physics world (Rapier2D/Rapier3D)](./physics/README.md)
- [Pathfinding (NavMesh A*)](./pathfinding/README.md)
- [Netcode delta tracker & peer session](./netcode/README.md)
- [Patch bundle generation](./patch/README.md)

## TypeScript packages

- [Adapter — boundary types, constants & channel fan-out](./adapter/README.md)
- [System-rendering — Three.js render bridge](./system-rendering/README.md)
- [Util — logging contract](./util/README.md)

## Process

- [Decisions](./decisions/README.md) — architecture decision records (ADRs). Check here before re-deriving a design question that's already been settled.
