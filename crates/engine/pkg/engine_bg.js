//#region exports

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
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ptr0 = passArray8ToWasm0(payload, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_apply_input(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Build (or rebuild) the navmesh by scanning floor geometry via the physics world.
     * Call once after all floor/terrain entities have been spawned.
     * The navmesh covers [-80, 80] XZ at 1.5-unit cell resolution.
     */
    build_navmesh() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.engine_build_navmesh(this.__wbg_ptr);
    }
    /**
     * Deserialize a PatchBundle byte array into a JS object.
     * The adapter calls this so TypeScript doesn't need a bincode parser.
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
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(id);
        wasm.engine_destroy_entity(this.__wbg_ptr, id);
    }
    /**
     * Find a path from (startX, startY, startZ) to (goalX, goalZ).
     * Returns a JS array of `{x, y, z, requiresJump, isLedgeDrop}` waypoints, or null.
     * `canJump` — set false for monsters that cannot jump; jump edges are excluded.
     * @param {number} start_x
     * @param {number} start_y
     * @param {number} start_z
     * @param {number} goal_x
     * @param {number} goal_z
     * @param {boolean} can_jump
     * @returns {any}
     */
    find_path(start_x, start_y, start_z, goal_x, goal_z, can_jump) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertBoolean(can_jump);
        const ret = wasm.engine_find_path(this.__wbg_ptr, start_x, start_y, start_z, goal_x, goal_z, can_jump);
        return ret;
    }
    /**
     * Return current tick metrics as a JS object.
     * @returns {any}
     */
    get_metrics() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.engine_get_metrics(this.__wbg_ptr);
        return ret;
    }
    /**
     * Initialize WebRTC peer networking (WASM only).
     * TypeScript provides the shared session ID and signaling server URL.
     * Connection negotiation happens asynchronously inside wasm-peers.
     * @param {string} session_id
     * @param {string} signaling_url
     */
    init_networking(session_id, signaling_url) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(signaling_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.engine_init_networking(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    constructor() {
        const ret = wasm.engine_new();
        this.__wbg_ptr = ret;
        EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set the velocity of an entity. Use from TypeScript game logic each frame.
     * XZ velocity is always applied. Pass vy=0 for normal movement so that
     * sync_from_world (in the physics crate) preserves Rapier's accumulated Y
     * velocity (gravity). Pass non-zero vy only for a one-frame jump impulse.
     * @param {number} id
     * @param {number} vx
     * @param {number} vy
     * @param {number} vz
     */
    set_entity_velocity(id, vx, vy, vz) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(id);
        wasm.engine_set_entity_velocity(this.__wbg_ptr, id, vx, vy, vz);
    }
    /**
     * Set log verbosity: 0=off, 1=error, 2=warn, 3=info, 4=debug.
     * @param {number} _level
     */
    set_log_level(_level) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(_level);
        wasm.engine_set_log_level(this.__wbg_ptr, _level);
    }
    /**
     * Spawn a dynamic entity (player, monster, box). Returns the entity ID.
     * Pass `net_flags = 1` (NET_LOCAL) for locally-simulated entities; they are
     * automatically included in render patches every tick.
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
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(health);
        _assertNum(net_flags);
        const ret = wasm.engine_spawn_box_entity(this.__wbg_ptr, x, y, z, hw, hh, hd, health, net_flags);
        return ret >>> 0;
    }
    /**
     * Spawn a projectile. The engine integrates its ballistic trajectory each tick
     * (constant XZ velocity, 20.0 m/s² gravity on Y) and emits render patches.
     * No Rapier body is created — bullets bypass broadphase and contact generation.
     * TypeScript owns lifetime and hit detection; call destroy_entity to remove.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} vx
     * @param {number} vy
     * @param {number} vz
     * @returns {number}
     */
    spawn_bullet(x, y, z, vx, vy, vz) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.engine_spawn_bullet(this.__wbg_ptr, x, y, z, vx, vy, vz);
        return ret >>> 0;
    }
    /**
     * Spawn an entity from a bincode-encoded EntityBlueprint. Returns the new entity ID.
     * @param {Uint8Array} payload
     * @returns {number}
     */
    spawn_entity(payload) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ptr0 = passArray8ToWasm0(payload, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_spawn_entity(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Spawn a static floor entity. Returns the entity ID.
     * The entity is a solid collider; set its Three.js position immediately after spawning.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} hw
     * @param {number} hh
     * @param {number} hd
     * @returns {number}
     */
    spawn_floor_entity(x, y, z, hw, hh, hd) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.engine_spawn_floor_entity(this.__wbg_ptr, x, y, z, hw, hh, hd);
        return ret >>> 0;
    }
    /**
     * Advance simulation by dt_ms milliseconds.
     * Returns a PatchBundle as a JS object directly — no bincode round-trip.
     * @param {number} dt_ms
     * @returns {any}
     */
    tick(dt_ms) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.engine_tick(this.__wbg_ptr, dt_ms);
        return ret;
    }
}
if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;

