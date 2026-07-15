// Shared Three.js mesh-building blocks for the 2D and 3D games — pure
// geometry/material construction, no engine or adapter knowledge. Each game
// supplies its own dimensions, colors, and shadow settings.

import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
} from "three";

/** A box with a slightly-oversized wireframe outline (renderOrder 1 so it draws on top). */
export function makeEdgedBox(
  hw: number,
  hh: number,
  hd: number,
  color: number,
  edgeColor: number,
  opts?: { shadow?: boolean },
): Object3D {
  const geo = new BoxGeometry(hw * 2, hh * 2, hd * 2);
  const mesh = new Mesh(geo, new MeshLambertMaterial({ color }));
  const shadow = opts?.shadow ?? false;
  mesh.receiveShadow = shadow;
  mesh.castShadow = shadow;
  const line = new LineSegments(new EdgesGeometry(geo), new LineBasicMaterial({ color: edgeColor }));
  line.renderOrder = 1;
  line.scale.setScalar(1.0005);
  mesh.add(line);
  return mesh;
}

/** A humanoid stand-in: one box, front face tinted differently so facing reads at a glance. */
export function makePersonMesh(
  halfW: number,
  halfH: number,
  halfD: number,
  bodyColor: number,
  frontColor: number,
  opts?: { castShadow?: boolean },
): Object3D {
  const group = new Group();
  const geo = new BoxGeometry(halfW * 2, halfH * 2, halfD * 2);
  const bodyMat = new MeshLambertMaterial({ color: bodyColor });
  const frontMat = new MeshLambertMaterial({ color: frontColor });
  const body = new Mesh(geo, [bodyMat, bodyMat, bodyMat, bodyMat, frontMat, bodyMat]);
  body.castShadow = opts?.castShadow ?? false;
  group.add(body);
  return group;
}
