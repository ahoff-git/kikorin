import { type Vec3, type Velocity } from "@/packages/core/core";

export function normalizeVector(vector: Velocity): Velocity {
  const normalizedVector = normalizeVectorOrNull(vector);
  if (normalizedVector) {
    return normalizedVector;
  }

  return { x: 0, y: 0, z: -1 };
}

export function normalizeVectorOrNull(vector: Velocity): Velocity | null {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length === 0) {
    return null;
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

export function scaleVector(vector: Velocity, scalar: number): Velocity {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  };
}

export function addVectors(a: Velocity, b: Vec3): Velocity {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

export function invertVector(vector: Vec3): Velocity {
  return {
    x: -vector.x,
    y: -vector.y,
    z: -vector.z,
  };
}

export function dotVectors(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
