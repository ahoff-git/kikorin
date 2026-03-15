import type { CSSProperties, ReactNode } from "react";
import styles from "./kikorinLayout.module.css";

type LayoutProps = {
  header?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
};

const rootStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  boxSizing: "border-box",
  minWidth: 0,
  overflow: "hidden",
  display: "grid",
  height: "100dvh",
  gridTemplateRows: "auto 1fr auto",
};

const mainStyle: CSSProperties = {
  display: "grid",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  columnGap: 16,
};

const sidePanelStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  overflow: "auto",
};

const centerPanelStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

export function PageLayout({
  header,
  left,
  right,
  footer,
  children,
}: LayoutProps) {
  return (
    <div style={rootStyle}>
      <header>{header}</header>

      <main className={styles.main} style={mainStyle}>
        <div className={styles.sidePanel} style={sidePanelStyle}>
          {left}
        </div>
        <div style={centerPanelStyle}>{children}</div>
        <div className={styles.sidePanel} style={sidePanelStyle}>
          {right}
        </div>
      </main>

      <footer>{footer}</footer>
    </div>
  );
}
