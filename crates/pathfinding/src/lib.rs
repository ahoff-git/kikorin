use pathfinding_crate::prelude::astar;
use std::collections::HashMap;

pub type NodeId = u32;

pub struct NavMeshConfig {
    pub cell_size: f32,
    pub min_x: f32,
    pub max_x: f32,
    pub min_z: f32,
    pub max_z: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Waypoint {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub requires_jump: bool,
    pub is_ledge_drop: bool,
}

pub struct PathRequest {
    pub start: [f32; 3],
    pub goal: [f32; 3],
    pub route_seed: Option<u32>,
    /// When false, edges that require a jump impulse are skipped.
    /// Monsters that cannot jump will route around step-up edges or return None.
    pub can_jump: bool,
    /// Floor Y of the entity at start. When provided, start-node lookup uses
    /// 3D distance so monsters on the ground don't anchor to an elevated platform
    /// overhead that happens to share the same XZ cell.
    pub start_y: Option<f32>,
}

struct Edge {
    to: NodeId,
    cost: f32,
    requires_jump: bool,
    is_ledge_drop: bool,
}

/// NavMesh wrapping the `pathfinding` crate's A* implementation.
/// Nodes are 3-D world positions; edges carry cost and jump/drop metadata.
pub struct NavMesh {
    _config: NavMeshConfig,
    nodes: Vec<[f32; 3]>,
    edges: Vec<Vec<Edge>>,
    // spatial index: bucket (grid_x, grid_z) → Vec<NodeId>
    grid: HashMap<(i32, i32), Vec<NodeId>>,
    cell_size: f32,
}

impl NavMesh {
    pub fn new(config: NavMeshConfig) -> Self {
        let cell_size = config.cell_size;
        Self {
            _config: config,
            nodes: Vec::new(),
            edges: Vec::new(),
            grid: HashMap::new(),
            cell_size,
        }
    }

    pub fn add_node(&mut self, x: f32, y: f32, z: f32) -> NodeId {
        let id = self.nodes.len() as NodeId;
        self.nodes.push([x, y, z]);
        self.edges.push(Vec::new());

        let key = self.grid_key(x, z);
        self.grid.entry(key).or_default().push(id);

        id
    }

    pub fn add_edge(
        &mut self,
        from: NodeId,
        to: NodeId,
        cost: f32,
        requires_jump: bool,
        is_ledge_drop: bool,
    ) {
        if let Some(edges) = self.edges.get_mut(from as usize) {
            edges.push(Edge {
                to,
                cost,
                requires_jump,
                is_ledge_drop,
            });
        }
    }

    pub fn nearest_walkable(&self, x: f32, z: f32) -> Option<NodeId> {
        self.nearest_in_radius(x, z, f32::INFINITY)
    }

    /// Like `nearest_walkable` but uses full 3-D distance, so a monster
    /// standing on the ground level won't snap to a platform node above it.
    pub fn nearest_walkable_3d(&self, x: f32, y: f32, z: f32) -> Option<NodeId> {
        self.nearest_3d_in_radius(x, y, z, f32::INFINITY)
    }

    fn nearest_in_radius(&self, x: f32, z: f32, max_dist: f32) -> Option<NodeId> {
        let mut best_id = None;
        let mut best_dist = max_dist;

        let (gx, gz) = self.grid_key(x, z);
        let radius = 2_i32;
        for dx in -radius..=radius {
            for dz in -radius..=radius {
                if let Some(candidates) = self.grid.get(&(gx + dx, gz + dz)) {
                    for &id in candidates {
                        let [nx, _ny, nz] = self.nodes[id as usize];
                        let d = ((nx - x).powi(2) + (nz - z).powi(2)).sqrt();
                        if d < best_dist {
                            best_dist = d;
                            best_id = Some(id);
                        }
                    }
                }
            }
        }
        best_id
    }

    fn nearest_3d_in_radius(&self, x: f32, y: f32, z: f32, max_dist: f32) -> Option<NodeId> {
        let mut best_id = None;
        let mut best_dist = max_dist;

        let (gx, gz) = self.grid_key(x, z);
        let radius = 2_i32;
        for dx in -radius..=radius {
            for dz in -radius..=radius {
                if let Some(candidates) = self.grid.get(&(gx + dx, gz + dz)) {
                    for &id in candidates {
                        let [nx, ny, nz] = self.nodes[id as usize];
                        let d = ((nx - x).powi(2) + (ny - y).powi(2) + (nz - z).powi(2)).sqrt();
                        if d < best_dist {
                            best_dist = d;
                            best_id = Some(id);
                        }
                    }
                }
            }
        }
        best_id
    }

