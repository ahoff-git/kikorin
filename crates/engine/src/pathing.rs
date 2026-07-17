//! Shared pathing state: the layered-pathfinding caches (flow fields, key
//! routes), the heavy work queue, Tier-4 promotions, and the shared route
//! pool. Mechanics and rationale live in specs/engine + ADR 0011.

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use pathfinding::{FlowField, KeyRoutes, NodeId, Waypoint};

/// (can_jump, can_sprint, can_phase) — the capability tuple caches are keyed by.
pub(crate) type CapKey = (bool, bool, bool);
/// (goal node, can_jump, can_sprint, can_phase) — flow field identity. Keyed on the
/// fine navmesh node, never a key node (ADR 0011).
pub(crate) type FlowKey = (NodeId, bool, bool, bool);

/// Resumable background jobs — one bounded slice runs per tick.
pub(crate) enum HeavyJob {
    BuildFlowField {
        key: FlowKey,
    },
    /// One field built per slice; re-queued until all keys are done.
    BuildKeyRoutes {
        cap: CapKey,
        keys: Vec<NodeId>,
        fields: Vec<FlowField>,
    },
    /// Tier-4 discovery sweep over frontier nodes only (built on the first
    /// slice); cursor = next frontier index.
    DiscoverEdges {
        frontier: Vec<NodeId>,
        cursor: usize,
    },
}

/// A Tier-4 discovery awaiting the tick-boundary flush (ADR 0011: graph
/// mutations never land mid-tick).
pub(crate) struct PendingPromotion {
    pub from: NodeId,
    pub to: NodeId,
    pub cost: f32,
    pub requires_sprint: bool,
}

/// A route one monster computed, shareable by others (route splicing).
pub(crate) struct SharedRoute {
    pub waypoints: Vec<Waypoint>,
    pub goal: [f32; 2],
}

const MAX_POOLED_ROUTES: usize = 8;
const MAX_FLOW_FIELDS: usize = 32;
/// Heavy-slice time target — an eighth of the 4 ms sim step.
const TARGET_SLICE_MS: f32 = 0.5;
const MIN_SLICE_UNITS: u32 = 32;
const MAX_SLICE_UNITS: u32 = 8192;

pub(crate) struct PathingShared {
    pub flow_fields: HashMap<FlowKey, Rc<FlowField>>,
    pub key_routes: HashMap<CapKey, KeyRoutes>,
    pub jobs: VecDeque<HeavyJob>,
    pub queued_flow: HashSet<FlowKey>,
    pub queued_caps: HashSet<CapKey>,
    pub discover_pending: bool,
    pub promotions: Vec<PendingPromotion>,
    pub route_pool: VecDeque<Rc<SharedRoute>>,
    /// Adaptive work units per tick slice, calibrated from measured time.
    pub slice_units: u32,
}

impl PathingShared {
    pub fn new() -> Self {
        Self {
            flow_fields: HashMap::new(),
            key_routes: HashMap::new(),
            jobs: VecDeque::new(),
            queued_flow: HashSet::new(),
            queued_caps: HashSet::new(),
            discover_pending: false,
            promotions: Vec::new(),
            route_pool: VecDeque::new(),
            slice_units: 256,
        }
    }

    /// Full reset — terrain changed, so every cache and queued job is
    /// stale. Called by load_map/build_navmesh; also (re)queues discovery.
    pub fn reset_for_new_terrain(&mut self) {
        self.flow_fields.clear();
        self.key_routes.clear();
        self.jobs.clear();
        self.queued_flow.clear();
        self.queued_caps.clear();
        self.promotions.clear();
        self.route_pool.clear();
        self.jobs.push_back(HeavyJob::DiscoverEdges { frontier: Vec::new(), cursor: 0 });
        self.discover_pending = true;
    }

    pub fn enqueue_flow_field(&mut self, key: FlowKey) {
        if self.queued_flow.insert(key) {
            self.jobs.push_back(HeavyJob::BuildFlowField { key });
        }
    }

