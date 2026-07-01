use std::collections::HashMap;
use ecs::{EntityId, World};
use bincode::{Encode, Decode};

#[derive(Clone, Debug, Encode, Decode)]
pub struct NetPatch {
    pub peer_id: String,
    pub entity: u32,
    pub kind: NetEventKind,
}

#[derive(Clone, Debug, Encode, Decode)]
pub enum NetEventKind {
    Connected,
    Disconnected,
    DeltaUpdate { fields: Vec<FieldUpdate> },
    FullSync    { fields: Vec<FieldUpdate> },
    GameEvent   { payload: Vec<u8> },
}

#[derive(Clone, Debug, Encode, Decode)]
pub struct FieldUpdate {
    pub component_id: u8,
    pub field_id: u8,
    pub value: f64,
}

// Component IDs match existing JS schema conventions
pub const COMP_POSITION: u8 = 0;
pub const COMP_ROTATION: u8 = 1;
pub const COMP_NET_FLAGS: u8 = 2;

#[derive(Default)]
struct EntitySnapshot {
    position: Option<[f32; 3]>,
    rotation: Option<[f32; 3]>,
    net_flags: Option<u8>,
}

/// Tracks per-entity state snapshots and computes minimal delta sets.
#[derive(Default)]
pub struct DeltaTracker {
    dirty: std::collections::HashSet<EntityId>,
    snapshots: HashMap<EntityId, EntitySnapshot>,
}

impl DeltaTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark_dirty(&mut self, entity: EntityId) {
        self.dirty.insert(entity);
    }

    /// Compute deltas for all dirty entities and return NetPatches.
    /// Snapshots are updated after comparison.
    pub fn flush(&mut self, world: &World, peer_id: &str) -> Vec<NetPatch> {
        let mut patches = Vec::new();

        let dirty: Vec<EntityId> = self.dirty.drain().collect();
        for id in dirty {
            let snap = self.snapshots.entry(id).or_default();
            let mut fields = Vec::new();

            if let Some(pos) = world.position(id) {
                if snap.position != Some(pos) {
                    fields.push(FieldUpdate { component_id: COMP_POSITION, field_id: 0, value: pos[0] as f64 });
                    fields.push(FieldUpdate { component_id: COMP_POSITION, field_id: 1, value: pos[1] as f64 });
                    fields.push(FieldUpdate { component_id: COMP_POSITION, field_id: 2, value: pos[2] as f64 });
                    snap.position = Some(pos);
                }
            }
            if let Some(rot) = world.rotation(id) {
                if snap.rotation != Some(rot) {
                    fields.push(FieldUpdate { component_id: COMP_ROTATION, field_id: 0, value: rot[0] as f64 });
                    fields.push(FieldUpdate { component_id: COMP_ROTATION, field_id: 1, value: rot[1] as f64 });
                    fields.push(FieldUpdate { component_id: COMP_ROTATION, field_id: 2, value: rot[2] as f64 });
                    snap.rotation = Some(rot);
                }
            }
            if let Some(flags) = world.net_flags(id) {
                if snap.net_flags != Some(flags) {
                    fields.push(FieldUpdate { component_id: COMP_NET_FLAGS, field_id: 0, value: flags as f64 });
                    snap.net_flags = Some(flags);
                }
            }

            if !fields.is_empty() {
                patches.push(NetPatch {
                    peer_id: peer_id.to_string(),
                    entity: id,
                    kind: NetEventKind::DeltaUpdate { fields },
                });
            }
        }

        patches
    }

    /// Emit a full snapshot of all known entities for a new peer joining.
    pub fn full_snapshot(&self, world: &World, peer_id: &str) -> Vec<NetPatch> {
        world.entities().filter_map(|id| {
            let mut fields = Vec::new();

            if let Some(pos) = world.position(id) {
                fields.push(FieldUpdate { component_id: COMP_POSITION, field_id: 0, value: pos[0] as f64 });
                fields.push(FieldUpdate { component_id: COMP_POSITION, field_id: 1, value: pos[1] as f64 });
                fields.push(FieldUpdate { component_id: COMP_POSITION, field_id: 2, value: pos[2] as f64 });
            }
            if let Some(rot) = world.rotation(id) {
                fields.push(FieldUpdate { component_id: COMP_ROTATION, field_id: 0, value: rot[0] as f64 });
                fields.push(FieldUpdate { component_id: COMP_ROTATION, field_id: 1, value: rot[1] as f64 });
                fields.push(FieldUpdate { component_id: COMP_ROTATION, field_id: 2, value: rot[2] as f64 });
            }
            if let Some(flags) = world.net_flags(id) {
                fields.push(FieldUpdate { component_id: COMP_NET_FLAGS, field_id: 0, value: flags as f64 });
            }

            if fields.is_empty() {
                None
            } else {
                Some(NetPatch {
                    peer_id: peer_id.to_string(),
                    entity: id,
                    kind: NetEventKind::FullSync { fields },
                })
            }
        }).collect()
    }

    /// Apply an inbound encoded NetPatch slice to the world.
    pub fn apply_inbound(
        &self,
        payload: &[u8],
        world: &mut World,
    ) -> Result<Vec<NetPatch>, bincode::error::DecodeError> {
        let (patches, _): (Vec<NetPatch>, _) =
            bincode::decode_from_slice(payload, bincode::config::standard())?;

        for patch in &patches {
            apply_patch_to_world(patch, world);
        }

        Ok(patches)
    }
}

