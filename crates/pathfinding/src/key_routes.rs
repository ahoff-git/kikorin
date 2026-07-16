use std::collections::HashMap;

use crate::{FlowField, NavMesh, NodeId, Waypoint};

/// Baked "the ground knows how to get to key places" routes (Tier 3):
/// key nodes derived from geometry, each with a capability-filtered flow
/// field toward it. Built once per capability tuple; queried with zero
/// search. See specs/pathfinding.
pub struct KeyRoutes {
    keys: Vec<NodeId>,
    fields: Vec<FlowField>,
}

/// A planned route to the key node nearest the goal. The caller bridges
/// `exit_key` → the real goal with an ordinary short `find_path`.
pub struct KeyPlan {
    pub waypoints: Vec<Waypoint>,
    pub exit_key: [f32; 3],
}

impl NavMesh {
    /// Key nodes derived from geometry, never hand-tuned: square clusters
    /// sized for ~√(node count) buckets; representative = member nearest
    /// the bucket centroid. XZ-only bucketing — stacked layers share a
    /// bucket (see specs/pathfinding for the v1 tradeoff).
    pub fn derive_key_nodes(&self) -> Vec<NodeId> {
        let n = self.nodes.len();
        if n == 0 {
            return Vec::new();
        }
        let (mut min_x, mut max_x) = (f32::INFINITY, f32::NEG_INFINITY);
        let (mut min_z, mut max_z) = (f32::INFINITY, f32::NEG_INFINITY);
        for p in &self.nodes {
            min_x = min_x.min(p[0]);
            max_x = max_x.max(p[0]);
            min_z = min_z.min(p[2]);
            max_z = max_z.max(p[2]);
        }
        let k_target = (n as f32).sqrt().ceil().max(1.0);
        let area = ((max_x - min_x) * (max_z - min_z)).max(self.cell_size * self.cell_size);
        let cluster = (area / k_target).sqrt().max(self.cell_size);

        let mut buckets: HashMap<(i32, i32), Vec<NodeId>> = HashMap::new();
        for (id, p) in self.nodes.iter().enumerate() {
            let key = ((p[0] / cluster).floor() as i32, (p[2] / cluster).floor() as i32);
            buckets.entry(key).or_default().push(id as NodeId);
        }

        let mut keys: Vec<NodeId> = buckets
            .values()
            .map(|members| {
                let (sx, sz) = members.iter().fold((0.0f32, 0.0f32), |acc, &m| {
                    let p = self.nodes[m as usize];
                    (acc.0 + p[0], acc.1 + p[2])
                });
                let (cx, cz) = (sx / members.len() as f32, sz / members.len() as f32);
                *members
                    .iter()
                    .min_by(|&&a, &&b| {
                        let pa = self.nodes[a as usize];
                        let pb = self.nodes[b as usize];
                        let da = (pa[0] - cx).powi(2) + (pa[2] - cz).powi(2);
                        let db = (pb[0] - cx).powi(2) + (pb[2] - cz).powi(2);
                        da.total_cmp(&db)
                    })
                    .expect("bucket is non-empty")
            })
            .collect();
        // HashMap iteration order is nondeterministic; keep builds stable.
        keys.sort_unstable();
        keys
    }

    pub fn build_key_routes(&self, can_jump: bool, can_sprint: bool) -> Option<KeyRoutes> {
        let keys = self.derive_key_nodes();
        if keys.is_empty() {
            return None;
        }
        let fields = keys
            .iter()
            .map(|&k| self.flow_field_from_node(k, can_jump, can_sprint))
            .collect();
        Some(KeyRoutes { keys, fields })
    }
}

impl KeyRoutes {
    /// Assemble from separately-built parts — the resumable-build path
    /// (fields built one per tick on the heavy queue; see specs/engine).
    /// `fields[i]` must flow toward `keys[i]`.
    pub fn from_parts(keys: Vec<NodeId>, fields: Vec<FlowField>) -> Option<KeyRoutes> {
        if keys.is_empty() || keys.len() != fields.len() {
            return None;
        }
        Some(KeyRoutes { keys, fields })
    }

    pub fn key_count(&self) -> usize {
        self.keys.len()
    }

