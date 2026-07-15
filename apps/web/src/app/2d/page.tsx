"use client";

import dynamic from "next/dynamic";

const Game2D = dynamic(() => import("../Game2D"), { ssr: false });

export default function Page2D() {
  return <Game2D />;
}
