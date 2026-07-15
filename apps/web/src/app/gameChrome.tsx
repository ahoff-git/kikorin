"use client";

// Shared UI chrome for the 2D and 3D game pages (Game2D.tsx / Game3D.tsx) —
// the panel layout, chat, and multiplayer connection UI are identical
// between the two games; only the canvas/controls/gameplay differ.

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { type Time, useKikorinEvent } from "@kikorin/react";
import { Box } from "@mui/material";
import { PAGE_COLUMN_TEMPLATE } from "./kikorinLayout";
import type { ChatMessage, ChatChannel } from "./useNetworking";
import { channelLabel } from "./chat";

export const canvasViewportStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  position: "relative",
};

export const canvasStyle: CSSProperties = {
  flex: 1,
  width: "100%",
  height: "100%",
  display: "block",
  touchAction: "none",
  cursor: "default",
};

export const headerStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
};

export const gameTitleLinkStyle: CSSProperties = {
  fontWeight: 700,
  whiteSpace: "nowrap",
  color: "inherit",
  textDecoration: "none",
};

export const navStyle: CSSProperties = {
  padding: "16px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

export const sectionLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

export const helperTextStyle: CSSProperties = {
  lineHeight: 1.6,
  color: "#555",
};

const chatBoxStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const chatLogStyle: CSSProperties = {
  height: 140,
  overflowY: "auto",
  background: "#111",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "monospace",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const chatInputRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
};

const chatInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "monospace",
  fontSize: 11,
};

const channelRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  flexWrap: "wrap",
  alignItems: "center",
};

function channelButtonStyle(active: boolean): CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    border: active ? "1px solid #4ade80" : "1px solid #555",
    background: active ? "#1c3a24" : "transparent",
    color: active ? "#4ade80" : "#aaa",
    cursor: "pointer",
  };
}

const groupJoinRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  marginTop: 4,
};

const groupJoinInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "monospace",
  fontSize: 11,
};

const networkPanelStyle: CSSProperties = { marginTop: 16 };

const networkRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  alignItems: "center",
  marginTop: 4,
};

const networkIdStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  wordBreak: "break-all",
  flex: 1,
};

const networkInputStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  flex: 1,
  minWidth: 0,
};

const networkPeerItemStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  marginTop: 2,
  color: "#ff44aa",
};

export function useTimeMetrics(): Time | null {
  const [timeMetrics, setTimeMetrics] = useState<Time | null>(null);
  useKikorinEvent("ui:timeMetricsUpdate", ({ timeMetrics }) => setTimeMetrics(timeMetrics));
  return timeMetrics;
}

export function GameHeader({
  title,
  controlInstructions,
  spawnLabel,
  onSpawnMonsters,
}: {
  title: string;
  controlInstructions: string;
  spawnLabel: string;
  onSpawnMonsters: () => void;
}) {
  return (
    <div style={headerStyle}>
      <a href="/" style={gameTitleLinkStyle}>{title}</a>
      <span>{controlInstructions}</span>
      <button type="button" onClick={onSpawnMonsters}>
        {spawnLabel}
      </button>
    </div>
  );
}

export function GameLeftNav({ controlInstructions }: { controlInstructions: string }) {
  return (
    <div style={navStyle}>
      <div style={sectionLabelStyle}>Controls</div>
      <div style={helperTextStyle}>{controlInstructions}</div>
    </div>
  );
}

export function RightPanel({
  timeMetrics,
  localPeerId,
  transportError,
  connectedPeers,
  onConnect,
  chatMessages,
  onSendChat,
  activeChatChannel,
  onSelectChatChannel,
  joinedChatGroups,
  onJoinChatGroup,
  onLeaveChatGroup,
}: {
  timeMetrics: Time | null;
  localPeerId: string | null;
  transportError: string | null;
  connectedPeers: string[];
  onConnect: (peerId: string) => void;
  chatMessages: ChatMessage[];
  onSendChat: (text: string) => void;
  activeChatChannel: ChatChannel;
  onSelectChatChannel: (channel: ChatChannel) => void;
  joinedChatGroups: string[];
  onJoinChatGroup: (name: string) => void;
  onLeaveChatGroup: (name: string) => void;
}) {
  // avgDelta = EMA of the Rust tick's execution cost; ticksPerSecond = actual
  // ticks per wall-clock second measured from the bundle tick counter.
  const tickCostMs = Math.round((timeMetrics?.avgDelta ?? 0) * 10) / 10;
  const ticksPerSecond = Math.round(timeMetrics?.ticksPerSecond ?? 0);

  return (
    <div>
      <div>Tick cost: {tickCostMs} ms</div>
      <div>TPS: {ticksPerSecond}</div>
      <ChatBox
        messages={chatMessages}
        onSend={onSendChat}
        activeChannel={activeChatChannel}
        onSelectChannel={onSelectChatChannel}
        joinedGroups={joinedChatGroups}
        onJoinGroup={onJoinChatGroup}
        onLeaveGroup={onLeaveChatGroup}
      />
      <NetworkPanel
        localPeerId={localPeerId}
        transportError={transportError}
        connectedPeers={connectedPeers}
        onConnect={onConnect}
      />
    </div>
  );
}

