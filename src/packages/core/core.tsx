import {
    createWorld,
    query,
    addEntity,
    removeEntity,
    addComponent
} from 'bitecs'
import { createRingBuffer, RingBuffer } from '../util/ringBuffer'
import { createThrottledUpdater } from '../util/throttledUpdate'
import { eventBus } from './mitt'

export type CoreWorldBox = ReturnType<typeof setupCoreWorld>

export type CoreWorld = {
    components: {
        Position: {
            x: Int32Array,
            y: Int32Array,
            z: Int32Array
        }
        Velocity: {
            x: Float32Array,
            y: Float32Array,
            z: Float32Array
        }
        Health: Int32Array
        Player: { level: number; experience: number; name: string; }[]
    }
    time: {
        delta: number,
        elapsed: number,
        then: number,
        deltaBuffer: RingBuffer,
        avgDelta: number,
        ticksPerSecond: number
    }
}

function setupCoreWorld(MAX_ENTITIES = 100000) {

    const throttledUpdater = createThrottledUpdater();
    console.log("throttled")
    let runGameLoop = false;
    const world: CoreWorld = createWorld({
        components: {
            // They can be any shape you want
            // SoA:
            Position: {
                x: new Int32Array(MAX_ENTITIES),
                y: new Int32Array(MAX_ENTITIES),
                z: new Int32Array(MAX_ENTITIES)
            },
            Velocity: {
                x: new Float32Array(1e5),
                y: new Float32Array(1e5),
                z: new Float32Array(1e5)
            },
            Health: new Int32Array,
            // AoS:
            Player: [] as { level: number; experience: number; name: string }[]
        },
        time: {
            delta: 0,
            elapsed: 0,
            then: performance.now(),
            deltaBuffer: createRingBuffer(300),
            avgDelta: 0,
            ticksPerSecond: 0
        }
    }) as CoreWorld;

    const { Position, Velocity, Player, Health } = world.components

    const eid = addEntity(world)
    addComponent(world, eid, Position)
    addComponent(world, eid, Velocity)
    addComponent(world, eid, Player)
    addComponent(world, eid, Health)

    // SoA access pattern
    Position.x[eid] = 0;
    Position.y[eid] = 0;
    Position.z[eid] = 0;
    Velocity.x[eid] = 1.23;
    Velocity.y[eid] = 1.23;
    Health[eid] = 100;

    // AoS access pattern  
    Player[eid] = { level: 1, experience: 0, name: "Hero" }

    const movementSystem = (world: CoreWorld) => {
        const { Position, Velocity } = world.components

        for (const eid of query(world, [Position, Velocity])) {
            Position.x[eid] += Velocity.x[eid] * world.time.delta
            Position.y[eid] += Velocity.y[eid] * world.time.delta
        }
    }

    const experienceSystem = (world: CoreWorld) => {
        const { Player } = world.components

        for (const eid of query(world, [Player])) {
            Player[eid].experience += world.time.delta / 1000
            if (Player[eid].experience >= 100) {
                Player[eid].level++
                Player[eid].experience = 0
            }
        }
    }

    const healthSystem = (world: CoreWorld) => {
        for (const eid of query(world, [Health])) {
            if (Health[eid] <= 0) {
                removeEntity(world, eid)
                //todo make sure we ask three and rapier to clean up their entities too
            }
        }
    }

    const timeSystem = (world: CoreWorld) => {
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

    const uiBridge = (world: CoreWorld) => {
        const { time, components } = world;
        throttledUpdater("ticksPerSecond", sendTimeUpdate, time, {minMS:50000})
        throttledUpdater("playerUpdate", sendPlayerUpdate, {...components.Player[1]})
    }

    function sendTimeUpdate(value: CoreWorld["time"]) {
        eventBus.emit("ui:timeMetricsUpdate", { time: value });
        console.log("Send Time Update", value)
    }

    function sendPlayerUpdate(value: CoreWorld["components"]["Player"][number]) {
        eventBus.emit("ui:playerUpdate", { Player: value });
        console.log("Send Player Update", value)
    }

    const update = (world: CoreWorld) => {
        timeSystem(world)
        movementSystem(world)
        experienceSystem(world)
        healthSystem(world)
        uiBridge(world)
    }

    function start() {
        runGameLoop = true;
        requestAnimationFrame(function gameLoop() {
            update(world);
            if (runGameLoop) {
                requestAnimationFrame(gameLoop);
            }
        })
    }

    function stop() {
        runGameLoop = false;
    }

    return { world, start, stop };

}

export { setupCoreWorld };
