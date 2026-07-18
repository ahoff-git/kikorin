//! Per-entity playback state: which family is playing, how far into it, what's
//! queued, and the interruptibility rules that decide whether a new request
//! takes effect now, waits, or is dropped.

use crate::schedule::{schedule_frames, Schedule};
use crate::{AnimationSet, Interrupt};

pub struct AnimationInstance {
    family: usize,
    schedule: Schedule,
    elapsed_ms: f32,
    /// A request that couldn't interrupt now but should start when this ends.
    pending: Option<(usize, Option<f32>)>,
    /// One-shot reached its end (holding the last frame, awaiting a transition).
    finished: bool,
    /// Frame shown at the end of the previous advance — a change signals a
    /// newly-entered frame, which is when a frame event fires (once).
    last_frame: Option<usize>,
}

impl AnimationInstance {
    pub fn new(set: &AnimationSet, family: usize, target_ms: Option<f32>) -> Self {
        let mut me = Self {
            family,
            schedule: Schedule::default(),
            elapsed_ms: 0.0,
            pending: None,
            finished: false,
            last_frame: None,
        };
        me.start(set, family, target_ms);
        me
    }

    pub fn family(&self) -> usize {
        self.family
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn current_frame(&self) -> usize {
        let e = self.elapsed_ms;
        for slot in &self.schedule.slots {
            if e < slot.end_ms {
                return slot.frame;
            }
        }
        self.schedule.slots.last().map(|s| s.frame).unwrap_or(0)
    }

    fn start(&mut self, set: &AnimationSet, family: usize, target_ms: Option<f32>) {
        self.family = family;
        self.schedule = schedule_frames(&set.families[family].frames, target_ms);
        self.elapsed_ms = 0.0;
        self.finished = false;
        self.pending = None;
        // Frame 0 of the new family is entered fresh — let its event fire.
        self.last_frame = None;
    }

    fn can_interrupt_now(&self, set: &AnimationSet) -> bool {
        if self.finished {
            return true;
        }
        let fam = &set.families[self.family];
        match fam.interrupt {
            Interrupt::Always => true,
            // Block / Queue can still be cut during a frame flagged as a cancel window.
            Interrupt::Block | Interrupt::Queue => {
                fam.frames.get(self.current_frame()).map(|f| f.cancelable).unwrap_or(false)
            }
        }
    }

    /// Request a family. Interrupts immediately when allowed (Always policy, a
    /// cancel-window frame, or the current one has finished); queues it under a
    /// Queue policy; drops it under Block. Re-requesting the family already
    /// playing is a no-op (it won't restart) unless that family has finished.
    pub fn request(&mut self, set: &AnimationSet, family: usize, target_ms: Option<f32>) {
        if family == self.family && !self.finished {
            return;
        }
        if self.can_interrupt_now(set) {
            self.start(set, family, target_ms);
        } else if set.families[self.family].interrupt == Interrupt::Queue {
            self.pending = Some((family, target_ms));
        }
        // Block with no cancel window: ignored.
    }

    /// Force-restart a family from frame 0 regardless of interrupt policy — the
    /// engine uses this for an explicit retrigger (a bumped action sequence).
    pub fn restart(&mut self, set: &AnimationSet, family: usize, target_ms: Option<f32>) {
        self.start(set, family, target_ms);
    }

    /// Advance the clock by `dt_ms`. Returns the event id of a frame *entered*
    /// this call (once, when it becomes the shown frame), else None — the
    /// frame-synced "call this function after this frame" hook (ADR 0017).
    pub fn advance(&mut self, set: &AnimationSet, dt_ms: f32) -> Option<u16> {
        if dt_ms > 0.0 {
            self.elapsed_ms += dt_ms;
        }
        let total = self.schedule.total_ms;
        let looping = set.families[self.family].looping;

        // Branch: a queued action splits off at the family's branch frame instead
        // of waiting for the end (ADR 0016). Only a Queue policy ever sets pending.
        if self.pending.is_some() {
            if let Some(bf) = set.families[self.family].branch_frame {
                if self.current_frame() >= bf {
                    let (fam, target) = self.pending.take().unwrap();
                    self.start(set, fam, target);
                    return self.entered_event(set);
                }
            }
        }

        if total <= 0.0 {
            if !looping {
                self.reach_end(set);
            }
            return self.entered_event(set);
        }

        if self.elapsed_ms >= total {
            if looping {
                self.elapsed_ms %= total;
            } else {
                self.reach_end(set);
            }
        }
        self.entered_event(set)
    }

    /// The event of the current frame, but only if it just became the shown
    /// frame since the previous advance (so it fires once on entry, not every
    /// tick the frame is held, and again each loop when the frame recurs).
    fn entered_event(&mut self, set: &AnimationSet) -> Option<u16> {
        let cur = self.current_frame();
        let entered = self.last_frame != Some(cur);
        self.last_frame = Some(cur);
        if !entered {
            return None;
        }
        set.families
            .get(self.family)
            .and_then(|f| f.frames.get(cur))
            .and_then(|frame| frame.event)
    }

    fn reach_end(&mut self, set: &AnimationSet) {
        // A queued request wins over the family's own `next`.
        if let Some((fam, target)) = self.pending.take() {
            self.start(set, fam, target);
            return;
        }
        if let Some(next) = set.families[self.family].next {
            self.start(set, next, None);
            return;
        }
        // No transition: hold the final frame and report finished so the engine
        // can decide what to play next (or, for hold_last families like death,
        // leave it be).
        self.finished = true;
        self.elapsed_ms = self.schedule.total_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Family, FrameSpec};

    fn fam(frames: usize, looping: bool, interrupt: Interrupt) -> Family {
        Family {
            frames: (0..frames).map(|_| FrameSpec::fixed(100.0)).collect(),
            looping,
            next: None,
            hold_last: false,
            interrupt,
            branch_frame: None,
        }
    }

    /// families: 0 idle(loop), 1 walk(loop), 2 attack(one-shot, blocking), 3 hurt(one-shot, queue)
    fn set() -> AnimationSet {
        let mut s = AnimationSet::default();
        s.families.push(fam(1, true, Interrupt::Always)); // idle
        s.families.push(fam(4, true, Interrupt::Always)); // walk
        s.families.push(fam(3, false, Interrupt::Block)); // attack
        s.families.push(fam(2, false, Interrupt::Queue)); // hurt
        s
    }

    #[test]
    fn looping_wraps() {
        let s = set();
        let mut i = AnimationInstance::new(&s, 1, None); // walk, 4×100
        i.advance(&s, 250.0);
        assert_eq!(i.current_frame(), 2);
        i.advance(&s, 250.0); // 500 total → wraps to 100
        assert_eq!(i.current_frame(), 1);
        assert!(!i.finished());
    }

    #[test]
    fn one_shot_holds_last_and_finishes() {
        let s = set();
        let mut i = AnimationInstance::new(&s, 2, None); // attack, 3×100
        i.advance(&s, 350.0);
        assert!(i.finished());
        assert_eq!(i.current_frame(), 2);
    }

    #[test]
    fn always_interrupts_immediately() {
        let s = set();
        let mut i = AnimationInstance::new(&s, 0, None); // idle (Always)
        i.request(&s, 1, None); // → walk now
        assert_eq!(i.family(), 1);
    }

    #[test]
    fn block_ignores_requests_until_done() {
        let s = set();
        let mut i = AnimationInstance::new(&s, 2, None); // attack (Block), 3×100
        i.advance(&s, 100.0);
        i.request(&s, 1, None); // walk requested mid-attack → ignored
        assert_eq!(i.family(), 2);
        i.advance(&s, 300.0); // attack ends → still not auto-switching (no next)
        assert!(i.finished());
        i.request(&s, 1, None); // now allowed (finished)
        assert_eq!(i.family(), 1);
    }

    #[test]
    fn queue_defers_to_end() {
        let s = set();
        let mut i = AnimationInstance::new(&s, 3, None); // hurt (Queue), 2×100
        i.advance(&s, 50.0);
        i.request(&s, 1, None); // walk queued
        assert_eq!(i.family(), 3);
        i.advance(&s, 200.0); // hurt ends → queued walk starts
        assert_eq!(i.family(), 1);
    }

    #[test]
    fn queue_branch_frame_splits_early() {
        let mut s = set();
        // Give the Queue family (3) a branch at frame 1 — 3 frames now.
        s.families[3] = fam(3, false, Interrupt::Queue);
        s.families[3].branch_frame = Some(1);
        let mut i = AnimationInstance::new(&s, 3, None);
        i.request(&s, 1, None); // walk queued at frame 0
        assert_eq!(i.family(), 3);
        i.advance(&s, 120.0); // now in frame 1 (>= branch) → split to walk early
        assert_eq!(i.family(), 1);
    }

    #[test]
    fn cancel_window_frame_allows_interrupt_under_block() {
        let mut s = set();
        // Make attack frame 2 a cancel window.
        s.families[2].frames[2].cancelable = true;
        let mut i = AnimationInstance::new(&s, 2, None);
        i.advance(&s, 100.0); // frame 1 — blocked
        i.request(&s, 1, None);
        assert_eq!(i.family(), 2);
        i.advance(&s, 120.0); // now in frame 2 (cancel window)
        i.request(&s, 1, None);
        assert_eq!(i.family(), 1);
    }

    #[test]
    fn frame_event_fires_once_on_entry_and_again_each_loop() {
        let mut s = set();
        // walk (family 1, looping, 4×100ms): mark frame 2 with event 7.
        s.families[1].frames[2].event = Some(7);
        let mut i = AnimationInstance::new(&s, 1, None);
        assert_eq!(i.advance(&s, 50.0), None); // frame 0, no event
        assert_eq!(i.advance(&s, 100.0), None); // frame 1
        assert_eq!(i.advance(&s, 100.0), Some(7)); // entered frame 2 → fires
        assert_eq!(i.advance(&s, 20.0), None); // still frame 2 → no refire
        assert_eq!(i.advance(&s, 100.0), None); // frame 3
        i.advance(&s, 100.0); // wrap to frame 0
        assert_eq!(i.advance(&s, 200.0), Some(7)); // frame 2 again next loop
    }

    #[test]
    fn frame_event_fires_on_a_one_shot_strike_frame_regardless_of_dt() {
        let mut s = set();
        // attack (family 2, one-shot, 3×100ms): strike event 9 on frame 1.
        s.families[2].frames[1].event = Some(9);
        let mut i = AnimationInstance::new(&s, 2, None);
        // One big step that lands inside frame 1 still reports the strike once.
        assert_eq!(i.advance(&s, 120.0), Some(9));
        assert_eq!(i.advance(&s, 50.0), None);
    }

    #[test]
    fn same_family_request_does_not_restart() {
        let s = set();
        let mut i = AnimationInstance::new(&s, 1, None);
        i.advance(&s, 150.0);
        i.request(&s, 1, None); // same family, still playing → no reset
        assert_eq!(i.current_frame(), 1);
    }
}
