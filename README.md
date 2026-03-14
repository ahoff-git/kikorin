# kikorin

A small ECS + Three.js sandbox with a friendlier default API.

## Quick start

The easiest way to boot a world now is with named options:

```ts
import { setupCoreWorld, spawnEntity } from "@/packages/core/core";

const worldBox = setupCoreWorld({
  canvas,
  autoStart: true,
  maxEntities: 100000,
});

const player = spawnEntity(worldBox.world, {
  position: { x: 0, y: 8, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  gravity: true,
  collider: {
    halfWidth: 0.5,
    halfHeight: 0.5,
    halfDepth: 0.5,
  },
  renderMesh: createPlayerMesh,
  health: 100,
  player: {
    name: "Pilot",
    level: 1,
    experience: 0,
  },
});

worldBox.setCameraFollowTarget(player);
```

## Ergonomic helpers

- `setupCoreWorld({ canvas, autoStart, maxEntities, worldTickRate })`
- `spawnEntity(world, blueprint)` or `worldBox.spawnEntity(blueprint)`
- `queryEntities(world, ["Floor", "Position", "Rotation", "Collider"])`
- `hasEntityComponents(world, eid, ["Player", "Velocity"])`
- `setEntityPosition`, `setEntityVelocity`, `setEntityRotation`

## What changed in this usability pass

- World setup supports a named-options path instead of only positional args.
- Each world now owns its own scheduler, so start/stop/dispose is less surprising.
- Common entity setup no longer requires direct `bitecs` calls or manual render/collider wiring.
- The demo world uses the higher-level engine API, so the example matches the easiest path.
