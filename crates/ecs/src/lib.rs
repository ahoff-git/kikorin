use bitflags::bitflags;

pub type EntityId = u32;

bitflags! {
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct DirtyFlags: u8 {
        const TRANSFORM = 0b0001;
        const COLLIDER  = 0b0010;
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

/// Column-based (SoA) entity-component storage.
/// Each component is a Vec<Option<T>> indexed by EntityId.
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
        let cap = capacity.max(256);
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
        if i < self.alive.len() {
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
        }
        self.free_list.push(id);
    }

    pub fn entities(&self) -> impl Iterator<Item = EntityId> + '_ {
        (0..self.next_id).filter(|&id| {
            self.alive.get(id as usize).copied().unwrap_or(false)
        })
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
        let i = id as usize;
        if i < self.dirty.len() {
            if self.dirty[i].is_empty() {
                self.dirty_list.push(id);
            }
            self.dirty[i] |= flags;
        }
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

/// Runs a fixed list of systems in registration order.
pub struct SystemScheduler {
    systems: Vec<(&'static str, Box<dyn FnMut(&mut World, f32)>)>,
}

impl SystemScheduler {
    pub fn new() -> Self {
        Self { systems: Vec::new() }
    }

    pub fn register(
        &mut self,
        name: &'static str,
        system: impl FnMut(&mut World, f32) + 'static,
    ) {
        self.systems.push((name, Box::new(system)));
    }

    pub fn run(&mut self, world: &mut World, dt_secs: f32) {
        for (_, sys) in &mut self.systems {
            sys(world, dt_secs);
        }
    }
}

impl Default for SystemScheduler {
    fn default() -> Self {
        Self::new()
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
    fn ten_thousand_entities_under_one_ms() {
        let mut w = World::new(10_000);
        for _ in 0..10_000 {
            let e = w.create_entity();
            w.set_position(e, [0.0, 0.0, 0.0]);
            w.set_velocity(e, [1.0, 0.0, 0.0]);
        }

        let mut sched = SystemScheduler::new();

        sched.register("movement", |world, dt| {
            let ids: Vec<EntityId> = world.entities().collect();
            for id in ids {
                if let (Some(pos), Some(vel)) = (world.position(id), world.velocity(id)) {
                    world.set_position(id, [pos[0] + vel[0] * dt, pos[1], pos[2]]);
                    world.mark_dirty(id, DirtyFlags::TRANSFORM);
                }
            }
        });

        sched.register("dirty_scan", |world, _dt| {
            let _ = world.dirty_entities().count();
        });

        let t0 = std::time::Instant::now();
        sched.run(&mut w, 1.0 / 60.0);
        let ms = t0.elapsed().as_millis();

        assert!(ms < 1, "tick took {ms}ms, expected < 1ms");

        w.clear_dirty();
    }
}
