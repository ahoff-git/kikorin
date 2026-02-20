import type {
    CoreCommand,
    CoreCommandHandler,
    CoreCommandInput,
    CoreCommands,
    CoreWorld
} from '../types'

export function createCoreCommands<TWorld>(): CoreCommands<TWorld> {
    const queue: CoreCommand[] = [];
    const handlers = new Map<string, CoreCommandHandler<TWorld>[]>();
    let sequence = 0;

    function enqueue(command: CoreCommandInput) {
        const timestamp = command.timestamp ?? performance.now();
        const nextCommand: CoreCommand = {
            sequence,
            timestamp,
            source: command.source,
            type: command.type,
            payload: command.payload
        };
        sequence += 1;

        const queueLength = queue.length;
        if (queueLength === 0 || queue[queueLength - 1]!.timestamp <= timestamp) {
            queue.push(nextCommand);
            return nextCommand.sequence;
        }

        let low = 0;
        let high = queueLength;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (queue[mid]!.timestamp <= timestamp) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        queue.splice(low, 0, nextCommand);
        return nextCommand.sequence;
    }

    function on(type: string, handler: CoreCommandHandler<TWorld>) {
        const list = handlers.get(type);
        if (list) {
            list.push(handler);
        } else {
            handlers.set(type, [handler]);
        }

        return () => {
            const current = handlers.get(type);
            if (!current) return;
            const index = current.indexOf(handler);
            if (index < 0) return;
            current.splice(index, 1);
            if (current.length === 0) {
                handlers.delete(type);
            }
        };
    }

    function process(world: TWorld) {
        const queueLength = queue.length;
        if (queueLength === 0) return;

        const anyHandlers = handlers.get('*');
        for (let i = 0; i < queueLength; i += 1) {
            const command = queue[i]!;
            const typeHandlers = handlers.get(command.type);
            if (typeHandlers) {
                for (let j = 0; j < typeHandlers.length; j += 1) {
                    typeHandlers[j]!(world, command);
                }
            }

            const sourceHandlers = handlers.get(`source:${command.source}`);
            if (sourceHandlers) {
                for (let j = 0; j < sourceHandlers.length; j += 1) {
                    sourceHandlers[j]!(world, command);
                }
            }

            if (anyHandlers) {
                for (let j = 0; j < anyHandlers.length; j += 1) {
                    anyHandlers[j]!(world, command);
                }
            }
        }

        queue.length = 0;
    }

    function clear() {
        queue.length = 0;
    }

    return { queue, handlers, enqueue, on, process, clear };
}

export function commandsSystem(world: CoreWorld) {
    world.commands.process(world);
}
