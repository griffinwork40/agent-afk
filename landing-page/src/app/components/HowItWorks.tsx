"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface AgentNode {
  id: string;
  label: string;
  role: string;
  x: number;
  y: number;
  status: "idle" | "active" | "done";
  parentId?: string;
  delay: number;
}

const nodes: AgentNode[] = [
  { id: "root", label: "Root Agent", role: "Coordinator", x: 50, y: 8, status: "idle", delay: 0 },
  { id: "research", label: "Research", role: "read-only", x: 20, y: 35, status: "idle", parentId: "root", delay: 600 },
  { id: "implement", label: "Implement", role: "worktree", x: 50, y: 35, status: "idle", parentId: "root", delay: 800 },
  { id: "test", label: "Test", role: "verify", x: 80, y: 35, status: "idle", parentId: "root", delay: 1000 },
  { id: "scan-deps", label: "Scan deps", role: "explore", x: 10, y: 62, status: "idle", parentId: "research", delay: 1800 },
  { id: "scan-api", label: "Scan API", role: "explore", x: 30, y: 62, status: "idle", parentId: "research", delay: 2000 },
  { id: "build", label: "Build", role: "edit", x: 42, y: 62, status: "idle", parentId: "implement", delay: 2200 },
  { id: "lint", label: "Lint", role: "check", x: 58, y: 62, status: "idle", parentId: "implement", delay: 2400 },
  { id: "unit", label: "Unit tests", role: "run", x: 72, y: 62, status: "idle", parentId: "test", delay: 2600 },
  { id: "e2e", label: "E2E", role: "run", x: 90, y: 62, status: "idle", parentId: "test", delay: 2800 },
];

export default function HowItWorks() {
  const [activeNodes, setActiveNodes] = useState<Set<string>>(new Set());
  const [doneNodes, setDoneNodes] = useState<Set<string>>(new Set());
  const [isRunning, setIsRunning] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  const runAnimation = useCallback(() => {
    if (isRunning) return;
    setIsRunning(true);
    setActiveNodes(new Set());
    setDoneNodes(new Set());

    const timers: ReturnType<typeof setTimeout>[] = [];

    // Activate nodes with their delays
    nodes.forEach((node) => {
      timers.push(
        setTimeout(() => {
          setActiveNodes((prev) => new Set([...prev, node.id]));
        }, node.delay)
      );

      // Mark done after active
      const doneDuration = node.id === "root" ? 4500 : 1200 + Math.random() * 800;
      timers.push(
        setTimeout(() => {
          setDoneNodes((prev) => new Set([...prev, node.id]));
        }, node.delay + doneDuration)
      );
    });

    // Reset for replay
    timers.push(
      setTimeout(() => {
        setIsRunning(false);
      }, 5500)
    );

    return () => timers.forEach(clearTimeout);
  }, [isRunning]);

  // Auto-start on scroll into view
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || hasStarted) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !hasStarted) {
          setHasStarted(true);
          runAnimation();
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasStarted, runAnimation]);

  const getNodeColor = (id: string) => {
    if (doneNodes.has(id)) return "border-accent-green bg-accent-green/10 text-accent-green";
    if (activeNodes.has(id)) return "border-accent-primary bg-accent-primary/10 text-accent-secondary animate-pulse-glow";
    return "border-border-primary bg-bg-card text-text-muted";
  };

  const getLineColor = (childId: string) => {
    if (doneNodes.has(childId)) return "#22c55e";
    if (activeNodes.has(childId)) return "#6366f1";
    return "#2a2a3e";
  };

  return (
    <section id="how-it-works" className="relative py-24 px-6" ref={sectionRef}>
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            How <span className="gradient-text">delegation</span> works
          </h2>
          <p className="text-text-secondary max-w-2xl mx-auto mb-2">
            A root agent decomposes work into a DAG of sub-agents. Each layer
            runs in parallel. Sub-agents can spawn their own children up to
            depth 3.
          </p>
          <button
            onClick={runAnimation}
            disabled={isRunning}
            className="mt-4 px-4 py-2 text-sm rounded-lg border border-accent-primary/30 text-accent-secondary hover:bg-accent-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? "Running..." : "Replay animation"}
          </button>
        </div>

        {/* Interactive DAG visualization */}
        <div className="relative w-full max-w-4xl mx-auto" style={{ height: 420 }}>
          {/* SVG lines connecting nodes */}
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 100 80"
            preserveAspectRatio="xMidYMid meet"
          >
            {nodes
              .filter((n) => n.parentId)
              .map((node) => {
                const parent = nodes.find((p) => p.id === node.parentId)!;
                return (
                  <line
                    key={`${parent.id}-${node.id}`}
                    x1={parent.x}
                    y1={parent.y + 6}
                    x2={node.x}
                    y2={node.y - 2}
                    stroke={getLineColor(node.id)}
                    strokeWidth="0.3"
                    strokeDasharray={activeNodes.has(node.id) || doneNodes.has(node.id) ? "none" : "1,1"}
                    style={{ transition: "stroke 0.3s, stroke-dasharray 0.3s" }}
                  />
                );
              })}
          </svg>

          {/* Nodes */}
          {nodes.map((node) => (
            <div
              key={node.id}
              className={`absolute transform -translate-x-1/2 -translate-y-1/2 transition-all duration-500 ${
                activeNodes.has(node.id) || doneNodes.has(node.id)
                  ? "opacity-100 scale-100"
                  : hasStarted
                  ? "opacity-30 scale-95"
                  : "opacity-50 scale-95"
              }`}
              style={{
                left: `${node.x}%`,
                top: `${node.y / 80 * 100}%`,
              }}
            >
              <div
                className={`px-3 py-2 rounded-lg border text-center whitespace-nowrap transition-all duration-300 ${getNodeColor(
                  node.id
                )}`}
              >
                <div className="text-xs font-semibold">{node.label}</div>
                <div className="text-[10px] opacity-70">{node.role}</div>
                {doneNodes.has(node.id) && (
                  <span className="absolute -top-1 -right-1 text-xs">&#10003;</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-6 mt-8 text-xs text-text-muted">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded border border-border-primary bg-bg-card" />
            <span>Idle</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded border border-accent-primary bg-accent-primary/10" />
            <span>Active</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded border border-accent-green bg-accent-green/10" />
            <span>Done</span>
          </div>
        </div>
      </div>
    </section>
  );
}
