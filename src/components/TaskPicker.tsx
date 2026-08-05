/**
 * VS Code-style quick-pick overlay for running .vscode/tasks.json tasks
 * (⌘⇧B). Pure presentation: App.tsx loads the tasks and runs the pick via
 * lib/taskRunner. Keyboard handling lives on the dialog wrapper so it covers
 * the filter input and the list buttons alike.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskDef } from "../lib/tasks";
import { useNativeOverlay } from "../lib/nativeOverlays";
import "./TaskPicker.css";

export default function TaskPicker({
  tasks,
  error,
  onRun,
  onClose,
}: {
  tasks: TaskDef[];
  /** tasks.json parse failure to surface instead of "no tasks". */
  error: string | null;
  onRun: (task: TaskDef) => void;
  onClose: () => void;
}) {
  useNativeOverlay();
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? tasks.filter((t) =>
          `${t.label} ${t.detail ?? ""}`.toLowerCase().includes(q),
        )
      : tasks;
  }, [tasks, filter]);
  const sel = Math.max(0, Math.min(index, shown.length - 1));

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The picker owns the keyboard while open: unhandled combos must not
    // reach the window-level shortcuts (⌘W/⌘1-9 would close or switch the
    // workspace underneath the open picker).
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(sel + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[sel]) onRun(shown[sel]);
    }
  };

  return (
    <div className="task-picker-backdrop" onMouseDown={onClose}>
      <div
        className="task-picker"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="text-input"
          placeholder="Select a task to run…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setIndex(0);
          }}
        />
        <div className="task-picker-list" ref={listRef}>
          {shown.map((t, i) => (
            <button
              key={`${t.label}:${i}`}
              className={`task-picker-item ${i === sel ? "selected" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onRun(t)}
            >
              <span className="task-picker-row">
                <span className="truncate">{t.label}</span>
                {t.group === "build" && (
                  <span className="task-picker-badge">
                    {t.isDefaultBuild ? "default build" : "build"}
                  </span>
                )}
              </span>
              {t.detail && (
                <span className="task-picker-detail truncate">{t.detail}</span>
              )}
            </button>
          ))}
          {shown.length === 0 && (
            <div className="task-picker-empty">
              {error ??
                (tasks.length
                  ? "No matching tasks"
                  : "No tasks found in .vscode/tasks.json")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