//#endregion

//#region wasm imports
export function __wbg_Error_92b29b0548f8b746() { return logError(function (arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}, arguments); }
export function __wbg___wbindgen_debug_string_c25d447a39f5578f(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_is_function_1ff95bcc5517c252(arg0) {
    const ret = typeof(arg0) === 'function';
    _assertBoolean(ret);
    return ret;
}
export function __wbg___wbindgen_is_string_ea5e6cc2e4141dfe(arg0) {
    const ret = typeof(arg0) === 'string';
    _assertBoolean(ret);
    return ret;
}
export function __wbg___wbindgen_is_undefined_c05833b95a3cf397(arg0) {
    const ret = arg0 === undefined;
    _assertBoolean(ret);
    return ret;
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
export function __wbg__wbg_cb_unref_fffb441def202758() { return logError(function (arg0) {
    arg0._wbg_cb_unref();
}, arguments); }
export function __wbg_addIceCandidate_f7ceaa2f75a37e0a() { return logError(function (arg0, arg1) {
    const ret = arg0.addIceCandidate(arg1);
    return ret;
}, arguments); }
export function __wbg_call_a6e5c5dce5018821() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_candidate_c03bb5d81bec0300() { return logError(function (arg0) {
    const ret = arg0.candidate;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_candidate_f7f684cdcc2dfa01() { return logError(function (arg0, arg1) {
    const ret = arg1.candidate;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}, arguments); }
export function __wbg_channel_295d3e772fc68baf() { return logError(function (arg0) {
    const ret = arg0.channel;
    return ret;
}, arguments); }
export function __wbg_createAnswer_aa2ae2f1c1d400a3() { return logError(function (arg0) {
    const ret = arg0.createAnswer();
    return ret;
}, arguments); }
export function __wbg_createDataChannel_c6d560e9b1225d62() { return logError(function (arg0, arg1, arg2) {
    const ret = arg0.createDataChannel(getStringFromWasm0(arg1, arg2));
    return ret;
}, arguments); }
export function __wbg_createOffer_bf4e8d6b4b5cea92() { return logError(function (arg0) {
    const ret = arg0.createOffer();
    return ret;
}, arguments); }
export function __wbg_data_328de4280640da92() { return logError(function (arg0) {
    const ret = arg0.data;
    return ret;
}, arguments); }
export function __wbg_debug_87fd9b1a625b7efb() { return logError(function (arg0) {
    console.debug(arg0);
}, arguments); }
export function __wbg_error_744744ff0c9861e6() { return logError(function (arg0) {
    console.error(arg0);
}, arguments); }
export function __wbg_error_a6fa202b58aa1cd3() { return logError(function (arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
}, arguments); }
export function __wbg_get_78f252d074a84d0b() { return handleError(function (arg0, arg1) {
    const ret = Reflect.get(arg0, arg1);
    return ret;
}, arguments); }
export function __wbg_iceConnectionState_722477d70a05449c() { return logError(function (arg0) {
    const ret = arg0.iceConnectionState;
    return (__wbindgen_enum_RtcIceConnectionState.indexOf(ret) + 1 || 8) - 1;
}, arguments); }
export function __wbg_iceGatheringState_24878fec91d64fb7() { return logError(function (arg0) {
    const ret = arg0.iceGatheringState;
    return (__wbindgen_enum_RtcIceGatheringState.indexOf(ret) + 1 || 4) - 1;
}, arguments); }
export function __wbg_info_eadbe775a8e2e9eb() { return logError(function (arg0) {
    console.info(arg0);
}, arguments); }
export function __wbg_log_d267660666346fb3() { return logError(function (arg0) {
    console.log(arg0);
}, arguments); }
export function __wbg_new_227d7c05414eb861() { return logError(function () {
    const ret = new Error();
    return ret;
}, arguments); }
export function __wbg_new_32b398fb48b6d94a() { return logError(function () {
    const ret = new Array();
    return ret;
}, arguments); }
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
export function __wbg_new_da52cf8fe3429cb2() { return logError(function () {
    const ret = new Object();
    return ret;
}, arguments); }
export function __wbg_new_with_configuration_40ac01bf87e5584e() { return handleError(function (arg0) {
    const ret = new RTCPeerConnection(arg0);
    return ret;
}, arguments); }
export function __wbg_now_86c0d4ba3fa605b8() { return logError(function () {
    const ret = Date.now();
    return ret;
}, arguments); }
export function __wbg_push_d2ae3af0c1217ae6() { return logError(function (arg0, arg1) {
    const ret = arg0.push(arg1);
    _assertNum(ret);
    return ret;
}, arguments); }
export function __wbg_queueMicrotask_0ab5b2d2393e99b9() { return logError(function (arg0) {
    const ret = arg0.queueMicrotask;
    return ret;
}, arguments); }
export function __wbg_queueMicrotask_6a09b7bc46549209() { return logError(function (arg0) {
    queueMicrotask(arg0);
}, arguments); }
export function __wbg_resolve_2191a4dfe481c25b() { return logError(function (arg0) {
    const ret = Promise.resolve(arg0);
    return ret;
}, arguments); }
export function __wbg_run_5aa314612b150933() { return logError(function (arg0, arg1, arg2) {
    try {
        var state0 = {a: arg1, b: arg2};
        var cb0 = () => {
            const a = state0.a;
            state0.a = 0;
            try {
                return wasm_bindgen__convert__closures_____invoke__h03478c30e0f6eee3(a, state0.b, );
            } finally {
                state0.a = a;
            }
        };
        const ret = arg0.run(cb0);
        _assertBoolean(ret);
        return ret;
    } finally {
        state0.a = 0;
    }
}, arguments); }
export function __wbg_sdpMLineIndex_25f34f297ced702a() { return logError(function (arg0) {
    const ret = arg0.sdpMLineIndex;
    if (!isLikeNone(ret)) {
        _assertNum(ret);
    }
    return isLikeNone(ret) ? 0xFFFFFF : ret;
}, arguments); }
export function __wbg_sdpMid_d3e98f8b4c29e5d9() { return logError(function (arg0, arg1) {
    const ret = arg1.sdpMid;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}, arguments); }
export function __wbg_send_632c4452a512b363() { return handleError(function (arg0, arg1, arg2) {
    arg0.send(getStringFromWasm0(arg1, arg2));
}, arguments); }
export function __wbg_send_df98dd5ede9b3f4d() { return handleError(function (arg0, arg1, arg2) {
    arg0.send(getStringFromWasm0(arg1, arg2));
}, arguments); }
export function __wbg_setLocalDescription_423abfc919239ddf() { return logError(function (arg0, arg1) {
    const ret = arg0.setLocalDescription(arg1);
    return ret;
}, arguments); }
export function __wbg_setRemoteDescription_921ff9a4233c90c7() { return logError(function (arg0, arg1) {
    const ret = arg0.setRemoteDescription(arg1);
    return ret;
}, arguments); }
export function __wbg_set_6be42768c690e380() { return logError(function (arg0, arg1, arg2) {
    arg0[arg1] = arg2;
}, arguments); }
export function __wbg_set_8535240470bf2500() { return handleError(function (arg0, arg1, arg2) {
    const ret = Reflect.set(arg0, arg1, arg2);
    _assertBoolean(ret);
    return ret;
}, arguments); }
export function __wbg_set_8a16b38e4805b298() { return logError(function (arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
}, arguments); }
export function __wbg_set_binaryType_a37b086c78ca7c29() { return logError(function (arg0, arg1) {
    arg0.binaryType = __wbindgen_enum_BinaryType[arg1];
}, arguments); }
export function __wbg_set_candidate_b89b8e526c803fd7() { return logError(function (arg0, arg1, arg2) {
    arg0.candidate = getStringFromWasm0(arg1, arg2);
}, arguments); }
export function __wbg_set_ice_servers_6f53a44e0587e42f() { return logError(function (arg0, arg1) {
    arg0.iceServers = arg1;
}, arguments); }
export function __wbg_set_ondatachannel_54d1710068091335() { return logError(function (arg0, arg1) {
    arg0.ondatachannel = arg1;
}, arguments); }
export function __wbg_set_onerror_df3caac09d010d29() { return logError(function (arg0, arg1) {
    arg0.onerror = arg1;
}, arguments); }
export function __wbg_set_onicecandidate_0fd31ace2f760bf0() { return logError(function (arg0, arg1) {
    arg0.onicecandidate = arg1;
}, arguments); }
export function __wbg_set_oniceconnectionstatechange_3170cd4b61eb8eb0() { return logError(function (arg0, arg1) {
    arg0.oniceconnectionstatechange = arg1;
}, arguments); }
export function __wbg_set_onicegatheringstatechange_c32363e95fcf9fef() { return logError(function (arg0, arg1) {
    arg0.onicegatheringstatechange = arg1;
}, arguments); }
export function __wbg_set_onmessage_5b4754d6f18ffa95() { return logError(function (arg0, arg1) {
    arg0.onmessage = arg1;
}, arguments); }
export function __wbg_set_onmessage_836d2f72130b4706() { return logError(function (arg0, arg1) {
    arg0.onmessage = arg1;
}, arguments); }
export function __wbg_set_onnegotiationneeded_4d72799b24f77b10() { return logError(function (arg0, arg1) {
    arg0.onnegotiationneeded = arg1;
}, arguments); }
export function __wbg_set_onopen_4f65470ae522a61a() { return logError(function (arg0, arg1) {
    arg0.onopen = arg1;
}, arguments); }
export function __wbg_set_onopen_8994b7ffb0ef2792() { return logError(function (arg0, arg1) {
    arg0.onopen = arg1;
}, arguments); }
export function __wbg_set_sdp_de28f5c5c5b94fcb() { return logError(function (arg0, arg1, arg2) {
    arg0.sdp = getStringFromWasm0(arg1, arg2);
}, arguments); }
export function __wbg_set_sdp_m_line_index_49082bcdf215d6f1() { return logError(function (arg0, arg1) {
    arg0.sdpMLineIndex = arg1 === 0xFFFFFF ? undefined : arg1;
}, arguments); }
export function __wbg_set_sdp_mid_c99b69998b5d136f() { return logError(function (arg0, arg1, arg2) {
    arg0.sdpMid = arg1 === 0 ? undefined : getStringFromWasm0(arg1, arg2);
}, arguments); }
export function __wbg_set_type_0a410d31ee19e04c() { return logError(function (arg0, arg1) {
    arg0.type = __wbindgen_enum_RtcSdpType[arg1];
}, arguments); }
export function __wbg_stack_3b0d974bbf31e44f() { return logError(function (arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}, arguments); }
export function __wbg_static_accessor_CREATE_TASK_7ee0dd8bc83df5b2() { return logError(function () {
    const ret = typeof console === 'undefined' ? null : console?.createTask;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_static_accessor_GLOBAL_4ef717fb391d88b7() { return logError(function () {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4() { return logError(function () {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_static_accessor_SELF_146583524fe1469b() { return logError(function () {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_static_accessor_WINDOW_f2829a2234d7819e() { return logError(function () {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_then_16d107c451e9905d() { return logError(function (arg0, arg1, arg2) {
    const ret = arg0.then(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_then_6ec10ae38b3e92f7() { return logError(function (arg0, arg1) {
    const ret = arg0.then(arg1);
    return ret;
}, arguments); }
export function __wbg_warn_b1370d804fa3e259() { return logError(function (arg0) {
    console.warn(arg0);
}, arguments); }
export function __wbindgen_cast_0000000000000001() { return logError(function (arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 523, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hb7f0f5e603e06e20);
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000002() { return logError(function (arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 545, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h1dabc74dfe29e3d3);
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000003() { return logError(function (arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 522, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__ha831da38b279acbc);
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000004() { return logError(function (arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("RTCDataChannelEvent")], shim_idx: 472, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h6b2a9392f4d4b2c2);
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000005() { return logError(function (arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("RTCPeerConnectionIceEvent")], shim_idx: 525, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h7692416e468df62b);
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000006() { return logError(function (arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 524, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h1ce9fd0ee37e393e);
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000007() { return logError(function (arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000008() { return logError(function (arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000009() { return logError(function (arg0) {
    // Cast intrinsic for `U64 -> Externref`.
    const ret = BigInt.asUintN(64, arg0);
    return ret;
}, arguments); }
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}

//#endregion
function wasm_bindgen__convert__closures_____invoke__h1ce9fd0ee37e393e(arg0, arg1) {
    _assertNum(arg0);
    _assertNum(arg1);
    wasm.wasm_bindgen__convert__closures_____invoke__h1ce9fd0ee37e393e(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h03478c30e0f6eee3(arg0, arg1) {
    _assertNum(arg0);
    _assertNum(arg1);
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h03478c30e0f6eee3(arg0, arg1);
    return ret !== 0;
}

function wasm_bindgen__convert__closures_____invoke__hb7f0f5e603e06e20(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    wasm.wasm_bindgen__convert__closures_____invoke__hb7f0f5e603e06e20(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__ha831da38b279acbc(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    wasm.wasm_bindgen__convert__closures_____invoke__ha831da38b279acbc(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h6b2a9392f4d4b2c2(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    wasm.wasm_bindgen__convert__closures_____invoke__h6b2a9392f4d4b2c2(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h7692416e468df62b(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    wasm.wasm_bindgen__convert__closures_____invoke__h7692416e468df62b(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h1dabc74dfe29e3d3(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h1dabc74dfe29e3d3(arg0, arg1, arg2);
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


//#region intrinsics
function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertBoolean(n) {
    if (typeof(n) !== 'boolean') {
        throw new Error(`expected a boolean argument, found ${typeof(n)}`);
    }
}

function _assertNum(n) {
    if (typeof(n) !== 'number') throw new Error(`expected a number argument, found ${typeof(n)}`);
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

function logError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        let error = (function () {
            try {
                return e instanceof Error ? `${e.message}\n\nStack:\n${e.stack}` : e.toString();
            } catch(_) {
                return "<failed to stringify thrown value>";
            }
        }());
        console.error("wasm-bindgen: imported JS function that was not marked as `catch` threw an error:", error);
        throw e;
    }
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
    if (typeof(arg) !== 'string') throw new Error(`expected a string argument, found ${typeof(arg)}`);
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
        if (ret.read !== arg.length) throw new Error('failed to pass whole string');
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


//#endregion

//#region wasm loading

let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}

//#endregion
