use bincode::{Decode, Encode};
use ecs::{EntityId, World, NET_PREDICTABLE, NET_PUBLIC_MASK};
use std::collections::HashMap;

/// One wire event. The sender's identity comes from the WebRTC transport
/// (`drain_inbound`'s peer id) — payloads carry no self-claimed identity.
/// Entity ids are in the SENDER's id space; receivers map them to local
/// mirror entities (the engine owns that mapping).
#[derive(Clone, Debug, PartialEq, Encode, Decode)]
pub enum WireEvent {
    /// First description of a sender-owned entity — emitted when the tracker
    /// has no snapshot for it yet, and for every entity in a late-join sync.
    /// `flags` is the entity's public net profile (`NET_PUBLIC_MASK`) so the
    /// receiver can style the mirror and know whether to extrapolate it.
    Spawn { entity: EntityId, flags: u8, fields: Vec<FieldUpdate> },
    /// Changed fields for an already-announced sender-owned entity.
    Delta { entity: EntityId, fields: Vec<FieldUpdate> },
    /// The sender destroyed this entity; receivers drop their mirror.
    Despawned { entity: EntityId },
    /// Keepalive: peers with nothing to say send this so silence isn't
    /// mistaken for disconnection (the transport has no disconnect callback).
    Ping,
}

#[derive(Clone, Debug, PartialEq, Encode, Decode)]
pub struct FieldUpdate {
    pub component_id: u8,
    pub field_id: u8,
    pub value: f64,
}

// Wire-protocol component ids — all peers must agree; never renumber.
// id 2 (net_flags) is retired: entity semantics travel once, in Spawn.flags.
pub const COMP_POSITION: u8 = 0;
pub const COMP_ROTATION: u8 = 1;
/// Sent only for NET_PREDICTABLE entities — receivers extrapolate from it.
pub const COMP_VELOCITY: u8 = 3;

#[derive(Default)]
struct EntitySnapshot {
    position: Option<[f32; 3]>,
    rotation: Option<[f32; 3]>,
    velocity: Option<[f32; 3]>,
}

/// Tracks per-entity state snapshots and computes minimal delta sets.
#[derive(Default)]
pub struct DeltaTracker {
    dirty: std::collections::HashSet<EntityId>,
    snapshots: HashMap<EntityId, EntitySnapshot>,
}

/// Push one vec3 component as three FieldUpdates (field_id = axis index).
fn push_vec3(fields: &mut Vec<FieldUpdate>, component_id: u8, v: [f32; 3]) {
    for (axis, value) in v.iter().enumerate() {
        fields.push(FieldUpdate {
            component_id,
            field_id: axis as u8,
            value: *value as f64,
        });
    }
}

/// Build the FieldUpdates for one entity. With a snapshot, only components that
/// differ from it are emitted and the snapshot is updated (delta mode); without
/// one, every present component is emitted (full-sync mode). Velocity is only
/// shipped for NET_PREDICTABLE entities — that's what receivers extrapolate on.
fn collect_fields(
    world: &World,
    id: EntityId,
    mut snap: Option<&mut EntitySnapshot>,
) -> Vec<FieldUpdate> {
    let mut fields = Vec::new();

    if let Some(pos) = world.position(id) {
        if snap.as_ref().is_none_or(|s| s.position != Some(pos)) {
            push_vec3(&mut fields, COMP_POSITION, pos);
            if let Some(s) = snap.as_deref_mut() {
                s.position = Some(pos);
            }
        }
    }
    if let Some(rot) = world.rotation(id) {
        if snap.as_ref().is_none_or(|s| s.rotation != Some(rot)) {
            push_vec3(&mut fields, COMP_ROTATION, rot);
            if let Some(s) = snap.as_deref_mut() {
                s.rotation = Some(rot);
            }
        }
    }
    if world.net_flags(id).is_some_and(|f| f & NET_PREDICTABLE != 0) {
        if let Some(vel) = world.velocity(id) {
            if snap.as_ref().is_none_or(|s| s.velocity != Some(vel)) {
                push_vec3(&mut fields, COMP_VELOCITY, vel);
                if let Some(s) = snap.as_deref_mut() {
                    s.velocity = Some(vel);
                }
            }
        }
    }
    fields
}

