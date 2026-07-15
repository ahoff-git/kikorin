import { Box, Typography } from "@mui/material";
import Link from "next/link";

type GameCardProps = {
  href: string;
  title: string;
  description: string;
};

function GameCard({ href, title, description }: GameCardProps) {
  return (
    <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
      <Box
        sx={{
          border: "1px solid #333",
          borderRadius: 2,
          padding: 3,
          minWidth: 220,
          transition: "border-color 0.15s, background-color 0.15s",
          "&:hover": {
            borderColor: "#888",
            backgroundColor: "rgba(255,255,255,0.04)",
          },
        }}
      >
        <Typography variant="h5" component="div" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        <Typography variant="body2" sx={{ color: "#888", marginTop: 1 }}>
          {description}
        </Typography>
      </Box>
    </Link>
  );
}

export default function Landing() {
  return (
    <Box
      sx={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: 4,
        textAlign: "center",
      }}
    >
      <Box>
        <Typography variant="h2" component="h1" sx={{ fontWeight: 800, letterSpacing: -1 }}>
          Kikorin
        </Typography>
        <Typography variant="body1" sx={{ color: "#888", marginTop: 1, maxWidth: 480 }}>
          A small multiplayer arena shooter, in two flavors — same engine, two
          physics/rendering dimensions. Pick one to play.
        </Typography>
      </Box>

      <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "center" }}>
        <GameCard
          href="/3d"
          title="Kikorin 3D"
          description="Free-roam third-person arena: walk, jump, and fire bouncing blocks at monsters."
        />
        <GameCard
          href="/2d"
          title="Kikorin 2D"
          description="Side-view platformer: run, jump, and shoot across a flat arena."
        />
      </Box>

      <Typography variant="caption" sx={{ color: "#555" }}>
        Each game is its own multiplayer room — 2D and 3D players never share a session.
      </Typography>
    </Box>
  );
}
