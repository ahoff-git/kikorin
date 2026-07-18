use bincode::{Decode, Encode};
use ecs::{DirtyFlags, EntityId, World};

/// Serialized over the WASM boundary every tick.
#[derive(Clone, Debug, Encode, Decode)]
pub struct PatchBundle {
    pub tick: u64,
    pub render: Vec<RenderPatch>,
    pub semantic: Vec<SemanticPatch>,
    pub net: Vec<NetPatch>,
    pub hits: Vec<HitPatch>,
    pub lifecycle: Vec<LifecyclePatch>,
    pub metrics: MetricsPatch,
}

/// Local-entity lifecycle event: the engine created or destroyed an entity
/// (fire, death, respawn, TTL, explicit spawn). The game creates/removes meshes
/// from these instead of tracking spawn call sites — the engine is the source
/// of truth for what exists. Terrain and remote mirrors are excluded (terrain
/// comes from `load_map`'s return; mirrors ride `NetPatch`).
#[derive(Clone, Debug, Encode, Decode)]
pub struct LifecyclePatch {
    pub entity: EntityId,
    pub kind: LifecycleKind,
    /// The entity's net-flag profile — the game styles meshes from it.
    pub flags: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode)]
pub enum LifecycleKind {
    Spawned,
    Despawned,
}

/// Peer-activity notification surfaced to the TypeScript layer. Deliberately thinner
/// than netcode's wire events: `entity` is the LOCAL mirror id the engine created
/// for the remote entity (so it lines up with render patches); field-level wire
/// detail stays inside `crates/netcode`, and the engine maps between the two.
#[derive(Clone, Debug, Encode, Decode)]
pub struct NetPatch {
    pub peer_id: String,
    /// Local mirror entity id; 0 for PeerLeft (no entity).
    pub entity: EntityId,
    pub kind: NetEventKind,
    /// The mirror's public net profile (type + predictability bits), present on
    /// spawn events so the game can style the remote mesh.
    pub flags: Option<u8>,
}

/// What happened to the remote entity (or peer). The game uses these to create
/// and remove meshes for remote mirrors and to maintain its peer list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode)]
pub enum NetEventKind {
    EntitySpawned,
    EntityUpdated,
    EntityDespawned,
    /// Transport-level connection opened (entity is 0) — emitted before any
    /// entity data so the UI can show the peer immediately.
    PeerJoined,
    PeerLeft,
}

/// Bullet–target collision event — a pure UI/FX notification. The engine settles
/// all consequences itself (bullet destruction, damage, death, respawn); the
/// resulting entity churn reaches the game as LifecyclePatches.
/// `target_eid` is None when the bullet expired without hitting anything (TTL ran
/// out or it fell past the engine's kill plane).
#[derive(Clone, Debug, Encode, Decode)]
pub struct HitPatch {
    pub bullet_eid: EntityId,
    pub target_eid: Option<EntityId>,
}

#[derive(Clone, Debug, Encode, Decode)]
pub struct RenderPatch {
    pub entity: EntityId,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
}

#[derive(Clone, Debug, Encode, Decode)]
pub struct SemanticPatch {
    pub entity: EntityId,
    pub health: Option<i32>,
    pub net_flags: Option<u8>,
    pub grounded: Option<bool>,
    /// Resolved animation cell (present when the ANIM dirty flag is set): which
    /// family/frame/direction the engine's animation state machine picked this
    /// tick. TS displays it; it never recomputes animation. See ADR 0015.
    pub anim_id: Option<u16>,
    pub anim_frame: Option<u16>,
    pub anim_dir: Option<u8>,
}

/// Per-tick timing in milliseconds, always emitted — consumers may ignore.
/// `pathfinding_ms` is the A* share of `ai_ms` (searches run inside the AI pass).
#[derive(Clone, Debug, Default, Encode, Decode)]
pub struct MetricsPatch {
    pub tick_ms: f32,
    pub ai_ms: f32,
    pub physics_ms: f32,
    pub pathfinding_ms: f32,
    pub net_ms: f32,
    pub patch_ms: f32,
}

/// Scans dirty entities in the World and builds a PatchBundle.
#[derive(Default)]
pub struct PatchGenerator;

impl PatchGenerator {
    pub fn new() -> Self {
        Self
    }

