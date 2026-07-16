use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::{NavMesh, NodeId, COST_SCALE};

const UNREACHABLE: u64 = u64::MAX;

/// One step of a flow field: the forward neighbor to move toward, with the
/// forward edge's traversal metadata.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlowHop {
    pub to: NodeId,
    pub requires_jump: bool,
    pub requires_sprint: bool,
    pub is_ledge_drop: bool,
}

/// Shared next-hop table toward one goal node, built with a single reverse
/// Dijkstra — the crowd-chase and baked-route primitive (see
/// specs/pathfinding). Capability-filtered at build time; per-monster
/// lookups are O(1).
pub struct FlowField {
    goal_node: NodeId,
    next_hop: Vec<Option<FlowHop>>,
    dist: Vec<u64>,
}

impl FlowField {
    pub fn goal_node(&self) -> NodeId {
        self.goal_node
    }

    pub fn next_hop(&self, from: NodeId) -> Option<FlowHop> {
        self.next_hop.get(from as usize).copied().flatten()
    }

    /// Path cost from `from` to the goal; None = unreachable under the
    /// capability this field was built with.
    pub fn distance(&self, from: NodeId) -> Option<f32> {
        let d = *self.dist.get(from as usize)?;
        (d != UNREACHABLE).then_some(d as f32 / COST_SCALE)
    }

    pub fn reaches(&self, from: NodeId) -> bool {
        self.distance(from).is_some()
    }
}

impl NavMesh {
    /// Flow field toward the node nearest `goal` (XZ snap, matching
    /// `find_path`'s goal handling). None only when the mesh is empty or
    /// the goal snaps to nothing.
    pub fn build_flow_field(
        &self,
        goal: [f32; 3],
        can_jump: bool,
        can_sprint: bool,
    ) -> Option<FlowField> {
        let goal_node = self.nearest_walkable(goal[0], goal[2])?;
        Some(self.flow_field_from_node(goal_node, can_jump, can_sprint))
    }

    /// Field toward an exact node — the resumable-build entry point (one
    /// Dijkstra per call; KeyRoutes builds spread these across ticks).
    pub fn flow_field_to_node(
        &self,
        goal_node: NodeId,
        can_jump: bool,
        can_sprint: bool,
    ) -> FlowField {
        self.flow_field_from_node(goal_node, can_jump, can_sprint)
    }

