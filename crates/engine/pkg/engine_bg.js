/**
 * Top-level engine exposed to JavaScript. One instance per page load.
 */
export class Engine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engine_free(ptr, 0);
    }
    /**
     * Reactive-nudge entry point (goal layers, ADR 0011): blend a soft
     * influence into a monster's current velocity without replacing its
     * path target — the same post-AI pattern monster separation uses.
     * @param {number} id
     * @param {number} nx
     * @param {number} ny
     * @param {number} nz
     */
    add_monster_nudge(id, nx, ny, nz) {
        wasm.engine_add_monster_nudge(this.__wbg_ptr, id, nx, ny, nz);
    }
    /**
     * Adopt an entity from another peer's `entity_snapshot` as a new,
     * locally-owned, fully-simulated entity (ADR 0022) — the receiving half of
     * an ownership handoff. Restores position/velocity/rotation/health/
     * collider/animation so simulation continues seamlessly, and (via
     * `register_spawned`) enrolls it in local simulation + replication, monster
     * AI if NET_MONSTER, and the game's mesh lifecycle. Returns the new local
     * eid, or `u32::MAX` on malformed input. The entity's stable cross-peer
     * identity (the awari `EntityId`) is owned by the TS layer, which maps it
     * to this returned eid.
     * @param {Uint8Array} payload
     * @returns {number}
     */
    adopt_entity(payload) {
        const ptr0 = passArray8ToWasm0(payload, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_adopt_entity(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Build (or rebuild) the navmesh by scanning floor geometry via the physics world.
     * Bounds are derived from the loaded floor entities (AABB padded by one cell), so
     * maps of any size and location work without engine changes.
     */
    build_navmesh() {
        wasm.engine_build_navmesh(this.__wbg_ptr);
    }
    /**
     * Build (or rebuild) a 2D navmesh — the side-view platformer analogue of
     * `build_navmesh`, kept as a separate entry point (see
     * `crates/engine/src/navmesh2d.rs`) since 3D's single-surface-per-column
     * scan silently loses geometry a 2D level actually needs. `walk_speed`/
     * `jump_speed`/`max_jumps` describe whoever will traverse the mesh —
     * passed in by the caller each time rather than read from any stored
     * config, so the same level can serve movers with different
     * capabilities without touching Rust. Stores into the same `self.navmesh`
     * slot `build_navmesh` does; `find_path` queries it unchanged either way.
     * @param {number} walk_speed
     * @param {number} jump_speed
     * @param {number} max_jumps
     */
    build_navmesh_2d(walk_speed, jump_speed, max_jumps) {
        wasm.engine_build_navmesh_2d(this.__wbg_ptr, walk_speed, jump_speed, max_jumps);
    }
    /**
     * Revert a monster to the engine-global AiConfig's capability.
     * @param {number} id
     */
    clear_monster_capability(id) {
        wasm.engine_clear_monster_capability(this.__wbg_ptr, id);
    }
    /**
     * Revert a monster to the default goal.
     * @param {number} id
     */
    clear_monster_goal(id) {
        wasm.engine_clear_monster_goal(this.__wbg_ptr, id);
    }
    /**
     * Deserialize a PatchBundle byte array into a JS object.
     * @param {Uint8Array} bytes
     * @returns {any}
     */
    static deserialize_patch(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_deserialize_patch(ptr0, len0);
        return ret;
    }
    /**
     * Destroy an entity and remove its Rapier physics body.
     * @param {number} id
     */
    destroy_entity(id) {
        wasm.engine_destroy_entity(this.__wbg_ptr, id);
    }
    /**
     * Which physics backend this engine was constructed with — `"2d"` or
     * `"3d"`. Introspection only; the choice was fixed at construction.
     * @returns {string}
     */
    dimension() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_dimension(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Serialize an owned entity's full transferable state for an ownership
     * handoff (ADR 0022). The TS layer sends these bytes to the peer receiving
     * ownership (push-before-release), which reconstructs the entity via
     * `adopt_entity`. Returns empty bytes if the entity has no net profile
     * (never existed / already gone). Read-only — the entity keeps simulating
     * on this peer until the handoff is committed and it's destroyed here.
     * @param {number} id
     * @returns {Uint8Array}
     */
    entity_snapshot(id) {
        const ret = wasm.engine_entity_snapshot(this.__wbg_ptr, id);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Find a path from (startX, startY, startZ) to (goalX, goalZ).
     * @param {number} start_x
     * @param {number} start_y
     * @param {number} start_z
     * @param {number} goal_x
     * @param {number} goal_z
     * @param {boolean} can_jump
     * @returns {any}
     */
    find_path(start_x, start_y, start_z, goal_x, goal_z, can_jump) {
        const ret = wasm.engine_find_path(this.__wbg_ptr, start_x, start_y, start_z, goal_x, goal_z, can_jump);
        return ret;
    }
    /**
     * Return current tick metrics as a JS object.
     * @returns {any}
     */
    get_metrics() {
        const ret = wasm.engine_get_metrics(this.__wbg_ptr);
        return ret;
    }
    /**
     * Load the game's animation definitions: families (per-frame timing/flags,
     * transitions, interruptibility, branch frame) plus the action→family map.
     * This is the behavior half of the paper-doll system; the art (sheets,
     * layers, cell size) stays in the TS manifest. Absent = animation inert
     * (no cell emitted). See ADR 0015 / 0016.
     * @param {any} defs
     */
    load_animations(defs) {
        wasm.engine_load_animations(this.__wbg_ptr, defs);
    }
    /**
     * Load a map from a JS array of `{ x, y, z, hw, hh, hd, kind }` blocks: spawns a
     * static terrain entity per block, builds the navmesh from the resulting floor
     * geometry, and returns the same blocks with `eid` added for mesh creation on the
     * TS side. The map data is owned by the game — the engine ships none.
     * @param {any} blocks
     * @returns {any}
     */
    load_map(blocks) {
        const ret = wasm.engine_load_map(this.__wbg_ptr, blocks);
        return ret;
    }
    /**
     * Inbound payload from a peer; applied at the start of the next tick.
     * @param {string} peer_id
     * @param {Uint8Array} payload
     */
    net_ingest(peer_id, payload) {
        const ptr0 = passStringToWasm0(peer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(payload, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.engine_net_ingest(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Initialize WebRTC peer networking (WASM only).
     * A peer's data channel opened. Queues a late-join full sync + PeerJoined.
     * @param {string} peer_id
     */
    net_peer_connected(peer_id) {
        const ptr0 = passStringToWasm0(peer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_net_peer_connected(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * A peer's data channel closed. Its mirrors despawn next tick (the silent
     * timeout remains as a backstop for channels that die without closing).
     * @param {string} peer_id
     */
    net_peer_disconnected(peer_id) {
        const ptr0 = passStringToWasm0(peer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_net_peer_disconnected(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Everything the engine wants sent since the last call, as
     * `[{ peer: string | null, data: Uint8Array }]` — null peer = broadcast.
     * @returns {any}
     */
    net_take_outbound() {
        const ret = wasm.engine_net_take_outbound(this.__wbg_ptr);
        return ret;
    }
    /**
     * `dimension`: `"2d"` (case-insensitive) selects Rapier2D; anything else
     * (including omitted/`None`, from JS calling `new Engine()`) keeps the
     * original Rapier3D behavior. A setup-time choice only — fixed for this
     * engine instance's lifetime, and orthogonal to game logic (player
     * controller/monster AI/bullets are unchanged either way; see
     * crates/physics's Dimension for exactly what "2D" means physically).
     * `gravity`: overrides the engine-wide gravity constant for this
     * instance (e.g. `Some(0.0)` for a top-down, no-fall game); omitted/
     * `None` keeps the original value. Threaded to every consumer that
     * cares — physics, bullet ballistic integration, and the 2D navmesh's
     * jump-reachability math all read `self.gravity`, not the bare constant.
     * @param {string | null} [dimension]
     * @param {number | null} [gravity]
     */
    constructor(dimension, gravity) {
        var ptr0 = isLikeNone(dimension) ? 0 : passStringToWasm0(dimension, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_new(ptr0, len0, isLikeNone(gravity) ? Number.MAX_SAFE_INTEGER : Math.fround(gravity));
        this.__wbg_ptr = ret;
        EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Fire: with animations loaded, this only *requests* the attack action —
     * the bullet spawns when the attack reaches its FIRE frame (drive_animation
     * dispatch), keeping the shot locked to the strike regardless of animation
     * speed. Without an animation set the bullet fires immediately (unchanged
     * behavior for games that don't load animations, e.g. the 2D game fires via
     * spawn_bullet directly and never calls this). See ADR 0017.
     */
    player_fire() {
        wasm.engine_player_fire(this.__wbg_ptr);
    }
    /**
     * Register the player entity. From then on the engine runs its controller
     * (facing, movement, jump budget) from set_player_input, fires its bullets
     * via player_fire, and aims the default monster goal at it every tick.
     * @param {number} eid
     */
    register_player(eid) {
        wasm.engine_register_player(this.__wbg_ptr, eid);
    }
    /**
     * Override monster AI tuning. Accepts a partial JS object; missing fields fall
     * back to engine defaults (not to previously set values). Invalid input is
     * ignored with a warning.
     * @param {any} cfg
     */
    set_ai_config(cfg) {
        wasm.engine_set_ai_config(this.__wbg_ptr, cfg);
    }
    /**
     * Set the velocity of an entity. XZ is a movement command, applied last-write-wins.
     * Non-zero vy latches a jump impulse consumed by exactly one physics step; vy=0
     * never clears a pending latch, so a jump survives movement commands that coalesce
     * ahead of the next tick. Consecutive jumps before a tick collapse to the last one.
     * @param {number} id
     * @param {number} vx
     * @param {number} vy
     * @param {number} vz
     */
    set_entity_velocity(id, vx, vy, vz) {
        wasm.engine_set_entity_velocity(this.__wbg_ptr, id, vx, vy, vz);
    }
    /**
     * Set log verbosity: 0=off, 1=error, 2=warn, 3=info, 4=debug.
     * @param {number} _level
     */
    set_log_level(_level) {
        wasm.engine_set_log_level(this.__wbg_ptr, _level);
    }
    /**
     * Give one monster its own capability override (walk speed / can-jump /
     * can-fly — see `MonsterCapability`'s doc comment for why `jump_speed`
     * and `max_jumps` aren't here), overriding the engine-global `AiConfig`
     * until cleared. Accepts a partial JS object; missing fields fall back
     * to `MonsterCapability::default()` (not to the current `AiConfig`,
     * same "missing = static default" convention every other partial
     * config in this engine already uses). Invalid input is ignored with a
     * warning.
     * @param {number} id
     * @param {any} cfg
     */
    set_monster_capability(id, cfg) {
        wasm.engine_set_monster_capability(this.__wbg_ptr, id, cfg);
    }
    /**
     * Override monster spawn/respawn tuning (partial-object semantics).
     * @param {any} cfg
     */
    set_monster_config(cfg) {
        wasm.engine_set_monster_config(this.__wbg_ptr, cfg);
    }
    /**
     * Give one monster its own goal, overriding the default until cleared.
     * No-op for entities without monster AI state.
     * @param {number} id
     * @param {number} gx
     * @param {number} gz
     */
    set_monster_goal(id, gx, gz) {
        wasm.engine_set_monster_goal(this.__wbg_ptr, id, gx, gz);
    }
    /**
     * Override navmesh build tuning (same partial-object semantics as set_ai_config).
     * Takes effect on the next load_map / build_navmesh call.
     * @param {any} cfg
     */
    set_nav_config(cfg) {
        wasm.engine_set_nav_config(this.__wbg_ptr, cfg);
    }
    /**
     * Override player controller/combat tuning (partial-object semantics).
     * @param {any} cfg
     */
    set_player_config(cfg) {
        wasm.engine_set_player_config(this.__wbg_ptr, cfg);
    }
    /**
     * Latest raw input state from the UI (call once per frame). Invalid input
     * is ignored with a warning.
     * @param {any} input
     */
    set_player_input(input) {
        wasm.engine_set_player_input(this.__wbg_ptr, input);
    }
    /**
     * Mark a floor entity as non-walkable (or clear that) after it's already
     * spawned — additive counterpart to `MapBlock.walkable` (which only
     * applies at `load_map` time) for callers like the 2D game that spawn
     * terrain block-by-block via `spawn_floor_entity` instead.
     * @param {number} id
     * @param {boolean} walkable
     */
    set_terrain_walkable(id, walkable) {
        wasm.engine_set_terrain_walkable(this.__wbg_ptr, id, walkable);
    }
    /**
     * Spawn a dynamic entity (player, monster, box). Returns the entity ID.
     * `net_flags`: combine NET_LOCAL (0x01) and NET_MONSTER (0x04) for monster entities.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} hw
     * @param {number} hh
     * @param {number} hd
     * @param {number} health
     * @param {number} net_flags
     * @returns {number}
     */
    spawn_box_entity(x, y, z, hw, hh, hd, health, net_flags) {
        const ret = wasm.engine_spawn_box_entity(this.__wbg_ptr, x, y, z, hw, hh, hd, health, net_flags);
        return ret >>> 0;
    }
    /**
     * Spawn a projectile. The engine integrates its ballistic trajectory each
     * tick. `net_flags` adds the game's networking profile (e.g. NET_REPLICATED
     * | NET_PREDICTABLE); NET_BULLET is always set.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} vx
     * @param {number} vy
     * @param {number} vz
     * @param {number} net_flags
     * @returns {number}
     */
    spawn_bullet(x, y, z, vx, vy, vz, net_flags) {
        const ret = wasm.engine_spawn_bullet(this.__wbg_ptr, x, y, z, vx, vy, vz, net_flags);
        return ret >>> 0;
    }
    /**
     * Spawn an entity from a bincode-encoded EntityBlueprint. Returns the new entity ID.
     * @param {Uint8Array} payload
     * @returns {number}
     */
    spawn_entity(payload) {
        const ptr0 = passArray8ToWasm0(payload, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_spawn_entity(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Spawn a static floor entity. Returns the entity ID.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} hw
     * @param {number} hh
     * @param {number} hd
     * @returns {number}
     */
    spawn_floor_entity(x, y, z, hw, hh, hd) {
        const ret = wasm.engine_spawn_floor_entity(this.__wbg_ptr, x, y, z, hw, hh, hd);
        return ret >>> 0;
    }
    /**
     * Spawn `count` monsters on a ring around the origin (placement/template
     * from MonsterConfig). Each spawn surfaces as a lifecycle patch.
     * @param {number} count
     */
    spawn_monsters(count) {
        wasm.engine_spawn_monsters(this.__wbg_ptr, count);
    }
    /**
     * Move an entity immediately, clearing velocity for dynamic bodies.
     * @param {number} id
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    teleport_entity(id, x, y, z) {
        wasm.engine_teleport_entity(this.__wbg_ptr, id, x, y, z);
    }
    /**
     * Advance simulation by dt_ms milliseconds.
     * Returns a PatchBundle as a JS object directly — no bincode round-trip.
     * Thin WASM wrapper: the simulation itself lives in `tick_core` so native
     * tests can execute full ticks without crossing the JsValue boundary.
     * @param {number} dt_ms
     * @returns {any}
     */
    tick(dt_ms) {
        const ret = wasm.engine_tick(this.__wbg_ptr, dt_ms);
        return ret;
    }
    /**
     * Update the fallback goal for monsters without a per-entity override,
     * used only when no player exists yet to chase (no local player
     * registered, no peers connected) — once at least one does, every such
     * monster targets whichever player (local or a remote mirror) is
     * currently closest to it instead. See `closest_player_position`.
     * @param {number} gx
     * @param {number} gz
     */
    update_monster_goal(gx, gz) {
        wasm.engine_update_monster_goal(this.__wbg_ptr, gx, gz);
    }
}
if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;
export function __wbg_Error_92b29b0548f8b746(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_Number_9a4e0ecb0fa16705(arg0) {
    const ret = Number(arg0);
    return ret;
}
export function __wbg_String_8564e559799eccda(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_bigint_get_as_i64_d968e41184ae354f(arg0, arg1) {
    const v = arg1;
    const ret = typeof(v) === 'bigint' ? v : undefined;
    getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_boolean_get_fa956cfa2d1bd751(arg0) {
    const v = arg0;
    const ret = typeof(v) === 'boolean' ? v : undefined;
    return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
}
export function __wbg___wbindgen_debug_string_c25d447a39f5578f(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_in_aca499c5de7ff5e5(arg0, arg1) {
    const ret = arg0 in arg1;
    return ret;
}
export function __wbg___wbindgen_is_bigint_2f76dc55065b4273(arg0) {
    const ret = typeof(arg0) === 'bigint';
    return ret;
}
export function __wbg___wbindgen_is_function_1ff95bcc5517c252(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
}
export function __wbg___wbindgen_is_object_a27215656b807791(arg0) {
    const val = arg0;
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
}
export function __wbg___wbindgen_is_undefined_c05833b95a3cf397(arg0) {
    const ret = arg0 === undefined;
    return ret;
}
export function __wbg___wbindgen_jsval_eq_e659fcf7b0e32763(arg0, arg1) {
    const ret = arg0 === arg1;
    return ret;
}
export function __wbg___wbindgen_jsval_loose_eq_db4c3b15f63fc170(arg0, arg1) {
    const ret = arg0 == arg1;
    return ret;
}
export function __wbg___wbindgen_number_get_394265ed1e1b84ee(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'number' ? obj : undefined;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_string_get_b0ca35b86a603356(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'string' ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_throw_344f42d3211c4765(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg_call_8a2dd23819f8a60a() { return handleError(function (arg0, arg1) {
    const ret = arg0.call(arg1);
    return ret;
}, arguments); }
export function __wbg_debug_87fd9b1a625b7efb(arg0) {
    console.debug(arg0);
}
export function __wbg_done_89b2b13e91a60321(arg0) {
    const ret = arg0.done;
    return ret;
}
export function __wbg_error_744744ff0c9861e6(arg0) {
    console.error(arg0);
}
export function __wbg_error_a6fa202b58aa1cd3(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
}
export function __wbg_get_78f252d074a84d0b() { return handleError(function (arg0, arg1) {
    const ret = Reflect.get(arg0, arg1);
    return ret;
}, arguments); }
export function __wbg_get_c7eb1f358a7654df() { return handleError(function (arg0, arg1) {
    const ret = Reflect.get(arg0, arg1);
    return ret;
}, arguments); }
export function __wbg_get_unchecked_6e0ad6d2a41b06f6(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return ret;
}
export function __wbg_get_with_ref_key_6412cf3094599694(arg0, arg1) {
    const ret = arg0[arg1];
    return ret;
}
export function __wbg_info_eadbe775a8e2e9eb(arg0) {
    console.info(arg0);
}
export function __wbg_instanceof_ArrayBuffer_4480b9e0068a8adb(arg0) {
    let result;
    try {
        result = arg0 instanceof ArrayBuffer;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Performance_b6ab96b4c12edf1e(arg0) {
    let result;
    try {
        result = arg0 instanceof Performance;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Uint8Array_309b927aaf7a3fc7(arg0) {
    let result;
    try {
        result = arg0 instanceof Uint8Array;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_isArray_0677c962b281d01a(arg0) {
    const ret = Array.isArray(arg0);
    return ret;
}
export function __wbg_isSafeInteger_04f36e4056f1b851(arg0) {
    const ret = Number.isSafeInteger(arg0);
    return ret;
}
export function __wbg_iterator_6f722e4a93058b71() {
    const ret = Symbol.iterator;
    return ret;
}
export function __wbg_length_1f0964f4a5e2c6d8(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_length_370319915dc99107(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_log_d267660666346fb3(arg0) {
    console.log(arg0);
}
export function __wbg_new_227d7c05414eb861() {
    const ret = new Error();
    return ret;
}
export function __wbg_new_32b398fb48b6d94a() {
    const ret = new Array();
    return ret;
}
export function __wbg_new_cd45aabdf6073e84(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
}
export function __wbg_new_da52cf8fe3429cb2() {
    const ret = new Object();
    return ret;
}
export function __wbg_new_from_slice_77cdfb7977362f3c(arg0, arg1) {
    const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_next_6dbf2c0ac8cde20f(arg0) {
    const ret = arg0.next;
    return ret;
}
export function __wbg_next_71f2aa1cb3d1e37e() { return handleError(function (arg0) {
    const ret = arg0.next();
    return ret;
}, arguments); }
export function __wbg_now_390768da5ee9e776(arg0) {
    const ret = arg0.now();
    return ret;
}
export function __wbg_now_86c0d4ba3fa605b8() {
    const ret = Date.now();
    return ret;
}
export function __wbg_prototypesetcall_4770620bbe4688a0(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_push_d2ae3af0c1217ae6(arg0, arg1) {
    const ret = arg0.push(arg1);
    return ret;
}
export function __wbg_set_6be42768c690e380(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
}
export function __wbg_set_8535240470bf2500() { return handleError(function (arg0, arg1, arg2) {
    const ret = Reflect.set(arg0, arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_set_8a16b38e4805b298(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
}
export function __wbg_stack_3b0d974bbf31e44f(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_static_accessor_GLOBAL_4ef717fb391d88b7() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_SELF_146583524fe1469b() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_WINDOW_f2829a2234d7819e() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_value_a5d5488a9589444a(arg0) {
    const ret = arg0.value;
    return ret;
}
export function __wbg_warn_b1370d804fa3e259(arg0) {
    console.warn(arg0);
}
export function __wbindgen_cast_0000000000000001(arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000003(arg0) {
    // Cast intrinsic for `U64 -> Externref`.
    const ret = BigInt.asUintN(64, arg0);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