    pub fn enqueue_key_routes(&mut self, cap: CapKey, keys: Vec<NodeId>) {
        if !keys.is_empty() && self.queued_caps.insert(cap) {
            self.jobs.push_back(HeavyJob::BuildKeyRoutes {
                cap,
                keys,
                fields: Vec::new(),
            });
        }
    }

    /// Cap the field cache; evicting all is fine — fields rebuild on demand.
    pub fn insert_flow_field(&mut self, key: FlowKey, field: FlowField) {
        if self.flow_fields.len() >= MAX_FLOW_FIELDS {
            self.flow_fields.clear();
        }
        self.queued_flow.remove(&key);
        self.flow_fields.insert(key, Rc::new(field));
    }

    /// Pool a route worth sharing — gated by world length, not waypoint
    /// count (simplify collapses long straight routes to 2-3 waypoints).
    pub fn pool_route(&mut self, waypoints: Vec<Waypoint>, goal: [f32; 2], min_len: f32) {
        let len: f32 = waypoints
            .windows(2)
            .map(|w| (w[1].x - w[0].x).hypot(w[1].z - w[0].z))
            .sum();
        if waypoints.len() < 2 || len < min_len {
            return;
        }
        if self.route_pool.len() >= MAX_POOLED_ROUTES {
            self.route_pool.pop_front();
        }
        self.route_pool.push_back(Rc::new(SharedRoute { waypoints, goal }));
    }

    /// A pooled route usable from near (x, z) toward `goal`: its own goal
    /// must still match (staleness guard reusing replan_stale_dist), some
    /// waypoint must be within `splice_radius`, and the route must demand
    /// nothing beyond the splicer's capability — a route computed BY a
    /// jumper/sprinter contains waypoints a weaker splicer would genuinely
    /// attempt and fail (the ADR 0006/0008 stranding class). Returns
    /// (route, index of the splice-on waypoint).
    pub fn find_splice(
        &self,
        x: f32,
        z: f32,
        goal: [f32; 2],
        splice_radius: f32,
        goal_tolerance: f32,
        can_jump: bool,
        can_sprint: bool,
        can_phase: bool,
    ) -> Option<(Rc<SharedRoute>, usize)> {
        let splice_sq = splice_radius * splice_radius;
        let goal_sq = goal_tolerance * goal_tolerance;
        for route in self.route_pool.iter().rev() {
            let dg = (route.goal[0] - goal[0]).powi(2) + (route.goal[1] - goal[1]).powi(2);
            if dg > goal_sq {
                continue;
            }
            let too_demanding = route.waypoints.iter().any(|wp| {
                (!can_jump && wp.requires_jump)
                    || (!can_sprint && wp.requires_sprint)
                    || (!can_phase && wp.requires_phase)
            });
            if too_demanding {
                continue;
            }
            let hit = route.waypoints.iter().position(|wp| {
                (wp.x - x).powi(2) + (wp.z - z).powi(2) <= splice_sq
            });
            if let Some(i) = hit {
                return Some((Rc::clone(route), i));
            }
        }
        None
    }

