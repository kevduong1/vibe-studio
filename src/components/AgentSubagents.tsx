import {
  selectAgentSubagents,
  useAgentRuntimeStore,
} from "../stores/agentRuntime";

/** Read-only, privacy-bounded child-agent view. Process arguments and
 * terminal text never enter this model; rows live only for one occupant
 * generation and are rebuilt from the macOS descendant snapshot. */
export function AgentSubagents({ terminalId }: { terminalId: string }) {
  const rows = useAgentRuntimeStore(
    (state) => selectAgentSubagents(state, terminalId),
  );
  if (rows.length === 0) return null;
  return (
    <div className="agent-subagents" aria-label="Child agents">
      <div className="agent-subagents-title">
        {rows.length} child agent{rows.length === 1 ? "" : "s"}
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          className="agent-subagent-row"
          title={`Read-only process view\n${row.executable} · PID ${row.pid}\nParent PID ${row.parentPid}`}
        >
          <span className={`agent-subagent-dot ${row.foreground ? "foreground" : ""}`} />
          <span>{row.executable}</span>
          <span className="agent-subagent-pid">PID {row.pid}</span>
        </div>
      ))}
    </div>
  );
}
