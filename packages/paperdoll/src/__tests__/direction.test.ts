import { describe, it, expect } from "vitest";
import {
  directionFromYaw,
  directionFromYawRelativeToCamera,
  DIRECTION_LABELS,
} from "../direction";

const PI = Math.PI;

describe("directionFromYaw", () => {
  // Yaw 0 faces +Z (south); yaw increases turning toward +X (east). Direction
  // index runs opposite yaw. These pin the full ring so a future refactor can't
  // silently rotate the mapping.
  const cases: Array<[number, number, string]> = [
    [0, 0, "S"],
    [-PI / 4, 1, "SW"],
    [-PI / 2, 2, "W"],
    [(-3 * PI) / 4, 3, "NW"],
    [PI, 4, "N"],
    [(3 * PI) / 4, 5, "NE"],
    [PI / 2, 6, "E"],
    [PI / 4, 7, "SE"],
  ];

  for (const [yaw, expected, label] of cases) {
    it(`yaw ${yaw.toFixed(3)} -> ${label} (${expected})`, () => {
      expect(directionFromYaw(yaw)).toBe(expected);
      expect(DIRECTION_LABELS[expected]).toBe(label);
    });
  }

  it("wraps negative and >2π yaws", () => {
    expect(directionFromYaw(-PI)).toBe(4); // -π == π == N
    expect(directionFromYaw(2 * PI)).toBe(0); // full turn == S
  });

  it("snaps a between-rows yaw to the nearer row", () => {
    // Slightly past due-south toward SE stays S; near the SE boundary flips.
    expect(directionFromYaw(-0.1)).toBe(0);
    expect(directionFromYaw(PI / 8 + 0.01)).toBe(7);
  });
});

describe("directionFromYawRelativeToCamera", () => {
  it("collapses to directionFromYaw at azimuth 0", () => {
    expect(directionFromYawRelativeToCamera(PI / 2, 0)).toBe(directionFromYaw(PI / 2));
  });

  it("rotates the shown row by the camera azimuth", () => {
    // Entity faces south; a camera a quarter-turn away shows its west row.
    expect(directionFromYawRelativeToCamera(0, PI / 2)).toBe(2);
  });
});
