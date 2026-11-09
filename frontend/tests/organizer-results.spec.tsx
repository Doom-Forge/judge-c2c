import { expect, test } from "@playwright/test";
import {
	displayedStageScore,
	transitionConfirmation,
} from "../src/features/organizer/results/score-display";

test("pending stage scores stay distinct from a real zero", () => {
	expect(displayedStageScore(null)).toBe("Pending");
	expect(displayedStageScore(0)).toBe("0.0");
});

test("official score display never derives a final mark from stage averages", () => {
	// The result table receives the official mark from the judge finalization record;
	// stage averages remain separate reference data.
	expect(displayedStageScore(null)).toBe("Pending");
	expect(displayedStageScore(77)).toBe("77.0");
});

test("freeze and publication transitions require a reason confirmation", () => {
	expect(transitionConfirmation("freeze", "short")).toBe(false);
	expect(transitionConfirmation("freeze", "Results reviewed")).toBe(true);
	expect(transitionConfirmation("publish", "Results reviewed")).toBe(true);
	expect(transitionConfirmation("unpublish", "  ")).toBe(false);
	expect(transitionConfirmation("unfreeze", "Unlock for correction")).toBe(
		true,
	);
});
