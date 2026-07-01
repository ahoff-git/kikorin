use bincode::{Decode, Encode};
use ecs::{DirtyFlags, EntityId, World};
use netcode::NetPatch;

/// Serialized over the WASM boundary every tick.
#[derive(Clone, Debug, Encode, Decode)]
pub struct PatchBundle {
    pub tick: u64,
    pub render: Vec<RenderPatch>,
    pub semantic: Vec<SemanticPatch>,
    pub net: Vec<NetPatch>,
    pub metrics: MetricsPatch,
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
}

/// Per-tick timing in milliseconds, always emitted — consumers may ignore.
#[derive(Clone, Debug, Default, Encode, Decode)]
pub struct MetricsPatch {
    pub tick_ms: f32,
    pub ecs_ms: f32,
    pub physics_ms: f32,
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
        metrics: MetricsPatch,
    ) -> PatchBundle {
        let mut render = Vec::new();
        let mut semantic = Vec::new();

        for id in world.dirty_entities() {
            let flags = world.dirty_flags(id);

            if flags.contains(DirtyFlags::TRANSFORM) {
                if let Some([x, y, z]) = world.position(id) {
                    let [yaw, pitch, roll] = world.rotation(id).unwrap_or([0.0; 3]);
                    render.push(RenderPatch { entity: id, x, y, z, yaw, pitch, roll });
                }
            }

            let has_semantic = flags.intersects(DirtyFlags::HEALTH | DirtyFlags::NET);
            if has_semantic {
                semantic.push(SemanticPatch {
                    entity: id,
                    health: if flags.contains(DirtyFlags::HEALTH) { world.health(id) } else { None },
                    net_flags: if flags.contains(DirtyFlags::NET) { world.net_flags(id) } else { None },
                    grounded: world.is_grounded(id),
                });
            }
        }

        PatchBundle { tick: world.tick_count(), render, semantic, net, metrics }
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
                x: 1.0, y: 2.0, z: 3.0,
                yaw: 0.5, pitch: 0.1, roll: 0.0,
            }],
            semantic: vec![SemanticPatch {
                entity: 2,
                health: Some(100),
                net_flags: Some(0b0011),
                grounded: Some(true),
            }],
            net: vec![],
            metrics: MetricsPatch {
                tick_ms: 16.0,
                ecs_ms: 2.0,
                physics_ms: 8.0,
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
        let bundle = gen.generate(&world, vec![], MetricsPatch::default());

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
        let bundle = gen.generate(&world, vec![], MetricsPatch::default());

        assert!(bundle.render.is_empty());
        assert_eq!(bundle.semantic.len(), 1);
        assert_eq!(bundle.semantic[0].health, Some(75));
    }
}
