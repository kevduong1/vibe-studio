import { describe, expect, it } from "vitest";
import type { RefLabel } from "./ipc";
import { graphRefPillPresentation } from "./gitGraphRefs";

const local = (name: string): RefLabel => ({ name, kind: "local" });

describe("commit graph ref pills", () => {
  it("fills the named checked-out branch when local refs share HEAD", () => {
    const refs = [local("main"), local("new-branch")];

    const result = graphRefPillPresentation(refs, true, "new-branch");

    expect(result.shown.map((ref) => ref.name)).toEqual(["new-branch", "main"]);
    expect(result.headIdx).toBe(0);
    expect(refs.map((ref) => ref.name)).toEqual(["main", "new-branch"]);
  });

  it("keeps the checked-out branch visible when HEAD has many refs", () => {
    const result = graphRefPillPresentation(
      [local("main"), local("release"), local("topic")],
      true,
      "topic",
    );

    expect(result.shown.map((ref) => ref.name)).toContain("topic");
    expect(result.extra).toBe(1);
    expect(result.headIdx).toBe(0);
  });

  it("does not fill an arbitrary local branch for detached HEAD", () => {
    const result = graphRefPillPresentation(
      [local("main"), local("release")],
      true,
      undefined,
    );

    expect(result.headIdx).toBe(-1);
  });
});
