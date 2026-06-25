import type { CoreWorld } from "@kikorin/ecs"
import { markFlaginatorComponentChanged } from "@kikorin/system-flaginator"

export function awardXP(world: CoreWorld, eid: number, amount: number) {
    const player = world.components.Player[eid]
    if (!player) return
    player.experience += amount
    if (player.experience >= 100) {
        player.level++
        player.experience = 0
    }
    markFlaginatorComponentChanged(world, "Player", eid)
}

// Kept for engine system registration; passive XP is no longer awarded.
export function experienceSystem(_world: CoreWorld) {}
