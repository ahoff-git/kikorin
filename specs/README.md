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
- [Paper-doll — 8-way layered sprite animation](./paperdoll/README.md) — resolver pipeline + baked-strip cache; v1 wired into the top-down game (see ADR 0014).
- [Util — logging contract](./util/README.md)

## App-level modules (apps/web)

- [Chat framework](./chat/README.md) — multi-channel chat riding the game's own netcode room.

## Process

- [Decisions](./decisions/README.md) — architecture decision records (ADRs). Check here before re-deriving a design question that's already been settled.
