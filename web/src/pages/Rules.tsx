import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";

export function Rules() {
  const { data: rules, refetch } = useQuery({ queryKey: ["rules"], queryFn: api.rules, refetchInterval: 5000 });
  const [toml, setToml] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [reloadNote, setReloadNote] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (body: string) => api.addRule(body),
    onSuccess: () => {
      setToml("");
      setAddError(null);
      void refetch();
    },
    onError: (e) => setAddError(`add rule failed: ${(e as Error).message}`),
  });

  const reload = useMutation({
    mutationFn: () => api.reloadRules(),
    onSuccess: () => {
      setReloadNote("rules reloaded");
      setReloadError(null);
      void refetch();
    },
    onError: (e) => {
      setReloadError(`reload failed: ${(e as Error).message}`);
      setReloadNote(null);
    },
  });

  return (
    <div className="page">
      <h1>rules</h1>

      <section>
        <h2>
          add rule{" "}
          <button disabled={toml.trim() === ""} onClick={() => add.mutate(toml)}>
            add rule
          </button>
        </h2>
        <textarea
          aria-label="rule toml"
          value={toml}
          onChange={(e) => setToml(e.target.value)}
          placeholder='[[rule]] id = "…"'
          rows={6}
        />
        {addError && (
          <p className="issues" role="alert">
            {addError}
          </p>
        )}
      </section>

      <section>
        <h2>
          stored rules <button onClick={() => reload.mutate()}>reload</button>
        </h2>
        {reloadNote && (
          <p className="note" role="status">
            {reloadNote}
          </p>
        )}
        {reloadError && (
          <p className="issues" role="alert">
            {reloadError}
          </p>
        )}
        {(rules ?? []).length === 0 && <p className="dim">no rules</p>}
        {(rules ?? []).map((r) => (
          <div className="rule" key={r.id}>
            <code>{r.id}</code> · {r.source} · conf {r.confidence.toFixed(2)} ·{" "}
            <span className={r.approved ? "on" : "off"}>{r.approved ? "approved" : "unapproved"}</span> ·{" "}
            <span className={r.active ? "on" : "off"}>{r.active ? "active" : "inactive"}</span>
            <span className="row-ts">{r.created_at}</span>
            <pre>{r.toml}</pre>
          </div>
        ))}
      </section>
    </div>
  );
}