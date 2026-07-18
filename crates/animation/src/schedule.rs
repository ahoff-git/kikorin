//! Time-fitting: turn a family's frame specs into a concrete timeline, stretched
//! or cut short to hit a target duration when one is given.
//!
//! Fitting rules (driven by the per-frame flags):
//!   - no target        → every frame plays its `optimal_ms`.
//!   - target < natural  → shrink flexible frames toward `min_ms` (proportional
//!     to each frame's room); if that isn't enough, drop `skippable` frames in
//!     order. If still short, accept a timeline longer than the target.
//!   - target > natural  → stretch flexible frames toward `max_ms` (proportional
//!     to room). If frames can't absorb it all, accept a shorter timeline.
//! "Stretchable" is just `max_ms > optimal_ms`; "shrinkable" is `min_ms <
//! optimal_ms`; only skipping needs an explicit flag.

use crate::FrameSpec;

const EPS: f32 = 1e-3;

/// One frame's slice of the timeline. Dropped (skipped) frames produce no slot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameSlot {
    /// Index into the family's `frames`.
    pub frame: usize,
    pub start_ms: f32,
    pub end_ms: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Schedule {
    pub slots: Vec<FrameSlot>,
    pub total_ms: f32,
}

pub fn schedule_frames(frames: &[FrameSpec], target_ms: Option<f32>) -> Schedule {
    let n = frames.len();
    let mut dur: Vec<f32> = frames.iter().map(|f| f.optimal_ms.max(0.0)).collect();
    let mut kept: Vec<bool> = vec![true; n];

    if let Some(target) = target_ms {
        let target = target.max(0.0);
        let base: f32 = dur.iter().sum();

        if target + EPS < base {
            let mut deficit = base - target;

            // 1) shrink toward min, proportional to each frame's available room.
            let room: f32 = frames.iter().map(|f| (f.optimal_ms - f.min_ms).max(0.0)).sum();
            if room > EPS {
                let take = deficit.min(room);
                for (i, f) in frames.iter().enumerate() {
                    let r = (f.optimal_ms - f.min_ms).max(0.0);
                    if r > 0.0 {
                        dur[i] -= take * (r / room);
                    }
                }
                deficit -= take;
            }

            // 2) still too long → drop skippable frames (in order) until it fits.
            if deficit > EPS {
                for i in 0..n {
                    if deficit <= EPS {
                        break;
                    }
                    if frames[i].skippable && kept[i] {
                        deficit -= dur[i];
                        dur[i] = 0.0;
                        kept[i] = false;
                    }
                }
            }
            // else: can't fully meet the target — accept a longer timeline.
        } else if target > base + EPS {
            // stretch toward max, proportional to room.
            let surplus = target - base;
            let room: f32 = frames.iter().map(|f| (f.max_ms - f.optimal_ms).max(0.0)).sum();
            if room > EPS {
                let add = surplus.min(room);
                for (i, f) in frames.iter().enumerate() {
                    let r = (f.max_ms - f.optimal_ms).max(0.0);
                    if r > 0.0 {
                        dur[i] += add * (r / room);
                    }
                }
            }
            // else: nothing can stretch — accept a shorter timeline.
        }
    }

    let mut slots = Vec::with_capacity(n);
    let mut t = 0.0;
    for i in 0..n {
        if !kept[i] {
            continue;
        }
        let d = dur[i].max(0.0);
        slots.push(FrameSlot { frame: i, start_ms: t, end_ms: t + d });
        t += d;
    }
    // Never produce an empty timeline: fall back to the first frame held at 0ms.
    if slots.is_empty() && n > 0 {
        slots.push(FrameSlot { frame: 0, start_ms: 0.0, end_ms: 0.0 });
    }

    Schedule { slots, total_ms: t }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flex(optimal: f32, min: f32, max: f32, skippable: bool) -> FrameSpec {
        FrameSpec {
            optimal_ms: optimal,
            min_ms: min,
            max_ms: max,
            skippable,
            cancelable: false,
            hitbox: None,
            hurtbox: None,
            event: None,
        }
    }

    #[test]
    fn no_target_uses_optimal() {
        let f = vec![FrameSpec::fixed(100.0), FrameSpec::fixed(100.0)];
        let s = schedule_frames(&f, None);
        assert_eq!(s.total_ms, 200.0);
        assert_eq!(s.slots.len(), 2);
        assert_eq!(s.slots[1].start_ms, 100.0);
    }

    #[test]
    fn shrinks_toward_min_when_cut() {
        // 2×100 optimal, each shrinkable to 50. Target 150 → each becomes 75.
        let f = vec![flex(100.0, 50.0, 100.0, false), flex(100.0, 50.0, 100.0, false)];
        let s = schedule_frames(&f, Some(150.0));
        assert!((s.total_ms - 150.0).abs() < 1e-2);
        assert!((s.slots[0].end_ms - 75.0).abs() < 1e-2);
    }

    #[test]
    fn drops_skippable_when_shrink_isnt_enough() {
        // Rigid 100 + skippable 100 (not shrinkable). Target 100 → drop the skippable.
        let f = vec![FrameSpec::fixed(100.0), flex(100.0, 100.0, 100.0, true)];
        let s = schedule_frames(&f, Some(100.0));
        assert_eq!(s.slots.len(), 1);
        assert_eq!(s.slots[0].frame, 0);
        assert!((s.total_ms - 100.0).abs() < 1e-2);
    }

    #[test]
    fn stretches_toward_max() {
        let f = vec![flex(100.0, 100.0, 200.0, false), flex(100.0, 100.0, 200.0, false)];
        let s = schedule_frames(&f, Some(300.0));
        assert!((s.total_ms - 300.0).abs() < 1e-2);
        assert!((s.slots[0].end_ms - 150.0).abs() < 1e-2);
    }

    #[test]
    fn stretch_capped_at_max_accepts_shorter() {
        // Can stretch at most to 2×150=300 though target is 500.
        let f = vec![flex(100.0, 100.0, 150.0, false), flex(100.0, 100.0, 150.0, false)];
        let s = schedule_frames(&f, Some(500.0));
        assert!((s.total_ms - 300.0).abs() < 1e-2);
    }
}
