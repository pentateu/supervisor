import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, parseGraph } from "../api/endpoints";
import { useGraphLiveStates } from "../lib/use-graph-live";
import { WorkflowCanvas } from "../components/WorkflowCanvas";
import { validateGraph, updateNode, addNode, type GraphIssue } from "../lib/graph-edit";
import type { GraphDef, NodeDef } from "../api/types";

const ROLE_PALETTE = ["dev", "reviewer", "tester", "designer", "memory-keeper"];

function Editor({ graph }: { graph: GraphDef }) {
  const [edit, setEdit] = useState<GraphDef>(graph);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const issues: GraphIssue[] = validateGraph(edit);
  // B2: the 2s poll is gone — SSE node states drive the "running" badge.
  const liveStates = useGraphLiveStates(undefined, graph);
  const running = Object.values(liveStates.states).some((s) => s === "running");

  const save = async () => {
    setSaveError(null);
    try {
      await api.saveGraph(edit.id, JSON.stringify(edit, null, 2));
    } catch (e) {
      // I-28: a failed save must not be silent (a daemon restart mid-edit
      // used to make the button do nothing).
      setSaveError(`save failed: ${(e as Error).message}`);
    }
  };

  const selectedNode = edit.nodes.find((n) => n.id === selected);

  const patch = (p: Partial<NodeDef>) => {
    if (!selected) return;
    setEdit((g) => updateNode(g, selected, p));
  };

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <button disabled={issues.length > 0} onClick={() => void save()}>
          save
        </button>
        {running && <span className="badge-running">running — save applies to the next run</span>}
        {issues.length > 0 && (
          <span className="issues">{issues.map((i) => i.message).join("; ")}</span>
        )}
        {saveError && (
          <span className="issues" role="alert">
            {saveError}
          </span>
        )}
      </div>

      <div className="editor-body">
        <aside className="palette">
          <strong>palette</strong>
          {ROLE_PALETTE.map((role) => (
            <button
              key={role}
              onClick={() => {
                const id = `${role}_${edit.nodes.length + 1}`;
                setEdit((g) =>
                  addNode(g, {
                    id,
                    role,
                    depends_on: [],
                    start_template: `Do the ${role} task for {feature}.`,
                    done_when: { ack: id },
                    on_error: "delegate",
                    mode: "foreground",
                  }),
                );
                setSelected(id);
              }}
            >
              + {role}
            </button>
          ))}
        </aside>

        <div className="editor-canvas">
          <WorkflowCanvas
            graph={edit}
            mode="edit"
            onChange={setEdit}
            onNodeClick={(n) => setSelected(n.id)}
          />
        </div>

        {selectedNode && (
          <aside className="properties">
            <strong>{selectedNode.id}</strong>
            <label>
              role
              <input value={selectedNode.role} onChange={(e) => patch({ role: e.target.value })} />
            </label>
            <label>
              start_template
              <textarea
                value={selectedNode.start_template}
                onChange={(e) => patch({ start_template: e.target.value })}
              />
            </label>
            <label>
              done_when.ack
              <input
                value={selectedNode.done_when.ack ?? ""}
                onChange={(e) => patch({ done_when: { ...selectedNode.done_when, ack: e.target.value } })}
              />
            </label>
            <label>
              mode
              <select value={selectedNode.mode} onChange={(e) => patch({ mode: e.target.value as NodeDef["mode"] })}>
                <option value="foreground">foreground</option>
                <option value="background">background</option>
              </select>
            </label>
          </aside>
        )}
      </div>
    </div>
  );
}

export function Graphs({ id }: { id?: string }) {
  const { data: graphs } = useQuery({ queryKey: ["graphs"], queryFn: api.graphs, refetchInterval: 5000 });
  const selected = (graphs ?? []).find((g) => g.id === id);
  const selectedGraph = useMemo(() => (selected ? parseGraph(selected.data) : null), [selected]);
  // B2: node states load once (no ws → all workspaces), then the SSE reducer
  // is the single state authority. Idle = no node mid-run: last-run states
  // at low emphasis with an "idle — last run" caption.
  const liveStates = useGraphLiveStates(undefined, selectedGraph);

  return (
    <div className="page">
      <h1>graphs</h1>
      <ul className="graph-list">
        {(graphs ?? []).map((g) => {
          const parsed = parseGraph(g.data);
          return (
            <li key={g.id}>
              <a href={`#/graphs/${g.id}`}>
                {g.id}{" "}
                <span className="dim">
                  v{g.version} · {parsed.nodes.length} nodes
                </span>
              </a>
            </li>
          );
        })}
      </ul>

      {selectedGraph && id && (
        <>
          <h2>{id} — live</h2>
          <div className="graph-live">
            <WorkflowCanvas
              graph={selectedGraph}
              mode="live"
              nodeStates={liveStates.states}
              idle={liveStates.idle}
              lastRun={liveStates.lastRun}
              animatingEdges={liveStates.animatingEdges}
            />
          </div>
          <h2>{id} — edit</h2>
          <Editor key={id} graph={selectedGraph} />
        </>
      )}
    </div>
  );
}
