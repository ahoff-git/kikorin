//! Pure 8-way animation state machine: given a set of animation families (with
//! per-frame timing ranges, transitions, interruptibility, and hit/hurtboxes)
//! and a stream of action requests + `dt`, it decides which family/frame/
//! direction an entity shows. No ECS, no engine, no rendering — the engine owns
//! per-entity `AnimationInstance`s and feeds this crate; the boundary ships the
//! resolved cell to TypeScript, which only draws it.
//!
//! Split of responsibilities with the TS `@kikorin/paperdoll` package: the *art*
//! (sheets, cell size, layer order) stays in TS; the *animation definition*
//! (timings, flags, transitions, boxes) lives here as data the game loads into
//! the engine, the sprite analog of `load_map(blocks)`.

mod direction;
mod instance;
mod schedule;

pub use direction::{direction_from_yaw, direction_from_yaw_relative, DIRECTION_COUNT};
pub use instance::AnimationInstance;
pub use schedule::{schedule_frames, FrameSlot, Schedule};

use std::collections::HashMap;

/// An axis-aligned box, same convention as `ecs::ColliderConfig` /
/// `spawn_box_entity` (a center offset from the entity origin + half-extents) so
/// combat can reuse the engine's existing cube machinery. Its meaning (hit vs.
/// hurt) is by field on `FrameSpec`; combat consumption is the engine's job (a
/// later phase) — this crate only carries the geometry. Richer per-box behavior
/// (damage, knockback, tags) hangs off that consumption, not this shape. See
/// ADR 0016.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HitBox {
    /// Box center relative to the entity origin, pre-direction-rotation.
    pub offset: [f32; 3],
    pub half_extents: [f32; 3],
}

/// One frame of a family. `optimal_ms` is the natural display time; `min_ms`/
/// `max_ms` bound how far time-fitting may shrink/stretch it (default them equal
/// to `optimal_ms` for a rigid frame). `skippable` frames may be dropped when
/// cutting short; `cancelable` opens an interrupt window even under Block/Queue.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameSpec {
    pub optimal_ms: f32,
    pub min_ms: f32,
    pub max_ms: f32,
    pub skippable: bool,
    pub cancelable: bool,
    pub hitbox: Option<HitBox>,
    pub hurtbox: Option<HitBox>,
}

impl FrameSpec {
    /// A rigid frame: plays exactly `ms`, never shrinks/stretches/skips/cancels.
    pub fn fixed(ms: f32) -> Self {
        Self {
            optimal_ms: ms,
            min_ms: ms,
            max_ms: ms,
            skippable: false,
            cancelable: false,
            hitbox: None,
            hurtbox: None,
        }
    }
}

/// How a playing family reacts to a new action request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interrupt {
    /// Interruptible at any time (locomotion: idle/walk).
    Always,
    /// Cannot be interrupted until it ends (except during a `cancelable` frame).
    Block,
    /// Cannot interrupt now, but the request is remembered and starts when this
    /// family ends (smooths queued player input).
    Queue,
}

/// One named animation. `next` flows to another family when a one-shot ends;
/// `hold_last` freezes the final frame (death) instead of transitioning.
/// `branch_frame` is the split point at which a queued action takes over under
/// an `Interrupt::Queue` policy (None = wait until the family ends). See ADR 0016.
#[derive(Clone, Debug)]
pub struct Family {
    pub frames: Vec<FrameSpec>,
    pub looping: bool,
    pub next: Option<usize>,
    pub hold_last: bool,
    pub interrupt: Interrupt,
    pub branch_frame: Option<usize>,
}

const WILDCARD: u16 = u16::MAX;

/// A loaded animation set: the families plus the map from engine action kinds
/// (and optional variants) to family indices. Family 0 is idle by convention and
/// is the terminal fallback, so a resolve never fails.
#[derive(Clone, Debug, Default)]
pub struct AnimationSet {
    pub families: Vec<Family>,
    action_map: HashMap<(u16, u16), usize>,
}

impl AnimationSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a family, returning its index.
    pub fn push_family(&mut self, family: Family) -> usize {
        self.families.push(family);
        self.families.len() - 1
    }

    /// Map an action to a family. `variant = None` is the wildcard for that kind.
    pub fn map_action(&mut self, kind: u16, variant: Option<u16>, family: usize) {
        self.action_map.insert((kind, variant.unwrap_or(WILDCARD)), family);
    }

    /// Resolve an action to a family index: exact `(kind, variant)` first, then
    /// the kind's wildcard, then family 0 (idle).
    pub fn family_for_action(&self, kind: u16, variant: Option<u16>) -> usize {
        if let Some(v) = variant {
            if let Some(&f) = self.action_map.get(&(kind, v)) {
                return f;
            }
        }
        if let Some(&f) = self.action_map.get(&(kind, WILDCARD)) {
            return f;
        }
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_resolves_variant_then_wildcard_then_idle() {
        let mut s = AnimationSet::new();
        for _ in 0..4 {
            s.push_family(Family {
                frames: vec![FrameSpec::fixed(100.0)],
                looping: true,
                next: None,
                hold_last: false,
                interrupt: Interrupt::Always,
                branch_frame: None,
            });
        }
        s.map_action(0, None, 0); // idle
        s.map_action(1, None, 1); // walk
        s.map_action(2, Some(0), 2); // attack.slash
        s.map_action(2, None, 3); // attack fallback

        assert_eq!(s.family_for_action(1, None), 1);
        assert_eq!(s.family_for_action(2, Some(0)), 2); // exact variant
        assert_eq!(s.family_for_action(2, Some(9)), 3); // unknown variant → kind wildcard
        assert_eq!(s.family_for_action(7, None), 0); // unmapped → idle
    }
}