impl DeltaTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark_dirty(&mut self, entity: EntityId) {
        self.dirty.insert(entity);
    }

    /// Whether the entity has been announced (has a snapshot). Untracked
    /// entities need immediate flushing regardless of cadence — their Spawn is
    /// what tells peers they exist.
    pub fn is_tracked(&self, entity: EntityId) -> bool {
        self.snapshots.contains_key(&entity)
    }

    /// Drop all tracking state for a destroyed entity. Entity IDs are recycled,
    /// so a surviving snapshot would suppress the recycled entity's first delta
    /// whenever its fields happen to match the old ones — and the snapshot map
    /// would grow unboundedly.
    pub fn forget(&mut self, entity: EntityId) {
        self.dirty.remove(&entity);
        self.snapshots.remove(&entity);
    }

    /// Compute wire events for all dirty entities: an entity new to the tracker
    /// emits Spawn (full fields + public flag profile); a known one emits Delta
    /// with only the components that differ from its snapshot.
    pub fn flush(&mut self, world: &World) -> Vec<WireEvent> {
        let mut events = Vec::new();

        let dirty: Vec<EntityId> = self.dirty.drain().collect();
        for id in dirty {
            let is_new = !self.snapshots.contains_key(&id);
            let snap = self.snapshots.entry(id).or_default();
            let fields = collect_fields(world, id, Some(snap));
            if is_new {
                events.push(WireEvent::Spawn {
                    entity: id,
                    flags: world.net_flags(id).unwrap_or(0) & NET_PUBLIC_MASK,
                    fields,
                });
            } else if !fields.is_empty() {
                events.push(WireEvent::Delta { entity: id, fields });
            }
        }

        events
    }

    /// Emit Spawn events with complete state for the given (locally-owned)
    /// entities — sent to a newly connected peer so it sees existing state
    /// without waiting for the entities to move.
    pub fn full_snapshot(&self, world: &World, ids: &[EntityId]) -> Vec<WireEvent> {
        ids.iter()
            .filter_map(|&id| {
                let fields = collect_fields(world, id, None);
                if fields.is_empty() {
                    None
                } else {
                    Some(WireEvent::Spawn {
                        entity: id,
                        flags: world.net_flags(id).unwrap_or(0) & NET_PUBLIC_MASK,
                        fields,
                    })
                }
            })
            .collect()
    }
}

/// Write one event's fields into the given LOCAL entity (the receiver-side
/// mirror). Unknown component/field ids are ignored so older builds skip what
/// they don't understand instead of misapplying it.
pub fn apply_fields_to_entity(world: &mut World, id: EntityId, fields: &[FieldUpdate]) {
    // Accumulate components before writing (fields may arrive in any order).
    let mut pos = world.position(id).unwrap_or([0.0; 3]);
    let mut rot = world.rotation(id).unwrap_or([0.0; 3]);
    let mut vel = world.velocity(id).unwrap_or([0.0; 3]);
    let mut has_pos = false;
    let mut has_rot = false;
    let mut has_vel = false;

    for f in fields {
        let axis = f.field_id as usize;
        match f.component_id {
            COMP_POSITION if axis < 3 => {
                pos[axis] = f.value as f32;
                has_pos = true;
            }
            COMP_ROTATION if axis < 3 => {
                rot[axis] = f.value as f32;
                has_rot = true;
            }
            COMP_VELOCITY if axis < 3 => {
                vel[axis] = f.value as f32;
                has_vel = true;
            }
            _ => {}
        }
    }

    if has_pos {
        world.set_position(id, pos);
    }
    if has_rot {
        world.set_rotation(id, rot);
    }
    if has_vel {
        world.set_velocity(id, vel);
    }
}

pub fn encode_events(events: &[WireEvent]) -> Vec<u8> {
    bincode::encode_to_vec(events, bincode::config::standard())
        .expect("wire-event encoding should not fail")
}

