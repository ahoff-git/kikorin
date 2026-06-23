import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from "three";

export const PERSON_COLLIDER = {
  halfWidth: 0.5,
  halfHeight: 0.5,
  halfDepth: 0.5,
};
const PERSON_GEOMETRY = new BoxGeometry(
  PERSON_COLLIDER.halfWidth * 2,
  PERSON_COLLIDER.halfHeight * 2,
  PERSON_COLLIDER.halfDepth * 2,
);
const PERSON_EDGE_GEOMETRY = new EdgesGeometry(PERSON_GEOMETRY);
const PERSON_BODY_COLOR = 0x66ccff;
const PERSON_FRONT_COLOR = 0xffe082;
const PERSON_TOUCH_COLOR = 0xff6b3d;
const PERSON_TOUCH_FRONT_COLOR = 0xffc46b;
const PERSON_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x16324f });

const PROJECTILE_RADIUS = 0.12;
const PROJECTILE_SCALE = {
  x: 0.82,
  y: 0.82,
  z: 1.35,
};
export const PROJECTILE_COLLIDER = {
  halfWidth: PROJECTILE_RADIUS * PROJECTILE_SCALE.x,
  halfHeight: PROJECTILE_RADIUS * PROJECTILE_SCALE.y,
  halfDepth: PROJECTILE_RADIUS * PROJECTILE_SCALE.z,
};
const PROJECTILE_GEOMETRY = new SphereGeometry(PROJECTILE_RADIUS, 14, 10);
const PROJECTILE_BODY_COLOR = 0xf97316;
const PROJECTILE_TOUCH_COLOR = 0xea580c;
const PROJECTILE_BASE_MATERIAL = new MeshBasicMaterial({
  color: PROJECTILE_BODY_COLOR,
});
const PROJECTILE_TOUCH_MATERIAL = new MeshBasicMaterial({
  color: PROJECTILE_TOUCH_COLOR,
});

export const FLOOR_COLLIDER = {
  halfWidth: 240,
  halfHeight: 1,
  halfDepth: 240,
};
export const FLOOR_TOP_Y = 0;
const FLOOR_GEOMETRY = new BoxGeometry(
  FLOOR_COLLIDER.halfWidth * 2,
  FLOOR_COLLIDER.halfHeight * 2,
  FLOOR_COLLIDER.halfDepth * 2,
);
const FLOOR_EDGE_GEOMETRY = new EdgesGeometry(FLOOR_GEOMETRY);
const FLOOR_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x445342 });
const FLOOR_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x243022 });
export const FLOOR_POSITION = {
  x: 0,
  y: FLOOR_TOP_Y - FLOOR_COLLIDER.halfHeight,
  z: 0,
};

function createPersonFaceMaterials(bodyColor: number, frontColor: number) {
  return [
    ...Array.from({ length: 5 }, () => {
      return new MeshBasicMaterial({ color: bodyColor });
    }),
    // BoxGeometry groups are +X, -X, +Y, -Y, +Z, -Z. This project treats -Z as forward.
    new MeshBasicMaterial({ color: frontColor }),
  ];
}

const PERSON_BASE_MATERIALS = createPersonFaceMaterials(
  PERSON_BODY_COLOR,
  PERSON_FRONT_COLOR,
);
const PERSON_TOUCH_MATERIALS = createPersonFaceMaterials(
  PERSON_TOUCH_COLOR,
  PERSON_TOUCH_FRONT_COLOR,
);

export function createPersonRenderMesh() {
  const mesh = new Mesh(PERSON_GEOMETRY, PERSON_BASE_MATERIALS);
  const outline = new LineSegments(PERSON_EDGE_GEOMETRY, PERSON_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.001);
  mesh.userData.baseMaterial = PERSON_BASE_MATERIALS;
  mesh.userData.touchMaterial = PERSON_TOUCH_MATERIALS;
  mesh.add(outline);
  return mesh;
}

export function createFloorRenderMesh() {
  const mesh = new Mesh(FLOOR_GEOMETRY, FLOOR_BASE_MATERIAL);
  const outline = new LineSegments(FLOOR_EDGE_GEOMETRY, FLOOR_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.0005);
  mesh.add(outline);
  return mesh;
}

export function createProjectileRenderMesh() {
  const mesh = new Mesh(PROJECTILE_GEOMETRY, PROJECTILE_BASE_MATERIAL);
  mesh.scale.set(
    PROJECTILE_SCALE.x,
    PROJECTILE_SCALE.y,
    PROJECTILE_SCALE.z,
  );
  mesh.userData.baseMaterial = PROJECTILE_BASE_MATERIAL;
  mesh.userData.touchMaterial = PROJECTILE_TOUCH_MATERIAL;
  return mesh;
}
