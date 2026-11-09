import { expect, test } from "@playwright/test";
import {
	calculateDisplayedFinalScore,
	displayedStageScore,
	transitionConfirmation,
} from "../src/features/organizer/results/score-display";

test("pending stage scores stay distinct from a real zero", () => {
	expect(displayedStageScore(null)).toBe("Pending");
	expect(displayedStageScore(0)).toBe("0.0");
});

test("final score uses the 10/90 stage weighting", () => {
	expect(calculateDisplayedFinalScore(50, 80)).toBe(77);
	expect(calculateDisplayedFinalScore(null, 80)).toBeNull();
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
