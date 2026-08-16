import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";

export function Intake() {
  const { data: items } = useQuery({ queryKey: ["intake"], queryFn: api.intake, refetchInterval: 5000 });

  return (
    <div className="page">
      <h1>intake</h1>
      {(items ?? []).length === 0 && <p className="dim">no intake items</p>}
      {(items ?? []).map((item) => (
        <div className="intake-row" key={item.id}>
          <span className={item.kind}>{item.kind}</span>{" "}
          <span>{item.title}</span>{" "}
          <span className="dim">{item.severity ?? "—"}</span>{" "}
          {item.graph_id ? (
            <a href={`#/graphs/${item.graph_id}`}>{item.graph_id}</a>
          ) : (
            <span className="dim">—</span>
          )}
          <span className="row-ts">{item.received_at}</span>
        </div>
      ))}
    </div>
  );
}