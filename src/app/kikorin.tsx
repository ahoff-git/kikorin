import {update, world} from "../packages/core/core";


requestAnimationFrame(function animate() {
    update(world);
    requestAnimationFrame(animate);
})