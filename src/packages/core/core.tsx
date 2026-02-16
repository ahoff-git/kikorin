import {
    createWorld,
    query,
    addEntity,
    removeEntity,
    addComponent
} from 'bitecs'
import { createRingBuffer, RingBuffer } from '../util/ringBuffer'
import { eventBus } from './mitt'
import { createChillUpdater } from '../util/chillUpdate'
import { rng } from '../util/random'

export type CoreWorldBox = ReturnType<typeof setupCoreWorld>
export type Positions = {
    x: Int32Array,
    y: Int32Array,
    z: Int32Array
}
export type Position = {
    x: number,
    y: number,
    z: number
}
export type Velocities = {
    x: Float32Array,
    y: Float32Array,
    z: Float32Array
}
export type Velocity = {
    x: number,
    y: number,
    z: number
}
export type Players = Player[];
export type Player = {
    level: number;
    experience: number;
    name: string;
}
export type Time = {
        delta: number,
        elapsed: number,
        then: number,
        deltaBuffer: RingBuffer,
        avgDelta: number,
        ticksPerSecond: number
    }
export type CoreWorld = {
    components: {
        Position: Positions
        Velocity: Velocities
        Health: Int32Array
        Player: Players
    }
    time: Time
}



function setupCoreWorld(MAX_ENTITIES = 100000) {

    const chillUpdater = createChillUpdater<any>();
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

    for (let i = 0; i < 1000; i++){
        createPerson({x:rng(0,500),y:rng(0,500),z:rng(0,500)},{x:rng(0,5),y:rng(0,5),z:rng(0,5)}, 100, {level: 0, experience:0, name: `Doom${i}`});
    }

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
        const { Health } = world.components
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
        chillUpdater.setUpdate({
            updateKey: "ticksPerSecond",
            updateFunction: sendTimeUpdate,
            value: time,
            minMS: 100
        });
        chillUpdater.setUpdate({
            updateKey: "playerUpdate",
            updateFunction: sendPlayerUpdate,
            value: { ...components.Player[1] },
            minMS: 100
        });
        // chillUpdater.setUpdate({
        //     updateKey: "exposeWorld",
        //     updateFunction: exposeWorld,
        //     value: null,
        //     minMS: 15000
        // })
        chillUpdater.check();
    }

    function exposeWorld(){
        console.log(world);
    }

    function sendTimeUpdate(value: CoreWorld["time"]) {
        eventBus.emit("ui:timeMetricsUpdate", { time: value });
    }

    function sendPlayerUpdate(value: CoreWorld["components"]["Player"][number]) {
        eventBus.emit("ui:playerUpdate", { Player: value });
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

    function createPerson(position: Position, velocity:Velocity, health:number, player:Player) {
        const { Position, Velocity, Player, Health } = world.components

        const eid = addEntity(world)
        addComponent(world, eid, Position)
        addComponent(world, eid, Velocity)
        addComponent(world, eid, Player)
        addComponent(world, eid, Health)

        // SoA access pattern
        Position.x[eid] = position.x;
        Position.y[eid] = position.y;
        Position.z[eid] = position.z;
        Velocity.x[eid] = velocity.x;
        Velocity.y[eid] = velocity.y;
        Velocity.z[eid] = velocity.z;
        Health[eid] = health;

        // AoS access pattern  
        Player[eid] = player;
    }

    return { world, start, stop };

}

export { setupCoreWorld };
