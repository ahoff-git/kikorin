use pathfinding_crate::prelude::astar;
use std::collections::HashMap;

pub type NodeId = u32;

/// Node-lookup snap window, in grid cells around the query point (see `nearest_node`).
const SNAP_RADIUS_CELLS: i32 = 2;

// A* runs on integer costs; the edge cost and the heuristic must scale by the
// same factor — if they diverged the heuristic could overestimate and break
// A*'s shortest-path guarantee.
const COST_SCALE: f32 = 1000.0;

// Optional per-request cost jitter so monster groups don't single-file: each
// (node, edge, seed) triple hashes to a deterministic bump of at most this
// fraction of the edge cost — enough to pick between near-equal routes without
// ever preferring a clearly longer one.
const ROUTE_NOISE_MAX_FRACTION: f32 = 0.05;
// Knuth multiplicative hash constant.
const ROUTE_NOISE_HASH_MULT: u64 = 2654435761;

/// Mesh bounds are not part of the config: the spatial index is an unbounded
/// grid hashmap, so the mesh covers wherever nodes are added. Callers own the
/// sampling domain.
pub struct NavMeshConfig {
    pub cell_size: f32,
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
    nodes: Vec<[f32; 3]>,
    edges: Vec<Vec<Edge>>,
    // spatial index: bucket (grid_x, grid_z) → Vec<NodeId>
    grid: HashMap<(i32, i32), Vec<NodeId>>,
    cell_size: f32,
}

