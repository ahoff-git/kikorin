"use client";

import dynamic from "next/dynamic";

const GameTopDown = dynamic(() => import("../GameTopDown"), { ssr: false });

export default function PageTopDown() {
  return <GameTopDown />;
}