    pub fn generate(
        &self,
        world: &World,
        net: Vec<NetPatch>,
        hits: Vec<HitPatch>,
        lifecycle: Vec<LifecyclePatch>,
        metrics: MetricsPatch,
    ) -> PatchBundle {
        let mut render = Vec::new();
        let mut semantic = Vec::new();

        for id in world.dirty_entities() {
            let flags = world.dirty_flags(id);

            if flags.contains(DirtyFlags::TRANSFORM) {
                if let Some([x, y, z]) = world.position(id) {
                    let [yaw, pitch, roll] = world.rotation(id).unwrap_or([0.0; 3]);
                    render.push(RenderPatch {
                        entity: id,
                        x,
                        y,
                        z,
                        yaw,
                        pitch,
                        roll,
                    });
                }
            }

            let has_semantic = flags.intersects(DirtyFlags::HEALTH | DirtyFlags::NET | DirtyFlags::ANIM);
            if has_semantic {
                let anim = if flags.contains(DirtyFlags::ANIM) {
                    world.anim_cell(id)
                } else {
                    None
                };
                semantic.push(SemanticPatch {
                    entity: id,
                    health: if flags.contains(DirtyFlags::HEALTH) {
                        world.health(id)
                    } else {
                        None
                    },
                    net_flags: if flags.contains(DirtyFlags::NET) {
                        world.net_flags(id)
                    } else {
                        None
                    },
                    grounded: world.is_grounded(id),
                    anim_id: anim.map(|a| a.anim_id),
                    anim_frame: anim.map(|a| a.frame),
                    anim_dir: anim.map(|a| a.dir),
                });
            }
        }

        PatchBundle {
            tick: world.tick_count(),
            render,
            semantic,
            net,
            hits,
            lifecycle,
            metrics,
        }
    }

    pub fn serialize(bundle: &PatchBundle) -> Vec<u8> {
        bincode::encode_to_vec(bundle, bincode::config::standard())
            .expect("PatchBundle serialization should not fail")
    }

    pub fn deserialize(bytes: &[u8]) -> Result<PatchBundle, bincode::error::DecodeError> {
        let (bundle, _) = bincode::decode_from_slice(bytes, bincode::config::standard())?;
        Ok(bundle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecs::{DirtyFlags, World};

    #[test]
    fn patch_bundle_roundtrips_through_bincode() {
        let bundle = PatchBundle {
            tick: 42,
            render: vec![RenderPatch {
                entity: 1,
                x: 1.0,
                y: 2.0,
                z: 3.0,
                yaw: 0.5,
                pitch: 0.1,
                roll: 0.0,
            }],
            semantic: vec![SemanticPatch {
                entity: 2,
                health: Some(100),
                net_flags: Some(0b0011),
                grounded: Some(true),
                anim_id: Some(1),
                anim_frame: Some(2),
                anim_dir: Some(3),
            }],
            net: vec![],
            hits: vec![HitPatch {
                bullet_eid: 5,
                target_eid: Some(3),
            }],
            lifecycle: vec![LifecyclePatch { entity: 4, kind: LifecycleKind::Spawned, flags: 0x02 }],
            metrics: MetricsPatch {
                tick_ms: 16.0,
                ai_ms: 2.0,
                physics_ms: 8.0,
                pathfinding_ms: 0.7,
                net_ms: 1.0,
                patch_ms: 0.5,
            },
        };

        let bytes = PatchGenerator::serialize(&bundle);
        let decoded = PatchGenerator::deserialize(&bytes).expect("decode should succeed");

        assert_eq!(decoded.tick, bundle.tick);
        assert_eq!(decoded.render.len(), 1);
        assert_eq!(decoded.render[0].entity, 1);
        assert!((decoded.render[0].x - 1.0).abs() < 1e-6);
        assert_eq!(decoded.semantic[0].health, Some(100));
        assert_eq!(decoded.semantic[0].grounded, Some(true));
        assert_eq!(decoded.semantic[0].anim_id, Some(1));
        assert_eq!(decoded.semantic[0].anim_frame, Some(2));
        assert_eq!(decoded.semantic[0].anim_dir, Some(3));
        assert_eq!(decoded.hits.len(), 1);
        assert_eq!(decoded.hits[0].bullet_eid, 5);
        assert_eq!(decoded.hits[0].target_eid, Some(3));
        assert!((decoded.metrics.tick_ms - 16.0).abs() < 1e-6);
    }

    #[test]
    fn generator_emits_render_patch_for_dirty_transform() {
        let mut world = World::new(8);
        let e = world.create_entity();
        world.set_position(e, [10.0, 0.0, 5.0]);
        world.set_rotation(e, [1.5, 0.0, 0.0]);
        world.mark_dirty(e, DirtyFlags::TRANSFORM);

        let gen = PatchGenerator::new();
        let bundle = gen.generate(&world, vec![], vec![], vec![], MetricsPatch::default());

        assert_eq!(bundle.render.len(), 1);
        assert!((bundle.render[0].x - 10.0).abs() < 1e-6);
        assert!((bundle.render[0].yaw - 1.5).abs() < 1e-6);
        assert!(bundle.semantic.is_empty());
    }

    #[test]
    fn generator_emits_semantic_patch_for_health_dirty() {
        let mut world = World::new(8);
        let e = world.create_entity();
        world.set_health(e, 75);
        world.mark_dirty(e, DirtyFlags::HEALTH);

        let gen = PatchGenerator::new();
        let bundle = gen.generate(&world, vec![], vec![], vec![], MetricsPatch::default());

        assert!(bundle.render.is_empty());
        assert_eq!(bundle.semantic.len(), 1);
        assert_eq!(bundle.semantic[0].health, Some(75));
    }
}
