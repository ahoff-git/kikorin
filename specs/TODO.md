## Bugs: 
- ~~the pathfinding for 2d top down doesn't path around walls.~~ — **done**: the 3D navmesh never blocked lateral movement through a wall standing on open floor (only ever tested against parapets-on-a-platform); fixed, plus the top-down maze's own corner rooms turned out to be structurally unreachable regardless. See [ADR 0006](decisions/0006-navmesh-walls-block-lateral-movement.md).
- ~~the pathfinding for 2d w/ graviry doesn't actually make jumps up to the next level.~~ — **done**: monsters could only ever fire one jump per waypoint (grounded-gated); now they get a real, apex-timed multi-jump budget matching the player's. See [ADR 0008](decisions/0008-monster-multi-jump-budget.md).
- ~~Bullets hitting shared monsters do not register hits nor kill them~~ — **done**: a monster's owner now also checks every bullet *mirror* (another peer's bullet) against its own monsters, not just its own local bullets. See [ADR 0007](decisions/0007-cross-peer-bullet-monster-hits.md).
- (3d) Monsters jump up stairs but don't jump over low walls
- (3d) Flying monsters fly directly at the target but get stuck on walls... even though they could fly over them

## Features: 
- ~~configuration for the 'nearby' channel~~ — **done**: `createChatController`'s `nearbyRadius` is now a per-game construction-time parameter instead of one fixed constant. See [specs/chat/README.md](chat/README.md).
- ~~docs for the chat stuff~~ — **done**: [specs/chat/README.md](chat/README.md).
- Talk about and create a way to manage 8 way paper doll (layered sprite) sprite animations
  - Should support armor, weapons, multiple attack patterns / animations, etc.
  - Should work for all of the rendering modes 
- add pathing for flying monsters. They don't have to stay at one altitude
- add an incorporeal flag that lets things run through walls (will need to update pathing for this as well)
- make the top down map more interesting and larger 

## Questions: 
- ~~Is the bootstrap service using https://awari-bootstrap-service.vercel.app/ or something else entirely?~~ — **answered and fixed**: it wasn't (a purely local, in-memory stand-in). Now switched to the real service, proxied through this app's own `/api/bootstrap(/hints)` routes (the live service sends no CORS headers, so a browser can't call it directly). Verified against the live service with two real browser tabs. See [ADR 0009](decisions/0009-real-bootstrap-service.md).

## Chores: 
- Clean up crossed out (done) stuff in the todo. 