    /// Adapt the slice size toward TARGET_SLICE_MS from a measured run.
    pub fn tune_slice(&mut self, elapsed_ms: f32) {
        if elapsed_ms > TARGET_SLICE_MS {
            self.slice_units = (self.slice_units / 2).max(MIN_SLICE_UNITS);
        } else if elapsed_ms < TARGET_SLICE_MS * 0.5 {
            self.slice_units = (self.slice_units + self.slice_units / 4).min(MAX_SLICE_UNITS);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wp(x: f32, z: f32) -> Waypoint {
        Waypoint {
            x,
            y: 0.0,
            z,
            requires_jump: false,
            requires_sprint: false,
            requires_phase: false,
            is_ledge_drop: false,
        }
    }

    #[test]
    fn splice_requires_both_goal_match_and_waypoint_proximity() {
        let mut shared = PathingShared::new();
        shared.pool_route(
            vec![wp(0.0, 0.0), wp(2.0, 0.0), wp(4.0, 0.0), wp(6.0, 0.0)],
            [6.0, 0.0],
            5.0,
        );

        // Near waypoint 1, same goal → splice at index 1.
        let hit = shared.find_splice(2.2, 0.1, [6.0, 0.0], 1.0, 4.0, true, true, true);
        assert!(matches!(hit, Some((_, 1))));

        // Same position, distant goal → stale, no splice.
        assert!(shared.find_splice(2.2, 0.1, [50.0, 0.0], 1.0, 4.0, true, true, true).is_none());

        // Matching goal but nowhere near the route → no splice.
        assert!(shared.find_splice(20.0, 20.0, [6.0, 0.0], 1.0, 4.0, true, true, true).is_none());
    }

    #[test]
    fn splice_never_offers_a_route_beyond_the_splicer_capability() {
        let mut shared = PathingShared::new();
        let mut jump_wp = wp(4.0, 0.0);
        jump_wp.requires_jump = true;
        shared.pool_route(vec![wp(0.0, 0.0), wp(2.0, 0.0), jump_wp, wp(6.0, 0.0)], [6.0, 0.0], 5.0);

        // A jumper may splice; a non-jumper must never be offered a route
        // whose remainder demands a jump it would genuinely attempt.
        assert!(shared.find_splice(0.2, 0.0, [6.0, 0.0], 1.0, 4.0, true, false, true).is_some());
        assert!(shared.find_splice(0.2, 0.0, [6.0, 0.0], 1.0, 4.0, false, false, true).is_none());

        let mut sprint_wp = wp(4.0, 2.0);
        sprint_wp.requires_jump = true;
        sprint_wp.requires_sprint = true;
        shared.pool_route(vec![wp(0.0, 2.0), wp(2.0, 2.0), sprint_wp, wp(6.0, 2.0)], [6.0, 2.0], 5.0);
        assert!(shared.find_splice(0.2, 2.0, [6.0, 2.0], 1.0, 4.0, true, true, true).is_some());
        assert!(shared.find_splice(0.2, 2.0, [6.0, 2.0], 1.0, 4.0, true, false, true).is_none());
    }

    #[test]
    fn short_routes_are_not_pooled() {
        let mut shared = PathingShared::new();
        shared.pool_route(vec![wp(0.0, 0.0), wp(1.0, 0.0)], [1.0, 0.0], 5.0);
        assert!(shared.route_pool.is_empty());
        // Few waypoints but real length (a simplified straight haul) DOES pool.
        shared.pool_route(vec![wp(0.0, 0.0), wp(12.0, 0.0)], [12.0, 0.0], 5.0);
        assert_eq!(shared.route_pool.len(), 1);
    }

    #[test]
    fn slice_tuning_shrinks_on_overrun_and_grows_when_cheap() {
        let mut shared = PathingShared::new();
        let start = shared.slice_units;
        shared.tune_slice(TARGET_SLICE_MS * 2.0);
        assert!(shared.slice_units < start);
        let shrunk = shared.slice_units;
        shared.tune_slice(TARGET_SLICE_MS * 0.1);
        assert!(shared.slice_units > shrunk);
        for _ in 0..64 {
            shared.tune_slice(TARGET_SLICE_MS * 10.0);
        }
        assert_eq!(shared.slice_units, MIN_SLICE_UNITS, "must clamp at the floor");
    }

    #[test]
    fn enqueue_dedups_by_key() {
        let mut shared = PathingShared::new();
        shared.enqueue_flow_field((7, true, false, false));
        shared.enqueue_flow_field((7, true, false, false));
        assert_eq!(shared.jobs.len(), 1);
        shared.enqueue_key_routes((true, false, false), vec![1, 2]);
        shared.enqueue_key_routes((true, false, false), vec![1, 2]);
        assert_eq!(shared.jobs.len(), 2);
    }
}
