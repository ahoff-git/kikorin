/* @ts-self-types="./engine.d.ts" */
import * as wasm from "./engine_bg.wasm";
import { __wbg_set_wasm } from "./engine_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    Engine
} from "./engine_bg.js";
export { wasm as __wasm }
