import { CoreWorld } from "../core";

    export function timeSystem (world: CoreWorld) {
        const { time } = world;
        const now = performance.now();
        const delta = now - time.then;
        time.delta = delta;
        time.elapsed += delta;
        time.then = now;
        time.deltaBuffer.push(delta);
        time.avgDelta = time.deltaBuffer.average();
        time.ticksPerSecond = time.avgDelta ? 1000 / time.avgDelta : 0;
    }