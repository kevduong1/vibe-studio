import { describe, expect, it } from "vitest";
import { trackedCommandProgram } from "./trackedCommand";

describe("tracked check command wrapper", () => {
  it("places a trailing comment before the subshell closure", () => {
    const program = trackedCommandProgram("printf ok # explanation", "run id", "nonce");
    expect(program).toContain("printf ok # explanation\n)\n__vibe_status=$?");
    expect(program).toContain("'run%20id' 'nonce'");
  });

  it("keeps a heredoc terminator on its own physical line", () => {
    const program = trackedCommandProgram("cat <<'EOF'\nhello\nEOF", "run", "nonce");
    expect(program).toContain("\nEOF\n)\n__vibe_status=$?");
  });
});