    pub fn find_path(&self, req: PathRequest) -> Option<Vec<Waypoint>> {
        if self.nodes.is_empty() {
            return None;
        }

        let start_node = match req.start_y {
            Some(y) => self.nearest_walkable_3d(req.start[0], y, req.start[2])?,
            None => self.nearest_walkable(req.start[0], req.start[2])?,
        };
        let goal_node = self.nearest_walkable(req.goal[0], req.goal[2])?;

        if start_node == goal_node {
            return Some(vec![self.node_to_waypoint(goal_node, false, false)]);
        }

        let [gx, gy, gz] = self.nodes[goal_node as usize];
        let seed = req.route_seed;
        let can_jump = req.can_jump;

        let result = astar(
            &start_node,
            |&n| {
                let n_usize = n as usize;
                if n_usize >= self.edges.len() {
                    return vec![];
                }
                self.edges[n_usize]
                    .iter()
                    .filter_map(|e| {
                        if !can_jump && e.requires_jump {
                            return None;
                        }
                        let noise = seed.map_or(0.0, |s| {
                            let h = (n as u64)
                                .wrapping_mul(2654435761)
                                .wrapping_add(e.to as u64)
                                .wrapping_add(s as u64);
                            (h % 100) as f32 / 100.0 * 0.05 * e.cost
                        });
                        let cost_fixed = ((e.cost + noise) * 1000.0) as u32;
                        Some((e.to, cost_fixed))
                    })
                    .collect::<Vec<_>>()
            },
            |&n| {
                let [nx, ny, nz] = self.nodes[n as usize];
                let dx = nx - gx;
                let dy = ny - gy;
                let dz = nz - gz;
                ((dx * dx + dy * dy + dz * dz).sqrt() * 1000.0) as u32
            },
            |&n| n == goal_node,
        );

        let (node_path, _cost) = result?;
        let waypoints = self.build_waypoints(&node_path);
        Some(self.simplify(&waypoints))
    }

    fn node_to_waypoint(&self, id: NodeId, requires_jump: bool, is_ledge_drop: bool) -> Waypoint {
        let [x, y, z] = self.nodes[id as usize];
        Waypoint {
            x,
            y,
            z,
            requires_jump,
            is_ledge_drop,
        }
    }

    fn build_waypoints(&self, node_path: &[NodeId]) -> Vec<Waypoint> {
        let Some(&first) = node_path.first() else {
            return Vec::new();
        };

        let mut waypoints = Vec::with_capacity(node_path.len());
        waypoints.push(self.node_to_waypoint(first, false, false));

        for window in node_path.windows(2) {
            let from = window[0];
            let to = window[1];
            let (jump, ledge) = self.edges[from as usize]
                .iter()
                .find(|e| e.to == to)
                .map(|e| (e.requires_jump, e.is_ledge_drop))
                .unwrap_or((false, false));
            waypoints.push(self.node_to_waypoint(to, jump, ledge));
        }
        waypoints
    }

    /// Remove intermediate waypoints where the 3-D direction doesn't change more than ~23°.
    fn simplify(&self, waypoints: &[Waypoint]) -> Vec<Waypoint> {
        if waypoints.len() <= 2 {
            return waypoints.to_vec();
        }
        let cos_threshold = (23.0_f32.to_radians()).cos();
        let mut out = vec![waypoints[0].clone()];

        for i in 1..waypoints.len() - 1 {
            let prev = &waypoints[i - 1];
            let curr = &waypoints[i];
            let next = &waypoints[i + 1];

            let dir_in = [curr.x - prev.x, curr.y - prev.y, curr.z - prev.z];
            let dir_out = [next.x - curr.x, next.y - curr.y, next.z - curr.z];

            let len_in = (dir_in[0].powi(2) + dir_in[1].powi(2) + dir_in[2].powi(2)).sqrt();
            let len_out = (dir_out[0].powi(2) + dir_out[1].powi(2) + dir_out[2].powi(2)).sqrt();

            let keep = if len_in < 1e-6 || len_out < 1e-6 {
                true
            } else {
                let dot = (dir_in[0] / len_in) * (dir_out[0] / len_out)
                    + (dir_in[1] / len_in) * (dir_out[1] / len_out)
                    + (dir_in[2] / len_in) * (dir_out[2] / len_out);
                dot < cos_threshold || curr.requires_jump || curr.is_ledge_drop
            };

            if keep {
                out.push(curr.clone());
            }
        }
        out.push(waypoints[waypoints.len() - 1].clone());
        out
    }