pub fn apply_patch_to_world(patch: &NetPatch, world: &mut World) {
    let id = patch.entity;

    let fields = match &patch.kind {
        NetEventKind::DeltaUpdate { fields } | NetEventKind::FullSync { fields } => fields,
        _ => return,
    };

    // Accumulate components before writing (fields may arrive in any order)
    let mut pos = world.position(id).unwrap_or([0.0; 3]);
    let mut rot = world.rotation(id).unwrap_or([0.0; 3]);
    let mut has_pos = false;
    let mut has_rot = false;

    for f in fields {
        match (f.component_id, f.field_id) {
            (COMP_POSITION, 0) => { pos[0] = f.value as f32; has_pos = true; }
            (COMP_POSITION, 1) => { pos[1] = f.value as f32; has_pos = true; }
            (COMP_POSITION, 2) => { pos[2] = f.value as f32; has_pos = true; }
            (COMP_ROTATION, 0) => { rot[0] = f.value as f32; has_rot = true; }
            (COMP_ROTATION, 1) => { rot[1] = f.value as f32; has_rot = true; }
            (COMP_ROTATION, 2) => { rot[2] = f.value as f32; has_rot = true; }
            (COMP_NET_FLAGS, 0) => { world.set_net_flags(id, f.value as u8); }
            _ => {}
        }
    }

    if has_pos { world.set_position(id, pos); }
    if has_rot { world.set_rotation(id, rot); }
}

pub fn encode_patches(patches: &[NetPatch]) -> Vec<u8> {
    bincode::encode_to_vec(patches, bincode::config::standard())
        .expect("patch encoding should not fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecs::World;

    #[test]
    fn flush_emits_delta_only_for_changed_fields() {
        let mut world = World::new(8);
        let e = world.create_entity();
        world.set_position(e, [1.0, 2.0, 3.0]);

        let mut tracker = DeltaTracker::new();
        tracker.mark_dirty(e);

        let patches = tracker.flush(&world, "peer-a");
        assert_eq!(patches.len(), 1);

        match &patches[0].kind {
            NetEventKind::DeltaUpdate { fields } => {
                assert_eq!(fields.len(), 3); // x, y, z
            }
            other => panic!("unexpected kind: {other:?}"),
        }

        // Flush again without changes — no patches emitted
        tracker.mark_dirty(e);
        let patches2 = tracker.flush(&world, "peer-a");
        assert!(patches2.is_empty());
    }

    #[test]
    fn apply_inbound_updates_world() {
        let mut world = World::new(8);
        let e = world.create_entity();
        world.set_position(e, [0.0; 3]);

        let patches = vec![NetPatch {
            peer_id: "peer-b".into(),
            entity: e,
            kind: NetEventKind::DeltaUpdate {
                fields: vec![
                    FieldUpdate { component_id: COMP_POSITION, field_id: 0, value: 5.0 },
                    FieldUpdate { component_id: COMP_POSITION, field_id: 1, value: 10.0 },
                    FieldUpdate { component_id: COMP_POSITION, field_id: 2, value: 15.0 },
                ],
            },
        }];

        let encoded = encode_patches(&patches);
        let tracker = DeltaTracker::new();
        tracker.apply_inbound(&encoded, &mut world).unwrap();

        assert_eq!(world.position(e), Some([5.0, 10.0, 15.0]));
    }
}
