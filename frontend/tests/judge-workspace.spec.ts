import { expect, test } from "@playwright/test";
import {
	calculateEngineeringScore,
	parseReviewScore,
	preferredReviewSource,
	validateEngineeringCriteria,
	validateReview,
} from "../src/features/judge/judge-workspace-helpers";

test("calculates a weighted engineering score from six rubric criteria", () => {
	const rubric = [
		{ id: "architecture", label: "Architecture", weight: 20 },
		{ id: "security", label: "Security", weight: 20 },
		{ id: "reliability", label: "Reliability", weight: 15 },
		{ id: "performance", label: "Performance", weight: 15 },
		{ id: "testing", label: "Testing", weight: 15 },
		{ id: "maintainability", label: "Maintainability", weight: 15 },
	];
	const scores = Object.fromEntries(rubric.map(({ id }) => [id, 80]));

	expect(calculateEngineeringScore(rubric, scores)).toBe(80);
	expect(
		calculateEngineeringScore(rubric, {
			...scores,
			security: 100,
		}),
	).toBe(84);
});

test("requires a valid score and all four analysis feedback fields", () => {
	expect(
		validateReview("ANALYSIS", 92, {
			problemUnderstanding: "Clear findings",
			remediation: "Feasible fixes",
			innovationImpact: "Useful impact",
			overall: "Strong work",
		}),
	).toEqual({ valid: true, reason: null });
	expect(
		validateReview("ANALYSIS", null, {
			problemUnderstanding: "",
			remediation: "Feasible fixes",
			innovationImpact: "Useful impact",
			overall: "Strong work",
		}),
	).toEqual({ valid: false, reason: "score" });
});

test("requires a reason when revising a submitted review", () => {
	expect(validateReview("REVISION", 85, null, "")).toEqual({
		valid: false,
		reason: "revision",
	});
	expect(
		validateReview("REVISION", 85, null, "Updated after evidence review"),
	).toEqual({ valid: true, reason: null });
});

test("does not coerce a blank review score to zero", () => {
	expect(parseReviewScore("")).toBeNull();
	expect(parseReviewScore("  ")).toBeNull();
	expect(parseReviewScore("0")).toBe(0);
	expect(parseReviewScore("101")).toBeNull();
});

test("requires an explicit in-range score for every engineering criterion", () => {
	const rubric = [
		{ id: "architecture", label: "Architecture", weight: 60 },
		{ id: "testing", label: "Testing", weight: 40 },
	];
	expect(
		validateEngineeringCriteria(rubric, {
			architecture: 90,
			testing: null,
		}),
	).toEqual({
		valid: false,
		reason: "criteria",
	});
	expect(
		validateEngineeringCriteria(rubric, { architecture: 90, testing: 80 }),
	).toEqual({
		valid: true,
		reason: null,
	});
});

test("prefers the latest submitted review over an older retained draft", () => {
	const submission = { score: 90 };
	const draft = { score: 72 };

	expect(preferredReviewSource(submission, draft)).toBe(submission);
	expect(preferredReviewSource(null, draft)).toBe(draft);
});