    pub(crate) fn flow_field_from_node(
        &self,
        goal_node: NodeId,
        can_jump: bool,
        can_sprint: bool,
    ) -> FlowField {
        let n = self.nodes.len();
        // Reverse adjacency: for forward edge v→u, rev[u] holds (v, cost, meta).
        // One-way edges (ledge drops) reverse correctly here: a node only
        // enterable by dropping in simply ends up unreachable in fields
        // whose goal lies back up top — safe degrade, no special case.
        let mut rev: Vec<Vec<(NodeId, u64, bool, bool, bool)>> = vec![Vec::new(); n];
        for (from, edges) in self.edges.iter().enumerate() {
            for e in edges {
                if (!can_jump && e.requires_jump) || (!can_sprint && e.requires_sprint) {
                    continue;
                }
                let cost = (e.cost * COST_SCALE) as u64;
                rev[e.to as usize].push((
                    from as NodeId,
                    cost,
                    e.requires_jump,
                    e.requires_sprint,
                    e.is_ledge_drop,
                ));
            }
        }

        let mut dist = vec![UNREACHABLE; n];
        let mut next_hop: Vec<Option<FlowHop>> = vec![None; n];
        let mut heap = BinaryHeap::new();
        if (goal_node as usize) < n {
            dist[goal_node as usize] = 0;
            heap.push(Reverse((0u64, goal_node)));
        }
        while let Some(Reverse((d, u))) = heap.pop() {
            if d > dist[u as usize] {
                continue;
            }
            for &(v, cost, jump, sprint, ledge) in &rev[u as usize] {
                let nd = d.saturating_add(cost);
                if nd < dist[v as usize] {
                    dist[v as usize] = nd;
                    next_hop[v as usize] = Some(FlowHop {
                        to: u,
                        requires_jump: jump,
                        requires_sprint: sprint,
                        is_ledge_drop: ledge,
                    });
                    heap.push(Reverse((nd, v)));
                }
            }
        }

        FlowField {
            goal_node,
            next_hop,
            dist,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{NavMesh, NavMeshConfig, NodeId};

    /// Open size×size grid, 4-connected, unit costs. Node id = row*size+col.
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
    fn following_hops_from_anywhere_reaches_the_goal_with_decreasing_distance() {
        let size = 8;
        let mesh = open_grid(size);
        let goal = [0.5, 0.0, 0.5];
        let field = mesh.build_flow_field(goal, true, false).expect("field");

        for start in 0..(size * size) as NodeId {
            let mut cur = start;
            let mut prev_dist = field.distance(cur).expect("open grid: all reachable");
            for _ in 0..(size * size) {
                if cur == field.goal_node() {
                    break;
                }
                let hop = field.next_hop(cur).expect("non-goal node must have a hop");
                cur = hop.to;
                let d = field.distance(cur).expect("hop target must be reachable");
                assert!(d < prev_dist, "distance must strictly decrease along hops");
                prev_dist = d;
            }
            assert_eq!(cur, field.goal_node(), "hops from {start} must reach the goal");
        }
    }

    #[test]
    fn field_routes_around_a_wall_gap() {
        // 5x5 grid with a wall along col 2 (nodes removed) except row 4 —
        // hops from the left half must detour through the gap, never teleport.
        let size = 5i32;
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
        let mut ids = vec![None; (size * size) as usize];
        for row in 0..size {
            for col in 0..size {
                if col == 2 && row != 4 {
                    continue;
                }
                ids[(row * size + col) as usize] =
                    Some(mesh.add_node(col as f32 + 0.5, 0.0, row as f32 + 0.5));
            }
        }
        let dirs: &[(i32, i32)] = &[(0, 1), (0, -1), (1, 0), (-1, 0)];
        for row in 0..size {
            for col in 0..size {
                let Some(from) = ids[(row * size + col) as usize] else { continue };
                for &(dr, dc) in dirs {
                    let (nr, nc) = (row + dr, col + dc);
                    if nr < 0 || nc < 0 || nr >= size || nc >= size {
                        continue;
                    }
                    if let Some(to) = ids[(nr * size + nc) as usize] {
                        mesh.add_edge(from, to, 1.0, false, false);
                    }
                }
            }
        }

        // Goal on the right side, start on the left side, both at row 0.
        let field = mesh.build_flow_field([4.5, 0.0, 0.5], true, false).expect("field");
        let start = ids[0].unwrap();
        let direct_hops = 4; // manhattan without the wall
        let mut cur = start;
        let mut hops = 0;
        while cur != field.goal_node() {
            cur = field.next_hop(cur).expect("reachable").to;
            hops += 1;
            assert!(hops < 100, "must terminate");
        }
        assert!(
            hops > direct_hops,
            "route must detour through the row-4 gap, got {hops} hops",
        );
    }

    #[test]
    fn can_jump_filter_makes_jump_bridged_regions_unreachable() {
        // Two nodes joined only by a jump edge toward the goal side.
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
        let a = mesh.add_node(0.5, 0.0, 0.5);
        let b = mesh.add_node(1.5, 1.0, 0.5);
        mesh.add_edge(a, b, 1.0, true, false);

        let jumping = mesh.build_flow_field([1.5, 0.0, 0.5], true, false).expect("field");
        assert!(jumping.reaches(a), "jump-capable field crosses the bridge");
        assert_eq!(jumping.next_hop(a).unwrap().to, b);
        assert!(jumping.next_hop(a).unwrap().requires_jump, "hop must carry jump metadata");

        let grounded = mesh.build_flow_field([1.5, 0.0, 0.5], false, false).expect("field");
        assert!(
            !grounded.reaches(a),
            "can_jump:false field must mark the far side unreachable, not mislead it",
        );
        assert!(grounded.next_hop(a).is_none());
    }

    #[test]
    fn one_way_ledge_drop_degrades_to_unreachable_on_the_return_direction() {
        // high --drop--> low, no way back up. Field toward high: low is
        // correctly unreachable (no forward path), no panic, no bogus hop.
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
        let high = mesh.add_node(0.5, 3.0, 0.5);
        let low = mesh.add_node(1.5, 0.0, 0.5);
        mesh.add_edge(high, low, 1.0, false, true);

        let field_to_high = mesh.build_flow_field([0.5, 0.0, 0.5], true, false).expect("field");
        assert!(field_to_high.reaches(high), "the goal itself is reachable");
        assert!(!field_to_high.reaches(low), "no forward path back up the ledge");

        let field_to_low = mesh.build_flow_field([1.5, 0.0, 0.5], true, false).expect("field");
        assert!(field_to_low.reaches(high), "dropping down is a valid forward hop");
        assert!(field_to_low.next_hop(high).unwrap().is_ledge_drop);
    }

    #[test]
    fn sprint_edges_are_filtered_unless_capable() {
        let mut mesh = NavMesh::new(NavMeshConfig { cell_size: 1.0 });
        let a = mesh.add_node(0.5, 0.0, 0.5);
        let b = mesh.add_node(3.5, 0.0, 0.5);
        mesh.upgrade_edge(a, b, 3.0, true);

        let sprinter = mesh.build_flow_field([3.5, 0.0, 0.5], true, true).expect("field");
        assert!(sprinter.reaches(a));
        assert!(sprinter.next_hop(a).unwrap().requires_sprint);

        let walker = mesh.build_flow_field([3.5, 0.0, 0.5], true, false).expect("field");
        assert!(!walker.reaches(a), "sprint-only edge must not serve a non-sprinter");
    }
}
