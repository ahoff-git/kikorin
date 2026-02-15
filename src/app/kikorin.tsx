import { setupCoreWorld, CoreWorld, CoreWorldBox } from "../packages/core/core";

export type World = {UniqueTestThing: "Testing123"} & CoreWorld;
export type WorldBox = CoreWorldBox & World;
function setupWorld(){ 
    console.log("DOING SETUP")
    return setupCoreWorld() as WorldBox;
}

export { setupWorld };