/// Decode an inbound payload. A payload that fails to decode is rejected whole
/// — the world is never partially mutated.
pub fn decode_events(payload: &[u8]) -> Result<Vec<WireEvent>, bincode::error::DecodeError> {
    bincode::decode_from_slice(payload, bincode::config::standard()).map(|(events, _)| events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecs::World;

    #[test]
    fn flush_emits_spawn_first_then_deltas_only_for_changes() {
        let mut world = World::new(8);
        let e = world.create_entity();
        world.set_position(e, [1.0, 2.0, 3.0]);
        world.set_net_flags(e, ecs::NET_MONSTER | ecs::NET_LOCAL);

        let mut tracker = DeltaTracker::new();
        tracker.mark_dirty(e);

        // First sight → Spawn carrying only the PUBLIC flag profile.
        let events = tracker.flush(&world);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WireEvent::Spawn { entity, flags, fields } => {
                assert_eq!(*entity, e);
                assert_eq!(*flags, ecs::NET_MONSTER, "only public flags cross the wire");
                assert_eq!(fields.len(), 3); // x, y, z
            }
            other => panic!("expected Spawn, got {other:?}"),
        }

        // Unchanged → nothing. Changed → Delta, not another Spawn.
        tracker.mark_dirty(e);
        assert!(tracker.flush(&world).is_empty());
        world.set_position(e, [4.0, 2.0, 3.0]);
        tracker.mark_dirty(e);
        let events = tracker.flush(&world);
        assert!(
            matches!(&events[0], WireEvent::Delta { entity, .. } if *entity == e),
            "known entity must emit Delta, got {events:?}",
        );
    }

    #[test]
    fn predictable_entities_ship_velocity() {
        let mut world = World::new(8);
        let e = world.create_entity();
        world.set_position(e, [0.0; 3]);
        world.set_velocity(e, [10.0, 0.0, 0.0]);
        world.set_net_flags(e, ecs::NET_BULLET | ecs::NET_PREDICTABLE);

        let mut tracker = DeltaTracker::new();
        tracker.mark_dirty(e);
        let events = tracker.flush(&world);
        match &events[0] {
            WireEvent::Spawn { fields, .. } => {
                assert!(
                    fields.iter().any(|f| f.component_id == COMP_VELOCITY),
                    "predictable entities must ship velocity for extrapolation",
                );
            }
            other => panic!("expected Spawn, got {other:?}"),
        }

        // Non-predictable entities never waste wire on velocity.
        let plain = world.create_entity();
        world.set_position(plain, [0.0; 3]);
        world.set_velocity(plain, [10.0, 0.0, 0.0]);
        tracker.mark_dirty(plain);
        let events = tracker.flush(&world);
        match &events[0] {
            WireEvent::Spawn { fields, .. } => {
                assert!(fields.iter().all(|f| f.component_id != COMP_VELOCITY));
            }
            other => panic!("expected Spawn, got {other:?}"),
        }
    }

    #[test]
    fn wire_events_roundtrip_through_encoding() {
        let events = vec![
            WireEvent::Spawn {
                entity: 3,
                flags: ecs::NET_BULLET | ecs::NET_PREDICTABLE,
                fields: vec![FieldUpdate { component_id: COMP_VELOCITY, field_id: 1, value: -2.0 }],
            },
            WireEvent::Delta {
                entity: 7,
                fields: vec![FieldUpdate { component_id: COMP_POSITION, field_id: 0, value: 5.5 }],
            },
            WireEvent::Despawned { entity: 9 },
            WireEvent::Ping,
        ];
        let decoded = decode_events(&encode_events(&events)).expect("roundtrip");
        assert_eq!(decoded, events);
    }

    #[test]
    fn apply_fields_writes_position_and_ignores_unknown_components() {
        let mut world = World::new(8);
        let e = world.create_entity();
        world.set_position(e, [0.0; 3]);

        apply_fields_to_entity(
            &mut world,
            e,
            &[
                FieldUpdate { component_id: COMP_POSITION, field_id: 0, value: 5.0 },
                FieldUpdate { component_id: COMP_POSITION, field_id: 1, value: 10.0 },
                FieldUpdate { component_id: COMP_POSITION, field_id: 2, value: 15.0 },
                // Unknown component / out-of-range axis must be skipped, not crash.
                FieldUpdate { component_id: 99, field_id: 0, value: 1.0 },
                FieldUpdate { component_id: COMP_POSITION, field_id: 7, value: 1.0 },
            ],
        );

        assert_eq!(world.position(e), Some([5.0, 10.0, 15.0]));
    }

    #[test]
    fn full_snapshot_covers_only_requested_entities() {
        let mut world = World::new(8);
        let local = world.create_entity();
        world.set_position(local, [1.0, 0.0, 0.0]);
        let other = world.create_entity();
        world.set_position(other, [2.0, 0.0, 0.0]);

        let tracker = DeltaTracker::new();
        let events = tracker.full_snapshot(&world, &[local]);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WireEvent::Spawn { entity, .. } => assert_eq!(*entity, local),
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn forget_clears_snapshot_so_recycled_ids_resync() {
        let mut world = World::new(8);
        let e = world.create_entity();
        world.set_position(e, [1.0, 2.0, 3.0]);

        let mut tracker = DeltaTracker::new();
        tracker.mark_dirty(e);
        assert_eq!(tracker.flush(&world).len(), 1);

        // Destroy, forget, recycle the same ID at the same position. Without
        // forget, the stale snapshot matches and the new entity's first delta
        // is suppressed — remote peers would never learn it exists.
        world.destroy_entity(e);
        tracker.forget(e);
        let e2 = world.create_entity();
        assert_eq!(e2, e, "test assumes ID recycling");
        world.set_position(e2, [1.0, 2.0, 3.0]);

        tracker.mark_dirty(e2);
        let events = tracker.flush(&world);
        assert!(
            matches!(&events[..], [WireEvent::Spawn { .. }]),
            "recycled entity must re-announce itself as a fresh Spawn, got {events:?}",
        );
    }
}
