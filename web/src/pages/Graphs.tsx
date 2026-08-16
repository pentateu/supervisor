import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, parseGraph } from "../api/endpoints";
import { useGraphLiveStates } from "../lib/use-graph-live";
import { WorkflowCanvas } from "../components/WorkflowCanvas";
import { validateGraph, updateNode, addNode, type GraphIssue } from "../lib/graph-edit";
import type { GraphDef, LoopBack, NodeDef } from "../api/types";

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

  // loop_back keeps its `on` key only while it has a value: an empty on must
  // not serialize (`LoopBack.on` is optional on the wire, §4.11).
  const loopBack: LoopBack = selectedNode?.loop_back ?? { small: "", big: "" };
  // I3-review minor: the clear affordance appears whenever the node HAS a
  // loop_back object — a partially-filled one must be clearable too — and
  // clearing nulls it.
  const canClearLoopBack = selectedNode?.loop_back != null;
  const patchLoopBack = (next: LoopBack) => {
    const { on, ...rest } = next;
    patch({ loop_back: on ? { ...rest, on } : rest });
  };
  const rerunMax = typeof selectedNode?.on_error === "string" ? 1 : (selectedNode?.on_error.rerun.max ?? 1);

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
              agent_id
              <input
                value={selectedNode.agent_id ?? ""}
                onChange={(e) => patch({ agent_id: e.target.value === "" ? null : e.target.value })}
              />
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
              done_when.approved
              <input
                type="checkbox"
                checked={selectedNode.done_when.approved === true}
                onChange={(e) => patch({ done_when: { ...selectedNode.done_when, approved: e.target.checked } })}
              />
            </label>
            <label>
              done_when.match
              <input
                value={selectedNode.done_when.match ?? ""}
                onChange={(e) => patch({ done_when: { ...selectedNode.done_when, match: e.target.value } })}
              />
            </label>
            <label>
              on_error
              <select
                value={typeof selectedNode.on_error === "string" ? selectedNode.on_error : "rerun"}
                onChange={(e) => {
                  const kind = e.target.value;
                  patch(
                    kind === "rerun"
                      ? { on_error: { rerun: { max: rerunMax } } }
                      : { on_error: kind as "delegate" | "skip" },
                  );
                }}
              >
                <option value="delegate">delegate</option>
                <option value="skip">skip</option>
                <option value="rerun">rerun</option>
              </select>
            </label>
            {typeof selectedNode.on_error !== "string" && (
              <label>
                on_error.max
                <input
                  type="number"
                  min={1}
                  value={selectedNode.on_error.rerun.max}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value));
                    if (Number.isFinite(n) && n >= 1) patch({ on_error: { rerun: { max: n } } });
                  }}
                />
              </label>
            )}
            <label>
              gate
              <input
                value={selectedNode.gate ?? ""}
                onChange={(e) => patch({ gate: e.target.value === "" ? null : e.target.value })}
              />
            </label>
            <label>
              loop_back.on
              <input
                value={loopBack.on ?? ""}
                onChange={(e) => patchLoopBack({ ...loopBack, on: e.target.value })}
              />
            </label>
            <label>
              loop_back.small
              <input value={loopBack.small} onChange={(e) => patchLoopBack({ ...loopBack, small: e.target.value })} />
            </label>
            <label>
              loop_back.big
              <input value={loopBack.big} onChange={(e) => patchLoopBack({ ...loopBack, big: e.target.value })} />
            </label>
            {canClearLoopBack && <button onClick={() => patch({ loop_back: null })}>clear loop_back</button>}
            <label>
              mode
              <select value={selectedNode.mode} onChange={(e) => patch({ mode: e.target.value as NodeDef["mode"] })}>
                <option value="foreground">foreground</option>
                <option value="background">background</option>
              </select>
            </label>
            <label>
              timeout_secs
              <input
                type="number"
                min={1}
                value={selectedNode.timeout_secs ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    patch({ timeout_secs: null });
                    return;
                  }
                  const n = Math.floor(Number(raw));
                  if (Number.isFinite(n) && n >= 1) patch({ timeout_secs: n });
                }}
              />
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