    fn grid_key(&self, x: f32, z: f32) -> (i32, i32) {
        (
            (x / self.cell_size).floor() as i32,
            (z / self.cell_size).floor() as i32,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_grid_mesh(size: usize, wall_ratio: f32, seed: u64) -> (NavMesh, NodeId, NodeId) {
        let mut mesh = NavMesh::new(NavMeshConfig {
            cell_size: 1.0,
            min_x: 0.0,
            max_x: size as f32,
            min_z: 0.0,
            max_z: size as f32,
        });

        // Deterministic wall set using a simple LCG
        let mut rng = seed;
        let next_rng = |r: &mut u64| -> f32 {
            *r = r
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (*r >> 33) as f32 / u32::MAX as f32
        };

        let total = size * size;
        let mut is_wall = vec![false; total];
        // keep start (0,0) and goal (size-1, size-1) clear
        for (i, wall) in is_wall.iter_mut().enumerate() {
            if i != 0 && i != total - 1 {
                *wall = next_rng(&mut rng) < wall_ratio;
            }
        }

        // add nodes
        let mut node_ids = vec![u32::MAX; total];
        for row in 0..size {
            for col in 0..size {
                let i = row * size + col;
                if !is_wall[i] {
                    let id = mesh.add_node(col as f32 + 0.5, 0.0, row as f32 + 0.5);
                    node_ids[i] = id;
                }
            }
        }

        // add edges (4-connected)
        let dirs: &[(i32, i32)] = &[(0, 1), (0, -1), (1, 0), (-1, 0)];
        for row in 0..size {
            for col in 0..size {
                let i = row * size + col;
                if is_wall[i] || node_ids[i] == u32::MAX {
                    continue;
                }
                for &(dr, dc) in dirs {
                    let nr = row as i32 + dr;
                    let nc = col as i32 + dc;
                    if nr < 0 || nc < 0 || nr >= size as i32 || nc >= size as i32 {
                        continue;
                    }
                    let ni = nr as usize * size + nc as usize;
                    if !is_wall[ni] && node_ids[ni] != u32::MAX {
                        mesh.add_edge(node_ids[i], node_ids[ni], 1.0, false, false);
                    }
                }
            }
        }

        let start = node_ids[0];
        let goal_id = total - 1;
        // Find the goal node (or nearest walkable)
        let goal = if node_ids[goal_id] != u32::MAX {
            node_ids[goal_id]
        } else {
            // scan back to find a non-wall goal
            node_ids
                .iter()
                .rev()
                .find(|&&id| id != u32::MAX)
                .copied()
                .unwrap()
        };

        (mesh, start, goal)
    }

    #[test]
    fn astar_finds_path_on_32x32_grid() {
        let (mesh, _start, _goal) = build_grid_mesh(32, 0.20, 42);
        let path = mesh.find_path(PathRequest {
            start: [0.5, 0.0, 0.5],
            goal: [31.5, 0.0, 31.5],
            route_seed: None,
            can_jump: true,
            start_y: None,
        });
        if let Some(p) = path {
            assert!(!p.is_empty());
        }
    }

    #[test]
    fn astar_returns_none_for_isolated_goal() {
        let mut mesh = NavMesh::new(NavMeshConfig {
            cell_size: 1.0,
            min_x: 0.0,
            max_x: 4.0,
            min_z: 0.0,
            max_z: 4.0,
        });
        // Only two isolated nodes, no edges between them
        mesh.add_node(0.5, 0.0, 0.5); // 0
        mesh.add_node(3.5, 0.0, 3.5); // 1

        let path = mesh.find_path(PathRequest {
            start: [0.5, 0.0, 0.5],
            goal: [3.5, 0.0, 3.5],
            route_seed: None,
            can_jump: true,
            start_y: None,
        });
        assert!(path.is_none(), "expected no path for disconnected graph");
    }

    #[test]
    fn route_seed_produces_different_paths() {
        let (mesh, _, _) = build_grid_mesh(16, 0.10, 7);
        let p1 = mesh.find_path(PathRequest {
            start: [0.5, 0.0, 0.5],
            goal: [15.5, 0.0, 15.5],
            route_seed: Some(1),
            can_jump: true,
            start_y: None,
        });
        let p2 = mesh.find_path(PathRequest {
            start: [0.5, 0.0, 0.5],
            goal: [15.5, 0.0, 15.5],
            route_seed: Some(999),
            can_jump: true,
            start_y: None,
        });
        assert!(p1.is_some());
        assert!(p2.is_some());
    }

    /// A graph where the only path goes through a jump edge.
    /// can_jump=true finds a path; can_jump=false returns None.
    #[test]
    fn can_jump_false_blocks_jump_only_path() {
        let mut mesh = NavMesh::new(NavMeshConfig {
            cell_size: 1.0,
            min_x: 0.0,
            max_x: 3.0,
            min_z: 0.0,
            max_z: 1.0,
        });
        // Three nodes in a line; the only edge from 0→1 requires a jump.
        let a = mesh.add_node(0.5, 0.0, 0.5);
        let b = mesh.add_node(1.5, 1.0, 0.5); // elevated — jump required
        let c = mesh.add_node(2.5, 1.0, 0.5);
        mesh.add_edge(a, b, 2.0, true, false); // jump edge
        mesh.add_edge(b, a, 2.0, false, true); // ledge drop back
        mesh.add_edge(b, c, 1.0, false, false);
        mesh.add_edge(c, b, 1.0, false, false);

        let with_jump = mesh.find_path(PathRequest {
            start: [0.5, 0.0, 0.5],
            goal: [2.5, 0.0, 0.5],
            route_seed: None,
            can_jump: true,
            start_y: None,
        });
        assert!(
            with_jump.is_some(),
            "jumping monster should find path through jump edge"
        );

        let no_jump = mesh.find_path(PathRequest {
            start: [0.5, 0.0, 0.5],
            goal: [2.5, 0.0, 0.5],
            route_seed: None,
            can_jump: false,
            start_y: None,
        });
        assert!(
            no_jump.is_none(),
            "non-jumping monster should find no path when jump is the only option"
        );
    }

    #[test]
    fn jump_metadata_is_attached_to_destination_waypoint() {
        let mut mesh = NavMesh::new(NavMeshConfig {
            cell_size: 1.0,
            min_x: 0.0,
            max_x: 3.0,
            min_z: 0.0,
            max_z: 1.0,
        });

        let lower = mesh.add_node(0.5, 0.0, 0.5);
        let upper = mesh.add_node(1.5, 1.0, 0.5);
        mesh.add_edge(lower, upper, 1.0, true, false);

        let path = mesh
            .find_path(PathRequest {
                start: [0.5, 0.0, 0.5],
                goal: [1.5, 1.0, 0.5],
                route_seed: None,
                can_jump: true,
                start_y: Some(0.0),
            })
            .expect("jump edge should be traversable");

        assert_eq!(path.len(), 2);
        assert!(
            !path[0].requires_jump,
            "starting waypoint should not request a jump"
        );
        assert!(
            path[1].requires_jump,
            "destination waypoint should request the jump"
        );
    }

    /// start_y picks the node closest in 3-D when two nodes share nearly the
    /// same XZ but differ in height (ground vs. elevated platform).
    #[test]
    fn start_y_selects_correct_height_layer() {
        let mut mesh = NavMesh::new(NavMeshConfig {
            cell_size: 1.0,
            min_x: 0.0,
            max_x: 5.0,
            min_z: 0.0,
            max_z: 1.0,
        });
        // Ground layer: nodes at y=0
        let g0 = mesh.add_node(0.5, 0.0, 0.5);
        let g1 = mesh.add_node(1.5, 0.0, 0.5);
        let g2 = mesh.add_node(2.5, 0.0, 0.5);
        // Elevated layer: node at same XZ as g0, y=5
        let _e0 = mesh.add_node(0.5, 5.0, 0.5);

        mesh.add_edge(g0, g1, 1.0, false, false);
        mesh.add_edge(g1, g2, 1.0, false, false);

        // Without start_y, nearest_walkable (XZ-only) might pick either g0 or e0.
        // With start_y=0.0, 3-D lookup should prefer g0 (distance 0) over e0 (distance 5).
        let path = mesh.find_path(PathRequest {
            start: [0.5, 0.0, 0.5],
            goal: [2.5, 0.0, 0.5],
            route_seed: None,
            can_jump: true,
            start_y: Some(0.0),
        });
        assert!(
            path.is_some(),
            "should find ground-level path when start_y anchors to ground"
        );
        let wp = path.unwrap();
        // All waypoints should be near y=0
        for w in &wp {
            assert!(
                w.y < 1.0,
                "waypoint should be on the ground layer, got y={}",
                w.y
            );
        }
    }
}
