import { describe, expect, it } from "vitest";

import { areaFor, setFeedbackArea, windowNameFrom } from "./area";
import { FEEDBACK_AREAS } from "./config";

describe("feedback area", () => {
  it("comes from a pop-out window's URL", () => {
    expect(areaFor("?pane=drawing")).toBe("Drawing tool");
    expect(areaFor("?pane=test-preview&snapshot=1")).toBe("Printing / PDF");
    expect(areaFor("?app=gradebook")).toBe("Gradebook");
    expect(windowNameFrom("?pane=drawing")).toBe("drawing");
    expect(windowNameFrom("")).toBe("main");
  });

  it("follows the main window's page", () => {
    setFeedbackArea("tests");
    expect(areaFor("")).toBe("Test builder");
    setFeedbackArea("standards");
    expect(areaFor("")).toBe("Library (standards)");
  });

  it("only uses areas the form offers", () => {
    for (const search of ["?pane=questions", "?pane=assets", "?pane=import", "?pane=courses", "?app=gradebook"]) {
      expect(FEEDBACK_AREAS).toContain(areaFor(search));
    }
  });
});
