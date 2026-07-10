use bitflags::bitflags;

pub type EntityId = u32;

// --- Entity networking profile flags (the `net_flags` bitmask) ---
// Composable dimensions, not one enum: an entity's networking behavior is the
// combination of its ownership, authority, type, predictability, and urgency.
// TS mirrors these in @kikorin/adapter; the values are cross-boundary contract.

/// Ownership: simulated on this client (physics body, HEALTH semantics).
pub const NET_LOCAL: u8 = 0x01;
/// Type: ballistic projectile — the engine integrates its trajectory.
pub const NET_BULLET: u8 = 0x02;
/// Type: monster — the engine owns its AI, separation, and hit detection.
pub const NET_MONSTER: u8 = 0x04;
/// Authority: this client broadcasts the entity's state to peers.
pub const NET_REPLICATED: u8 = 0x08;
/// Predictability: motion follows from velocity, so receivers extrapolate and
/// the sender only ships periodic corrections plus discontinuities.
pub const NET_PREDICTABLE: u8 = 0x10;
/// Urgency: background actor — replicate on a slow stride, not every tick.
pub const NET_LOW_URGENCY: u8 = 0x20;

/// The flag dimensions that cross the wire when an entity spawns remotely:
/// type + predictability (receivers style and extrapolate mirrors from them).
/// Ownership/authority/urgency are sender-local and never transmitted.
pub const NET_PUBLIC_MASK: u8 = NET_BULLET | NET_MONSTER | NET_PREDICTABLE;