function ChatBox({
  messages,
  onSend,
  activeChannel,
  onSelectChannel,
  joinedGroups,
  onJoinGroup,
  onLeaveGroup,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  activeChannel: ChatChannel;
  onSelectChannel: (channel: ChatChannel) => void;
  joinedGroups: string[];
  onJoinGroup: (name: string) => void;
  onLeaveGroup: (name: string) => void;
}) {
  const [input, setInput] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  function handleJoinGroup() {
    const trimmed = groupInput.trim();
    if (!trimmed) return;
    onJoinGroup(trimmed);
    onSelectChannel({ kind: "group", name: trimmed });
    setGroupInput("");
  }

  function handleGroupKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleJoinGroup();
  }

  const isActive = (channel: ChatChannel) =>
    channel.kind === activeChannel.kind
    && (channel.kind !== "group" || (activeChannel.kind === "group" && activeChannel.name === channel.name));

  return (
    <div style={chatBoxStyle}>
      <div style={sectionLabelStyle}>Chat</div>

      {/* Channel picks where the next message you send goes; messages from
          every channel you can currently see (global, nearby in range, and
          your joined groups) all show in the one log below. */}
      <div style={channelRowStyle}>
        <button
          type="button"
          style={channelButtonStyle(isActive({ kind: "global" }))}
          onClick={() => onSelectChannel({ kind: "global" })}
        >
          Global
        </button>
        <button
          type="button"
          style={channelButtonStyle(isActive({ kind: "nearby" }))}
          onClick={() => onSelectChannel({ kind: "nearby" })}
        >
          Nearby
        </button>
        {joinedGroups.map((name) => (
          <button
            type="button"
            key={name}
            style={channelButtonStyle(isActive({ kind: "group", name }))}
            onClick={() => onSelectChannel({ kind: "group", name })}
            onDoubleClick={() => onLeaveGroup(name)}
            title="Double-click to leave"
          >
            #{name}
          </button>
        ))}
      </div>
      <div style={groupJoinRowStyle}>
        <input
          style={groupJoinInputStyle}
          placeholder="Join a group…"
          value={groupInput}
          onChange={(e) => setGroupInput(e.target.value)}
          onKeyDown={handleGroupKeyDown}
        />
        <button type="button" onClick={handleJoinGroup} disabled={!groupInput.trim()}>
          Join
        </button>
      </div>

      <div ref={logRef} style={chatLogStyle}>
        {messages.length === 0 ? (
          <div style={{ color: "#555" }}>No messages yet</div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              style={{ color: msg.from === "system" ? "#888" : msg.from === "me" ? "#4ade80" : "#ff44aa" }}
            >
              {msg.from === "system" ? (
                <>* {msg.text}</>
              ) : (
                <>
                  <span style={{ fontWeight: 700 }}>{msg.from === "me" ? "You" : msg.displayName}</span>
                  <span style={{ color: "#666" }}> [{channelLabel(msg.channel)}]</span>
                  {": "}
                  {msg.text}
                </>
              )}
            </div>
          ))
        )}
      </div>
      <div style={chatInputRowStyle}>
        <input
          style={chatInputStyle}
          placeholder={`Message ${channelLabel(activeChannel)}…`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="button" onClick={handleSend} disabled={!input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

function NetworkPanel({
  localPeerId,
  transportError,
  connectedPeers,
  onConnect,
}: {
  localPeerId: string | null;
  transportError: string | null;
  connectedPeers: string[];
  onConnect: (peerId: string) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  function handleCopy() {
    if (!localPeerId) return;
    void navigator.clipboard.writeText(localPeerId).then(() => {
      setCopied(true);
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleConnect() {
    const trimmed = inputValue.trim();
    if (!trimmed || !localPeerId) return;
    onConnect(trimmed);
    setInputValue("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConnect();
  }

  return (
    <div style={networkPanelStyle}>
      <div style={sectionLabelStyle}>Multiplayer</div>

      {transportError && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#f97316" }}>
          Transport error: {transportError}
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 11, color: "#555" }}>Your ID</div>
        <div style={networkRowStyle}>
          <span style={networkIdStyle}>
            {localPeerId ?? "connecting…"}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!localPeerId}
            style={{ whiteSpace: "nowrap" }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, color: "#555" }}>Connect to peer</div>
        <div style={networkRowStyle}>
          <input
            style={networkInputStyle}
            placeholder="Paste peer ID…"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!localPeerId}
          />
          <button
            type="button"
            onClick={handleConnect}
            disabled={!localPeerId || !inputValue.trim()}
          >
            Join
          </button>
        </div>
      </div>

      {connectedPeers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "#555" }}>
            Connected ({connectedPeers.length})
          </div>
          {connectedPeers.map((id) => (
            <div key={id} style={networkPeerItemStyle}>
              {id}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function useFps(): number {
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let rafId: number;

    function frame() {
      frameCount++;
      const now = performance.now();
      const elapsed = now - lastTime;
      if (elapsed >= 1000) {
        setFps(Math.round((frameCount * 1000) / elapsed));
        frameCount = 0;
        lastTime = now;
      }
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return fps;
}

export function Footer() {
  const fps = useFps();
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: PAGE_COLUMN_TEMPLATE,
        columnGap: 2,
        px: 0,
        py: "6px",
      }}
    >
      <Box
        sx={{
          display: { xs: "none", md: "flex" },
          alignItems: "center",
          justifyContent: "flex-end",
          fontSize: 11,
          color: "#555",
          pr: 1,
        }}
      >
        {fps} FPS
      </Box>
      <Box />
      <Box sx={{ display: { xs: "none", md: "block" } }} />
    </Box>
  );
}
