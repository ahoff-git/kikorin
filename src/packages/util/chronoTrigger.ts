// ChronoTrigger Library (CT) using Factory Functions with FPS Tracking
import { log, logLevels } from './logging';
import { createRingBuffer } from './ringBuffer';

interface ScheduledTask {
    id: number;
    callback: (deltaMs: number) => void;
    callbackName: string;
    intervalMs: number;
    accumulatorMs: number;
    lastCatchupWarningMs: number;
    maxTicksPerFrame: number;
}

export interface ChronoTrigger {
    Start: () => void;
    Stop: () => void;
    runAt: (options: {
        name?: string;
        callback: (deltaMs: number) => void;
        fpsTarget?: number;
        maxTicksPerFrame?: number;
    }) => number;
    dispose: (id: number) => boolean;
    CurrentFPS: () => number;
    AverageFPS: () => number;
}

function runScheduledTask(
    task: ScheduledTask,
    deltaMs: number,
): void {
    try {
        task.callback(deltaMs);
    }
    catch (error) {
        log(
            logLevels.error,
            `${task.callbackName} failed during chronoTrigger execution.`,
            ["chronoTrigger"],
            error,
        );
    }
}

export function createChronoTrigger(): ChronoTrigger {
    const scheduledTasks: ScheduledTask[] = [];
    const taskIndexById = new Map<number, number>();
    let nextTaskId = 1;
    const defaultMaxTicksPerFrame = 5;
    let running = false;
    let rafId = 0;
    let fps = 0; // Tracks the current running FPS
    const fpsHist = createRingBuffer(100);
    let lastFrameTime = 0;

    const Start = (): void => {
        if (running) return;
        running = true;
        const frame = (time: number): void => {
            if (!running) return;

            let delta = 0;
            if (lastFrameTime > 0) {
                delta = time - lastFrameTime;
                if (delta > 0) {
                    // using Math.max to avoid divide by 0
                    const newFps = Math.round(1000 / Math.max(delta, 1));
                    fps = newFps !== 1000 ? newFps : fps;
                    fpsHist.push(fps);
                }
            }
            lastFrameTime = time;

            for (let i = 0; i < scheduledTasks.length; i++) {
                const task = scheduledTasks[i];
                if (task.intervalMs <= 0) {
                    runScheduledTask(task, delta);
                    continue;
                }

                task.accumulatorMs += delta;
                if (task.accumulatorMs > task.intervalMs * task.maxTicksPerFrame) {
                    task.accumulatorMs = task.intervalMs * task.maxTicksPerFrame;
                }

                const ticks = (task.accumulatorMs / task.intervalMs) | 0;
                if (ticks <= 0) continue;

                task.accumulatorMs -= ticks * task.intervalMs;
                for (let t = 0; t < ticks; t++) {
                    runScheduledTask(task, task.intervalMs);
                }
            }

            rafId = requestAnimationFrame(frame);
        };
        rafId = requestAnimationFrame(frame);
    };

    const Stop = (): void => {
        running = false;
        lastFrameTime = 0;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
    };

    const dispose = (id: number): boolean => {
        const index = taskIndexById.get(id);
        if (index === undefined) return false;

        const lastIndex = scheduledTasks.length - 1;
        if (index !== lastIndex) {
            const lastTask = scheduledTasks[lastIndex];
            scheduledTasks[index] = lastTask;
            taskIndexById.set(lastTask.id, index);
        }

        scheduledTasks.pop();
        taskIndexById.delete(id);
        return true;
    };

    const runAt = ({
        name,
        fpsTarget,
        callback,
        maxTicksPerFrame,
    }: {
        name?: string;
        callback: (deltaMs: number) => void;
        fpsTarget?: number;
        maxTicksPerFrame?: number;
    }): number => {
        if (typeof callback !== "function") {
            throw new Error("runAt requires a callback function.");
        }

        let intervalMs = 0;
        if (fpsTarget !== undefined) {
            if (!Number.isFinite(fpsTarget) || fpsTarget <= 0) {
                throw new Error("fpsTarget must be a positive number when provided.");
            }

            intervalMs = 1000 / fpsTarget;
        }

        const safeMaxTicksPerFrame = maxTicksPerFrame === undefined
            ? defaultMaxTicksPerFrame
            : Math.max(1, Math.floor(maxTicksPerFrame));

        const id = nextTaskId++;
        const callbackName = name || callback.name || "anonymous";
        const accumulatorMs = intervalMs > 0 ? intervalMs : 0;
        scheduledTasks.push({
            id,
            callback,
            callbackName,
            intervalMs,
            accumulatorMs,
            lastCatchupWarningMs: -Infinity,
            maxTicksPerFrame: safeMaxTicksPerFrame,
        });
        taskIndexById.set(id, scheduledTasks.length - 1);
        return id;
    };

    const CurrentFPS = (): number => fps;
    const AverageFPS = (): number => Math.round(fpsHist.average());

    return { Start, Stop, runAt, dispose, CurrentFPS, AverageFPS };
}

export const Crono = createChronoTrigger();
