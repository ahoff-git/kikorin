"use client";

import dynamic from "next/dynamic";

const Game3D = dynamic(() => import("../Game3D"), { ssr: false });

export default function Page3D() {
  return <Game3D />;
}
