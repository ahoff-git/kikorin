import { Box } from "@mui/material";
type LayoutProps = {
  header?: React.ReactNode
  left?: React.ReactNode
  right?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
}
export function PageLayout({
  header,
  left,
  right,
  footer,
  children,
}: LayoutProps) {
  return (
    <Box
      sx={{
        position: "fixed",
        inset: 0,
        boxSizing: "border-box",
        minWidth: 0,
        overflow: "hidden",
        display: "grid",
        height: "100dvh",
        gridTemplateRows: "auto 1fr auto",
      }}
    >
      <Box component="header">{header}</Box>

      <Box
        component="main"
        sx={{
          display: "grid",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          gridTemplateColumns: {
            xs: "1fr",
            md: "clamp(200px, 20%, 300px) minmax(0, 1fr) clamp(200px, 20%, 300px)",
          },
          columnGap: 2,
        }}
      >
        <Box sx={{ display: { xs: "none", md: "block" }, minWidth: 0, minHeight: 0, overflow: "auto" }}>{left}</Box>
        <Box sx={{ minWidth: 0, minHeight:0, display: "flex", flexDirection: "column" }}>
          {children}
        </Box>
        <Box sx={{ display: { xs: "none", md: "block" }, minWidth: 0, minHeight: 0, overflow: "auto" }}>{right}</Box>
      </Box>

      <Box component="footer">{footer}</Box>
    </Box>
  )
}
