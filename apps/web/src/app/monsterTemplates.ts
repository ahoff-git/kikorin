import type { MonsterCapabilityInput } from "@kikorin/adapter";

// Monster-type templates: agile (fast, can jump), slow (grounded, can't
// jump), flying (bypasses pathfinding entirely, chases in true 3D). These
// are plain TS presets, not an engine concept — the engine only exposes a
// generic per-monster capability override (set_monster_capability); naming
// specific "types" is the game's job, matching how AiConfig/MonsterConfig
// already work ("the engine ships no game data").
//
// walk_speed is scaled relative to the caller's own baseline rather than a
// fixed absolute number — kikorin's games run at very different scales
// (3D's default AiConfig walk_speed is 2.5; 2D's kikorin2d.ts configures
// 6.0), so one hardcoded speed wouldn't read as "agile" in both.
//
// jump_speed/max_jumps are deliberately NOT part of a template — see
// MonsterCapabilityInput's own doc comment (packages/adapter/src/types.ts)
// for why varying them per monster against one shared navmesh is unsafe.

export type MonsterTemplateName = "agile" | "slow" | "flying" | "ghost";

export type MonsterTemplate = {
  name: MonsterTemplateName;
  capability: MonsterCapabilityInput;
  /** Relative pick weight — see pickMonsterTemplate. */
  weight: number;
  bodyColor: number;
  frontColor: number;
};

// Per-type colors, shared so the sprite loadout (paperDollAssets builds a
// `body-monster-<name>` body from these) matches remote-mirror mesh styling —
// one source of truth, so agile always reads orange, ghost grey, etc.
export const MONSTER_TYPE_STYLE: Record<MonsterTemplateName, { body: number; front: number }> = {
  agile: { body: 0xffa000, front: 0xffe082 },
  slow: { body: 0x6d4c41, front: 0xa1887f },
  flying: { body: 0x8e24aa, front: 0xe1bee7 },
  ghost: { body: 0x90a4ae, front: 0xeceff1 },
};

export function createMonsterTemplates(baseWalkSpeed: number): MonsterTemplate[] {
  const style = (name: MonsterTemplateName) => ({
    bodyColor: MONSTER_TYPE_STYLE[name].body,
    frontColor: MONSTER_TYPE_STYLE[name].front,
  });
  return [
    {
      name: "agile",
      weight: 2,
      // Agile monsters sprint: Tier-4 discovered sprint-jump routes are
      // actually exercised in normal play (ADR 0011).
      capability: { walk_speed: baseWalkSpeed * 1.6, can_jump: true, can_sprint: true, can_phase: false, can_fly: false },
      ...style("agile"),
    },
    {
      name: "slow",
      weight: 2,
      capability: { walk_speed: baseWalkSpeed * 0.5, can_jump: false, can_sprint: false, can_phase: false, can_fly: false },
      ...style("slow"),
    },
    {
      name: "flying",
      weight: 1,
      capability: { walk_speed: baseWalkSpeed * 1.2, can_jump: true, can_sprint: false, can_phase: false, can_fly: true },
      ...style("flying"),
    },
    {
      name: "ghost",
      weight: 1,
      // Incorporeal: walks through walls (ADR 0013).
      capability: { walk_speed: baseWalkSpeed * 0.8, can_jump: false, can_sprint: false, can_phase: true, can_fly: false },
      ...style("ghost"),
    },
  ];
}

/** Weighted random pick — grounded types are more common than flying. */
export function pickMonsterTemplate(templates: readonly MonsterTemplate[]): MonsterTemplate {
  const total = templates.reduce((sum, t) => sum + t.weight, 0);
  let r = Math.random() * total;
  for (const t of templates) {
    if (r < t.weight) return t;
    r -= t.weight;
  }
  return templates[templates.length - 1];
}
