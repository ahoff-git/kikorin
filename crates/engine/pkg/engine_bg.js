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
     * Apply a serialized input event or inbound peer message.
     * @param {Uint8Array} payload
     */
    apply_input(payload) {
        const ptr0 = passArray8ToWasm0(payload, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_apply_input(this.__wbg_ptr, ptr0, len0);
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
     * Initialize WebRTC peer networking (WASM only).
     * @param {string} session_id
     * @param {string} signaling_url
     */
    init_networking(session_id, signaling_url) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(signaling_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.engine_init_networking(this.__wbg_ptr, ptr0, len0, ptr1, len1);
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
    constructor() {
        const ret = wasm.engine_new();
        this.__wbg_ptr = ret;
        EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Override monster AI tuning. Accepts a partial JS object; missing fields fall
     * back to engine defaults (not to previously set values). Invalid input is ignored.
     * @param {any} cfg
     */
    set_ai_config(cfg) {
        wasm.engine_set_ai_config(this.__wbg_ptr, cfg);
    }
    /**
     * Set the velocity of an entity. XZ velocity is always applied.
     * Pass vy=0 to preserve gravity accumulation; non-zero vy applies a one-frame jump impulse.
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
     * Override navmesh build tuning (same partial-object semantics as set_ai_config).
     * Takes effect on the next load_map / build_navmesh call.
     * @param {any} cfg
     */
    set_nav_config(cfg) {
        wasm.engine_set_nav_config(this.__wbg_ptr, cfg);
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
     * Spawn a projectile. The engine integrates its ballistic trajectory each tick.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} vx
     * @param {number} vy
     * @param {number} vz
     * @returns {number}
     */
    spawn_bullet(x, y, z, vx, vy, vz) {
        const ret = wasm.engine_spawn_bullet(this.__wbg_ptr, x, y, z, vx, vy, vz);
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
     * @param {number} dt_ms
     * @returns {any}
     */
    tick(dt_ms) {
        const ret = wasm.engine_tick(this.__wbg_ptr, dt_ms);
        return ret;
    }
    /**
     * Update the position monsters path toward. Call once per frame before tick()
     * with the player's current world position.
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
export function __wbg___wbindgen_is_function_1ff95bcc5517c252(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
}
export function __wbg___wbindgen_is_object_a27215656b807791(arg0) {
    const val = arg0;
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
}
export function __wbg___wbindgen_is_string_ea5e6cc2e4141dfe(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
}
export function __wbg___wbindgen_is_undefined_c05833b95a3cf397(arg0) {
    const ret = arg0 === undefined;
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
export function __wbg__wbg_cb_unref_fffb441def202758(arg0) {
    arg0._wbg_cb_unref();
}
export function __wbg_addIceCandidate_f7ceaa2f75a37e0a(arg0, arg1) {
    const ret = arg0.addIceCandidate(arg1);
    return ret;
}
export function __wbg_call_8a2dd23819f8a60a() { return handleError(function (arg0, arg1) {
    const ret = arg0.call(arg1);
    return ret;
}, arguments); }
export function __wbg_candidate_c03bb5d81bec0300(arg0) {
    const ret = arg0.candidate;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_candidate_f7f684cdcc2dfa01(arg0, arg1) {
    const ret = arg1.candidate;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_channel_295d3e772fc68baf(arg0) {
    const ret = arg0.channel;
    return ret;
}
export function __wbg_createAnswer_aa2ae2f1c1d400a3(arg0) {
    const ret = arg0.createAnswer();
    return ret;
}
export function __wbg_createDataChannel_c6d560e9b1225d62(arg0, arg1, arg2) {
    const ret = arg0.createDataChannel(getStringFromWasm0(arg1, arg2));
    return ret;
}
export function __wbg_createOffer_bf4e8d6b4b5cea92(arg0) {
    const ret = arg0.createOffer();
    return ret;
}
export function __wbg_data_328de4280640da92(arg0) {
    const ret = arg0.data;
    return ret;
}
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
export function __wbg_iceConnectionState_722477d70a05449c(arg0) {
    const ret = arg0.iceConnectionState;
    return (__wbindgen_enum_RtcIceConnectionState.indexOf(ret) + 1 || 8) - 1;
}
export function __wbg_iceGatheringState_24878fec91d64fb7(arg0) {
    const ret = arg0.iceGatheringState;
    return (__wbindgen_enum_RtcIceGatheringState.indexOf(ret) + 1 || 4) - 1;
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
export function __wbg_new_816428067631f70f() { return handleError(function () {
    const ret = new RTCPeerConnection();
    return ret;
}, arguments); }
export function __wbg_new_90f6a15d50ef9cc1() { return handleError(function (arg0) {
    const ret = new RTCIceCandidate(arg0);
    return ret;
}, arguments); }
export function __wbg_new_bf8729ffe10e9ee7() { return handleError(function (arg0, arg1) {
    const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
    return ret;
}, arguments); }
export function __wbg_new_cd45aabdf6073e84(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
}
export function __wbg_new_da52cf8fe3429cb2() {
    const ret = new Object();
    return ret;
}
export function __wbg_new_with_configuration_40ac01bf87e5584e() { return handleError(function (arg0) {
    const ret = new RTCPeerConnection(arg0);
    return ret;
}, arguments); }
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
export function __wbg_queueMicrotask_0ab5b2d2393e99b9(arg0) {
    const ret = arg0.queueMicrotask;
    return ret;
}
export function __wbg_queueMicrotask_6a09b7bc46549209(arg0) {
    queueMicrotask(arg0);
}
export function __wbg_resolve_2191a4dfe481c25b(arg0) {
    const ret = Promise.resolve(arg0);
    return ret;
}
export function __wbg_sdpMLineIndex_25f34f297ced702a(arg0) {
    const ret = arg0.sdpMLineIndex;
    return isLikeNone(ret) ? 0xFFFFFF : ret;
}
export function __wbg_sdpMid_d3e98f8b4c29e5d9(arg0, arg1) {
    const ret = arg1.sdpMid;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_send_632c4452a512b363() { return handleError(function (arg0, arg1, arg2) {
    arg0.send(getStringFromWasm0(arg1, arg2));
}, arguments); }
export function __wbg_send_df98dd5ede9b3f4d() { return handleError(function (arg0, arg1, arg2) {
    arg0.send(getStringFromWasm0(arg1, arg2));
}, arguments); }
export function __wbg_setLocalDescription_423abfc919239ddf(arg0, arg1) {
    const ret = arg0.setLocalDescription(arg1);
    return ret;
}
export function __wbg_setRemoteDescription_921ff9a4233c90c7(arg0, arg1) {
    const ret = arg0.setRemoteDescription(arg1);
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
export function __wbg_set_binaryType_a37b086c78ca7c29(arg0, arg1) {
    arg0.binaryType = __wbindgen_enum_BinaryType[arg1];
}
export function __wbg_set_candidate_b89b8e526c803fd7(arg0, arg1, arg2) {
    arg0.candidate = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_ice_servers_6f53a44e0587e42f(arg0, arg1) {
    arg0.iceServers = arg1;
}
export function __wbg_set_ondatachannel_54d1710068091335(arg0, arg1) {
    arg0.ondatachannel = arg1;
}
export function __wbg_set_onerror_df3caac09d010d29(arg0, arg1) {
    arg0.onerror = arg1;
}
export function __wbg_set_onicecandidate_0fd31ace2f760bf0(arg0, arg1) {
    arg0.onicecandidate = arg1;
}
export function __wbg_set_oniceconnectionstatechange_3170cd4b61eb8eb0(arg0, arg1) {
    arg0.oniceconnectionstatechange = arg1;
}
export function __wbg_set_onicegatheringstatechange_c32363e95fcf9fef(arg0, arg1) {
    arg0.onicegatheringstatechange = arg1;
}
export function __wbg_set_onmessage_5b4754d6f18ffa95(arg0, arg1) {
    arg0.onmessage = arg1;
}
export function __wbg_set_onmessage_836d2f72130b4706(arg0, arg1) {
    arg0.onmessage = arg1;
}
export function __wbg_set_onnegotiationneeded_4d72799b24f77b10(arg0, arg1) {
    arg0.onnegotiationneeded = arg1;
}
export function __wbg_set_onopen_4f65470ae522a61a(arg0, arg1) {
    arg0.onopen = arg1;
}
export function __wbg_set_onopen_8994b7ffb0ef2792(arg0, arg1) {
    arg0.onopen = arg1;
}
export function __wbg_set_sdp_de28f5c5c5b94fcb(arg0, arg1, arg2) {
    arg0.sdp = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_sdp_m_line_index_49082bcdf215d6f1(arg0, arg1) {
    arg0.sdpMLineIndex = arg1 === 0xFFFFFF ? undefined : arg1;
}
export function __wbg_set_sdp_mid_c99b69998b5d136f(arg0, arg1, arg2) {
    arg0.sdpMid = arg1 === 0 ? undefined : getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_type_0a410d31ee19e04c(arg0, arg1) {
    arg0.type = __wbindgen_enum_RtcSdpType[arg1];
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
export function __wbg_then_16d107c451e9905d(arg0, arg1, arg2) {
    const ret = arg0.then(arg1, arg2);
    return ret;
}
export function __wbg_then_6ec10ae38b3e92f7(arg0, arg1) {
    const ret = arg0.then(arg1);
    return ret;
}
export function __wbg_value_a5d5488a9589444a(arg0) {
    const ret = arg0.value;
    return ret;
}
export function __wbg_warn_b1370d804fa3e259(arg0) {
    console.warn(arg0);
}
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 527, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61);
    return ret;
}
export function __wbindgen_cast_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 579, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__he97b17567bb63af5);
    return ret;
}
export function __wbindgen_cast_0000000000000003(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 527, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61_2);
    return ret;
}
export function __wbindgen_cast_0000000000000004(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("RTCDataChannelEvent")], shim_idx: 524, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__he3585aedacd1d894);
    return ret;
}
export function __wbindgen_cast_0000000000000005(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("RTCPeerConnectionIceEvent")], shim_idx: 527, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61_4);
    return ret;
}
export function __wbindgen_cast_0000000000000006(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 530, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hcce9a11005266d23);
    return ret;
}
export function __wbindgen_cast_0000000000000007(arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000008(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000009(arg0) {
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
function wasm_bindgen__convert__closures_____invoke__hcce9a11005266d23(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__hcce9a11005266d23(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61_2(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61_2(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__he3585aedacd1d894(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__he3585aedacd1d894(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61_4(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h4cb0e549c76a2f61_4(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__he97b17567bb63af5(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__he97b17567bb63af5(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}


const __wbindgen_enum_BinaryType = ["blob", "arraybuffer"];


const __wbindgen_enum_RtcIceConnectionState = ["new", "checking", "connected", "completed", "failed", "disconnected", "closed"];


const __wbindgen_enum_RtcIceGatheringState = ["new", "gathering", "complete"];


const __wbindgen_enum_RtcSdpType = ["offer", "pranswer", "answer", "rollback"];
const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

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

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
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

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
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
