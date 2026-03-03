import { useEffect, useRef, useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export const Route = createFileRoute("/_authenticated/terminal")({
  component: TerminalPage,
});

function TerminalPage() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (!terminalRef.current) return;

    // Clean up previous instance
    if (termRef.current) {
      termRef.current.dispose();
    }
    if (wsRef.current) {
      wsRef.current.close();
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        cursor: "#fafafa",
        selectionBackground: "#27272a",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(terminalRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${location.host}/ws/terminal`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      term.writeln("\x1b[32mConnecting to terminal...\x1b[0m");
      // Send initial resize
      ws.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "session") {
          console.log("[terminal] Session established:", msg.id);
          sessionIdRef.current = msg.id;
        } else if (msg.type === "data") {
          console.log(`[terminal] Received data (${msg.content.length} chars)`);
          term.write(msg.content);
        } else if (msg.type === "exit") {
          console.log("[terminal] Process exited:", msg.code);
          term.writeln(
            `\r\n\x1b[31mProcess exited with code ${msg.code}\x1b[0m`,
          );
        }
      } catch (err) {
        console.error("[terminal] Failed to handle message:", err, "raw:", event.data.slice(0, 200));
      }
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[33mDisconnected\x1b[0m");
    };

    ws.onerror = () => {
      term.writeln("\r\n\x1b[31mConnection error\x1b[0m");
    };

    // Send user input to WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Send resize events
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
  }, []);

  useEffect(() => {
    connect();

    const handleResize = () => {
      fitAddonRef.current?.fit();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [connect]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h1 className="text-sm font-medium">Terminal</h1>
        <button
          type="button"
          className="rounded-md bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
          onClick={() => {
            wsRef.current?.close();
            termRef.current?.clear();
            connect();
          }}
        >
          Reconnect
        </button>
      </div>
      <div
        ref={terminalRef}
        className="flex-1 bg-[#09090b] p-2"
        style={{ minHeight: 0 }}
      />
    </div>
  );
}