    /// Zero-search route from `start` to the key node nearest `goal` that
    /// is reachable from start AND meaningfully closer to the goal than the
    /// start already is (a key that doesn't improve on standing still is no
    /// help). None = Tier 3 has nothing to offer — caller falls back to a
    /// plain `find_path`.
    pub fn plan(
        &self,
        mesh: &NavMesh,
        start: [f32; 3],
        start_y: Option<f32>,
        goal: [f32; 3],
    ) -> Option<KeyPlan> {
        let start_node = match start_y {
            Some(y) => mesh.nearest_walkable_3d(start[0], y, start[2])?,
            None => mesh.nearest_walkable(start[0], start[2])?,
        };

        let exit_i = self
            .keys
            .iter()
            .enumerate()
            .filter(|&(i, _)| self.fields[i].reaches(start_node))
            .min_by(|&(_, &a), &(_, &b)| {
                let pa = mesh.node_position(a).unwrap_or([f32::INFINITY; 3]);
                let pb = mesh.node_position(b).unwrap_or([f32::INFINITY; 3]);
                let da = (pa[0] - goal[0]).powi(2) + (pa[2] - goal[2]).powi(2);
                let db = (pb[0] - goal[0]).powi(2) + (pb[2] - goal[2]).powi(2);
                da.total_cmp(&db)
            })
            .map(|(i, _)| i)?;

        let exit_key_node = self.keys[exit_i];
        let exit_key = mesh.node_position(exit_key_node)?;
        let d_exit = ((exit_key[0] - goal[0]).powi(2) + (exit_key[2] - goal[2]).powi(2)).sqrt();
        let d_start = ((start[0] - goal[0]).powi(2) + (start[2] - goal[2]).powi(2)).sqrt();
        if d_exit + mesh.cell_size > d_start {
            return None;
        }

        let field = &self.fields[exit_i];
        let mut waypoints = Vec::new();
        let mut cur = start_node;
        let mut guard = mesh.node_count() + 1;
        while cur != exit_key_node {
            let hop = field.next_hop(cur)?;
            let p = mesh.node_position(hop.to)?;
            waypoints.push(Waypoint {
                x: p[0],
                y: p[1],
                z: p[2],
                requires_jump: hop.requires_jump,
                requires_sprint: hop.requires_sprint,
                is_ledge_drop: hop.is_ledge_drop,
            });
            cur = hop.to;
            guard -= 1;
            if guard == 0 {
                return None;
            }
        }
        if waypoints.is_empty() {
            return None;
        }
        Some(KeyPlan {
            waypoints: mesh.simplify(&waypoints),
            exit_key,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::{NavMesh, NavMeshConfig, NodeId};

    fn open_grid(size: usize) -> NavMesh {
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
        for row in 0..size {
            for col in 0..size {
                mesh.add_node(col as f32 + 0.5, 0.0, row as f32 + 0.5);
            }
        }
        let dirs: &[(i32, i32)] = &[(0, 1), (0, -1), (1, 0), (-1, 0)];
        for row in 0..size as i32 {
            for col in 0..size as i32 {
                for &(dr, dc) in dirs {
                    let (nr, nc) = (row + dr, col + dc);
                    if nr < 0 || nc < 0 || nr >= size as i32 || nc >= size as i32 {
                        continue;
                    }
                    mesh.add_edge(
                        (row * size as i32 + col) as NodeId,
                        (nr * size as i32 + nc) as NodeId,
                        1.0,
                        false,
                        false,
                    );
                }
            }
        }
        mesh
    }

    #[test]
    fn key_node_count_scales_with_sqrt_of_node_count() {
        let mesh = open_grid(16); // 256 nodes → target ≈ 16 keys
        let keys = mesh.derive_key_nodes();
        assert!(
            (8..=32).contains(&keys.len()),
            "expected roughly sqrt(256)=16 keys, got {}",
            keys.len(),
        );
        for &k in &keys {
            assert!(mesh.node_position(k).is_some(), "keys must be real nodes");
        }
    }

    #[test]
    fn plan_routes_to_the_key_nearest_the_goal() {
        let mesh = open_grid(16);
        let routes = mesh.build_key_routes(true, false).expect("routes");
        let goal = [15.5, 0.0, 15.5];
        let plan = routes
            .plan(&mesh, [0.5, 0.0, 0.5], Some(0.0), goal)
            .expect("open grid must plan");

        let last = plan.waypoints.last().expect("non-empty");
        assert_eq!(
            [last.x, last.y, last.z],
            plan.exit_key,
            "route must end at the exit key",
        );
        let d_exit = (plan.exit_key[0] - goal[0]).powi(2) + (plan.exit_key[2] - goal[2]).powi(2);
        let d_start = (0.5f32 - goal[0]).powi(2) + (0.5f32 - goal[2]).powi(2);
        assert!(
            d_exit < d_start * 0.25,
            "exit key should be much closer to the goal than the start was",
        );
    }

    #[test]
    fn no_reachable_key_returns_none_for_graceful_tier2_fallback() {
        // Start region joined to the rest (and every key) only by a jump
        // edge; a can_jump:false table must return None, never a broken plan.
        let mut mesh = open_grid(4);
        let island = mesh.add_node(-5.5, 0.0, 0.5);
        mesh.add_edge(island, 0, 2.0, true, false);
        mesh.add_edge(0, island, 2.0, true, false);

        let grounded = mesh.build_key_routes(false, false).expect("routes");
        let plan = grounded.plan(&mesh, [-5.5, 0.0, 0.5], Some(0.0), [3.5, 0.0, 3.5]);
        assert!(
            plan.is_none(),
            "no key reachable without jumping from the island — must be None",
        );

        let jumper = mesh.build_key_routes(true, false).expect("routes");
        let plan = jumper.plan(&mesh, [-5.5, 0.0, 0.5], Some(0.0), [3.5, 0.0, 3.5]);
        assert!(plan.is_some(), "jump-capable table must cross the bridge");
    }
}