bitflags! {
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct DirtyFlags: u8 {
        const TRANSFORM = 0b0001;
        const HEALTH    = 0b0100;
        const NET       = 0b1000;
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ColliderConfig {
    pub active: bool,
    pub sensor: bool,
    pub half_width: f32,
    pub half_height: f32,
    pub half_depth: f32,
}

/// Below this, per-column Vec reallocations during early growth cost more than
/// the memory saved; capacities are rounded up.
const MIN_CAPACITY: usize = 256;

/// Column-based (SoA) entity-component storage.
/// Each component is a Vec<Option<T>> indexed by EntityId.
///
/// Adding a component column requires updating `new`, `grow_to`, and
/// `destroy_entity` together — a missed `destroy_entity` clear leaks stale data
/// into recycled entity IDs. `destroy_clears_every_component_column` and
/// `grow_to_expands_all_columns` fail if a column is missed.
pub struct World {
    next_id: u32,
    free_list: Vec<u32>,
    alive: Vec<bool>,

    // components
    position: Vec<Option<[f32; 3]>>,
    velocity: Vec<Option<[f32; 3]>>,
    rotation: Vec<Option<[f32; 3]>>,
    health: Vec<Option<i32>>,
    net_flags: Vec<Option<u8>>,
    collider: Vec<Option<ColliderConfig>>,
    grounded: Vec<Option<bool>>,
    is_floor: Vec<bool>,

    // dirty-flag tracking; cleared after patch generation each tick
    dirty: Vec<DirtyFlags>,
    dirty_list: Vec<EntityId>,

    tick: u64,
}

impl World {
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(MIN_CAPACITY);
        Self {
            next_id: 0,
            free_list: Vec::new(),
            alive: vec![false; cap],
            position: vec![None; cap],
            velocity: vec![None; cap],
            rotation: vec![None; cap],
            health: vec![None; cap],
            net_flags: vec![None; cap],
            collider: vec![None; cap],
            grounded: vec![None; cap],
            is_floor: vec![false; cap],
            dirty: vec![DirtyFlags::empty(); cap],
            dirty_list: Vec::new(),
            tick: 0,
        }
    }

    fn grow_to(&mut self, id: u32) {
        let needed = id as usize + 1;
        if needed > self.alive.len() {
            let new_cap = needed.next_power_of_two();
            self.alive.resize(new_cap, false);
            self.position.resize(new_cap, None);
            self.velocity.resize(new_cap, None);
            self.rotation.resize(new_cap, None);
            self.health.resize(new_cap, None);
            self.net_flags.resize(new_cap, None);
            self.collider.resize(new_cap, None);
            self.grounded.resize(new_cap, None);
            self.is_floor.resize(new_cap, false);
            self.dirty.resize(new_cap, DirtyFlags::empty());
        }
    }

    pub fn create_entity(&mut self) -> EntityId {
        let id = self.free_list.pop().unwrap_or_else(|| {
            let id = self.next_id;
            self.next_id += 1;
            id
        });
        self.grow_to(id);
        self.alive[id as usize] = true;
        id
    }

    pub fn destroy_entity(&mut self, id: EntityId) {
        let i = id as usize;
        if i >= self.alive.len() || !self.alive[i] {
            return;
        }
        self.alive[i] = false;
        self.position[i] = None;
        self.velocity[i] = None;
        self.rotation[i] = None;
        self.health[i] = None;
        self.net_flags[i] = None;
        self.collider[i] = None;
        self.grounded[i] = None;
        self.is_floor[i] = false;
        self.dirty[i] = DirtyFlags::empty();
        // A destroyed-while-dirty entity must also leave dirty_list: a recycled ID
        // re-marked in the same tick would otherwise appear twice and emit
        // duplicate patches.
        self.dirty_list.retain(|&e| e != id);
        self.free_list.push(id);
    }

    pub fn entities(&self) -> impl Iterator<Item = EntityId> + '_ {
        (0..self.next_id).filter(|&id| self.alive.get(id as usize).copied().unwrap_or(false))
    }

    pub fn tick_count(&self) -> u64 {
        self.tick
    }

    pub fn advance_tick(&mut self) {
        self.tick += 1;
    }

    // --- position ---
    pub fn position(&self, id: EntityId) -> Option<[f32; 3]> {
        self.position.get(id as usize).copied().flatten()
    }
    pub fn set_position(&mut self, id: EntityId, xyz: [f32; 3]) {
        self.grow_to(id);
        self.position[id as usize] = Some(xyz);
    }

    // --- velocity ---
    pub fn velocity(&self, id: EntityId) -> Option<[f32; 3]> {
        self.velocity.get(id as usize).copied().flatten()
    }
    pub fn set_velocity(&mut self, id: EntityId, xyz: [f32; 3]) {
        self.grow_to(id);
        self.velocity[id as usize] = Some(xyz);
    }

    // --- rotation [yaw, pitch, roll] ---
    pub fn rotation(&self, id: EntityId) -> Option<[f32; 3]> {
        self.rotation.get(id as usize).copied().flatten()
    }
    pub fn set_rotation(&mut self, id: EntityId, ypr: [f32; 3]) {
        self.grow_to(id);
        self.rotation[id as usize] = Some(ypr);
    }

    // --- health ---
    pub fn health(&self, id: EntityId) -> Option<i32> {
        self.health.get(id as usize).copied().flatten()
    }
    pub fn set_health(&mut self, id: EntityId, hp: i32) {
        self.grow_to(id);
        self.health[id as usize] = Some(hp);
    }

    // --- net_flags ---
    pub fn net_flags(&self, id: EntityId) -> Option<u8> {
        self.net_flags.get(id as usize).copied().flatten()
    }
    pub fn set_net_flags(&mut self, id: EntityId, flags: u8) {
        self.grow_to(id);
        self.net_flags[id as usize] = Some(flags);
    }

    // --- collider ---
    pub fn collider(&self, id: EntityId) -> Option<ColliderConfig> {
        self.collider.get(id as usize).copied().flatten()
    }
    pub fn set_collider(&mut self, id: EntityId, cfg: ColliderConfig) {
        self.grow_to(id);
        self.collider[id as usize] = Some(cfg);
    }

    // --- grounded ---
    pub fn is_grounded(&self, id: EntityId) -> Option<bool> {
        self.grounded.get(id as usize).copied().flatten()
    }
    pub fn set_grounded(&mut self, id: EntityId, grounded: bool) {
        self.grow_to(id);
        self.grounded[id as usize] = Some(grounded);
    }

    // --- floor ---
    pub fn is_floor(&self, id: EntityId) -> bool {
        self.is_floor.get(id as usize).copied().unwrap_or(false)
    }
    pub fn set_floor(&mut self, id: EntityId, floor: bool) {
        self.grow_to(id);
        self.is_floor[id as usize] = floor;
    }

    // --- dirty flags ---
    pub fn mark_dirty(&mut self, id: EntityId, flags: DirtyFlags) {
        // Grows like the setters do — silently dropping an out-of-range mark
        // would suppress the entity's patches.
        self.grow_to(id);
        let i = id as usize;
        if self.dirty[i].is_empty() {
            self.dirty_list.push(id);
        }
        self.dirty[i] |= flags;
    }

    pub fn dirty_flags(&self, id: EntityId) -> DirtyFlags {
        self.dirty.get(id as usize).copied().unwrap_or_default()
    }

    pub fn dirty_entities(&self) -> impl Iterator<Item = EntityId> + '_ {
        self.dirty_list.iter().copied()
    }

    /// Clear all dirty flags. Call after PatchBundle has been generated.
    pub fn clear_dirty(&mut self) {
        for &id in &self.dirty_list {
            let i = id as usize;
            if i < self.dirty.len() {
                self.dirty[i] = DirtyFlags::empty();
            }
        }
        self.dirty_list.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_destroy_roundtrip() {
        let mut w = World::new(16);
        let e = w.create_entity();
        w.set_position(e, [1.0, 2.0, 3.0]);
        assert_eq!(w.position(e), Some([1.0, 2.0, 3.0]));
        w.destroy_entity(e);
        assert_eq!(w.position(e), None);
        // ID recycled
        let e2 = w.create_entity();
        assert_eq!(e2, e);
    }

    #[test]
    fn dirty_flag_lifecycle() {
        let mut w = World::new(16);
        let e = w.create_entity();
        assert!(w.dirty_flags(e).is_empty());

        w.mark_dirty(e, DirtyFlags::TRANSFORM);
        assert!(w.dirty_flags(e).contains(DirtyFlags::TRANSFORM));
        assert_eq!(w.dirty_entities().count(), 1);

        w.clear_dirty();
        assert!(w.dirty_flags(e).is_empty());
        assert_eq!(w.dirty_entities().count(), 0);
    }

    #[test]
    fn destroy_is_idempotent_and_never_double_recycles() {
        let mut w = World::new(16);
        let e = w.create_entity();
        w.destroy_entity(e);
        w.destroy_entity(e); // second destroy must be a no-op

        // A double free_list push would hand the same ID out twice.
        let a = w.create_entity();
        let b = w.create_entity();
        assert_ne!(a, b, "double destroy must not recycle the same ID twice");
    }

    #[test]
    fn destroy_clears_every_component_column() {
        // Guards the add-a-component checklist: a column missed in
        // destroy_entity leaks stale data into the recycled ID and fails here.
        let mut w = World::new(16);
        let e = w.create_entity();
        w.set_position(e, [1.0, 1.0, 1.0]);
        w.set_velocity(e, [1.0, 0.0, 0.0]);
        w.set_rotation(e, [0.1, 0.2, 0.3]);
        w.set_health(e, 50);
        w.set_net_flags(e, 0x05);
        w.set_collider(e, ColliderConfig { active: true, ..Default::default() });
        w.set_grounded(e, true);
        w.set_floor(e, true);
        w.mark_dirty(e, DirtyFlags::TRANSFORM);

        w.destroy_entity(e);
        let e2 = w.create_entity();
        assert_eq!(e2, e, "test assumes ID recycling");

        assert_eq!(w.position(e2), None);
        assert_eq!(w.velocity(e2), None);
        assert_eq!(w.rotation(e2), None);
        assert_eq!(w.health(e2), None);
        assert_eq!(w.net_flags(e2), None);
        assert!(w.collider(e2).is_none());
        assert_eq!(w.is_grounded(e2), None);
        assert!(!w.is_floor(e2));
        assert!(w.dirty_flags(e2).is_empty());
        assert_eq!(w.dirty_entities().count(), 0, "destroy must leave dirty_list");
    }

    #[test]
    fn grow_to_expands_all_columns() {
        // Set + read every component on an ID far past the initial capacity so a
        // column missed in grow_to panics on index.
        let mut w = World::new(16); // clamps to MIN_CAPACITY
        let id = (MIN_CAPACITY * 4) as EntityId;
        w.set_position(id, [1.0, 2.0, 3.0]);
        w.set_velocity(id, [1.0, 0.0, 0.0]);
        w.set_rotation(id, [0.1, 0.2, 0.3]);
        w.set_health(id, 10);
        w.set_net_flags(id, 0x01);
        w.set_collider(id, ColliderConfig::default());
        w.set_grounded(id, false);
        w.set_floor(id, false);
        w.mark_dirty(id, DirtyFlags::HEALTH);
        assert_eq!(w.position(id), Some([1.0, 2.0, 3.0]));
        assert_eq!(w.dirty_entities().count(), 1);
    }

    #[test]
    fn ten_thousand_entity_movement_pass_stays_fast() {
        // Perf pin for the SoA hot loop: iterate + read + write + mark 10k
        // entities. Generous bound — this catches accidental O(n²), not jitter.
        let mut w = World::new(10_000);
        for _ in 0..10_000 {
            let e = w.create_entity();
            w.set_position(e, [0.0, 0.0, 0.0]);
            w.set_velocity(e, [1.0, 0.0, 0.0]);
        }

        let dt = 1.0 / 60.0;
        let t0 = std::time::Instant::now();
        let ids: Vec<EntityId> = w.entities().collect();
        for id in ids {
            if let (Some(pos), Some(vel)) = (w.position(id), w.velocity(id)) {
                w.set_position(id, [pos[0] + vel[0] * dt, pos[1], pos[2]]);
                w.mark_dirty(id, DirtyFlags::TRANSFORM);
            }
        }
        let micros = t0.elapsed().as_micros();

        assert!(micros < 5_000, "movement pass took {micros}µs, expected < 5000µs");
        w.clear_dirty();
    }
}