impl NavMesh {
    pub fn new(config: NavMeshConfig) -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            grid: HashMap::new(),
            cell_size: config.cell_size,
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
        self.nearest_node(x, None, z)
    }

    /// Like `nearest_walkable` but uses full 3-D distance, so a monster
    /// standing on the ground level won't snap to a platform node above it.
    pub fn nearest_walkable_3d(&self, x: f32, y: f32, z: f32) -> Option<NodeId> {
        self.nearest_node(x, Some(y), z)
    }

    /// Nearest node to the query point; `y = None` compares XZ distance only.
    /// Only nodes within ±SNAP_RADIUS_CELLS grid cells are considered — a query
    /// farther off-mesh than that returns None even if reachable nodes exist
    /// beyond the window.
    fn nearest_node(&self, x: f32, y: Option<f32>, z: f32) -> Option<NodeId> {
        let mut best_id = None;
        let mut best_dist = f32::INFINITY;

        let (gx, gz) = self.grid_key(x, z);
        for dx in -SNAP_RADIUS_CELLS..=SNAP_RADIUS_CELLS {
            for dz in -SNAP_RADIUS_CELLS..=SNAP_RADIUS_CELLS {
                let Some(candidates) = self.grid.get(&(gx + dx, gz + dz)) else {
                    continue;
                };
                for &id in candidates {
                    let [nx, ny, nz] = self.nodes[id as usize];
                    let dy = y.map_or(0.0, |y| ny - y);
                    let d = ((nx - x).powi(2) + dy.powi(2) + (nz - z).powi(2)).sqrt();
                    if d < best_dist {
                        best_dist = d;
                        best_id = Some(id);
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
                                .wrapping_mul(ROUTE_NOISE_HASH_MULT)
                                .wrapping_add(e.to as u64)
                                .wrapping_add(s as u64);
                            (h % 100) as f32 / 100.0 * ROUTE_NOISE_MAX_FRACTION * e.cost
                        });
                        let cost_fixed = ((e.cost + noise) * COST_SCALE) as u32;
                        Some((e.to, cost_fixed))
                    })
                    .collect::<Vec<_>>()
            },
            |&n| {
                let [nx, ny, nz] = self.nodes[n as usize];
                let dx = nx - gx;
                let dy = ny - gy;
                let dz = nz - gz;
                ((dx * dx + dy * dy + dz * dz).sqrt() * COST_SCALE) as u32
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
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });

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
        // A* must agree with BFS ground-truth reachability on the same graph —
        // random walls may or may not disconnect the corners for a given seed,
        // so reachability is computed, not assumed.
        let (mesh, start, goal) = build_grid_mesh(32, 0.20, 42);

        let mut seen = vec![false; mesh.nodes.len()];
        let mut queue = std::collections::VecDeque::from([start]);
        seen[start as usize] = true;
        while let Some(n) = queue.pop_front() {
            for e in &mesh.edges[n as usize] {
                if !seen[e.to as usize] {
                    seen[e.to as usize] = true;
                    queue.push_back(e.to);
                }
            }
        }
        let reachable = seen[goal as usize];

        let [sx, _, sz] = mesh.nodes[start as usize];
        let [gx, _, gz] = mesh.nodes[goal as usize];
        let path = mesh.find_path(PathRequest {
            start: [sx, 0.0, sz],
            goal: [gx, 0.0, gz],
            route_seed: None,
            can_jump: true,
            start_y: None,
        });

        assert_eq!(
            path.is_some(),
            reachable,
            "A* must find a path exactly when BFS says the goal is reachable",
        );
        if let Some(p) = path {
            let last = p.last().unwrap();
            assert_eq!((last.x, last.z), (gx, gz), "path must end at the goal node");
        }
    }

    #[test]
    fn astar_returns_none_for_isolated_goal() {
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
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
        // The noise is a small deterministic tie-breaker, so any single seed pair
        // may legitimately pick the same optimal route; the contract is that seed
        // variety exists — some seed must diverge from the baseline.
        let (mesh, _, _) = build_grid_mesh(16, 0.10, 7);
        let request = |seed: u32| PathRequest {
            start: [0.5, 0.0, 0.5],
            goal: [15.5, 0.0, 15.5],
            route_seed: Some(seed),
            can_jump: true,
            start_y: None,
        };

        let base = mesh.find_path(request(1)).expect("seeded path must exist");
        let diverged = (2..=20).any(|s| {
            mesh.find_path(request(s)).expect("seeded path must exist") != base
        });
        assert!(
            diverged,
            "at least one seed in 2..=20 must produce a route different from seed 1",
        );
    }

    /// simplify() drops intermediate waypoints on a straight segment.
    #[test]
    fn simplify_collapses_collinear_waypoints() {
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
        // Five collinear nodes in a chain — only the endpoints should survive.
        let ids: Vec<NodeId> = (0..5)
            .map(|i| mesh.add_node(i as f32 + 0.5, 0.0, 0.5))
            .collect();
        for w in ids.windows(2) {
            mesh.add_edge(w[0], w[1], 1.0, false, false);
        }

        let path = mesh
            .find_path(PathRequest {
                start: [0.5, 0.0, 0.5],
                goal: [4.5, 0.0, 0.5],
                route_seed: None,
                can_jump: true,
                start_y: None,
            })
            .expect("straight chain must have a path");

        assert_eq!(
            path.len(),
            2,
            "collinear intermediates should be simplified away: {path:?}"
        );
    }

    /// Jump waypoints are never simplified away, even when perfectly collinear —
    /// the follower needs the jump flag at the exact takeoff-destination node.
    #[test]
    fn simplify_preserves_jump_waypoints() {
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
        let ids: Vec<NodeId> = (0..4)
            .map(|i| mesh.add_node(i as f32 + 0.5, 0.0, 0.5))
            .collect();
        mesh.add_edge(ids[0], ids[1], 1.0, false, false);
        mesh.add_edge(ids[1], ids[2], 1.0, true, false); // jump edge, collinear
        mesh.add_edge(ids[2], ids[3], 1.0, false, false);

        let path = mesh
            .find_path(PathRequest {
                start: [0.5, 0.0, 0.5],
                goal: [3.5, 0.0, 0.5],
                route_seed: None,
                can_jump: true,
                start_y: None,
            })
            .expect("chain with jump edge must have a path");

        let jump_wp = path
            .iter()
            .find(|wp| wp.requires_jump)
            .expect("jump waypoint must survive simplification");
        assert_eq!(
            (jump_wp.x, jump_wp.z),
            (2.5, 0.5),
            "jump flag must stay on the jump edge's destination node"
        );
    }

    /// A graph where the only path goes through a jump edge.
    /// can_jump=true finds a path; can_jump=false returns None.
    #[test]
    fn can_jump_false_blocks_jump_only_path() {
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
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
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });

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
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
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
