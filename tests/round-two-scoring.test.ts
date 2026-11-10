import { describe, expect, it } from "vitest";
import {
	calculateTeamScore,
	normalizeEngineeringScore,
	validateTrackRubric,
} from "../src/round-two-scoring";

describe("round two scoring", () => {
	it("requires each track rubric to total exactly one hundred percent", () => {
		expect(() =>
			validateTrackRubric([
				{
					id: "correctness",
					label: "Functional correctness",
					weight: 30,
				},
				{ id: "security", label: "Security", weight: 69 },
			])
		).toThrow("RUBRIC_WEIGHT_TOTAL");
	});

	it("computes a normalized PR score from track-specific weights", () => {
		const rubric = validateTrackRubric([
			{ id: "correctness", label: "Functional correctness", weight: 30 },
			{ id: "security", label: "Security", weight: 20 },
			{ id: "performance", label: "Performance", weight: 20 },
			{ id: "quality", label: "Code quality", weight: 15 },
			{ id: "innovation", label: "Innovation", weight: 10 },
			{ id: "reproducibility", label: "Reproducibility", weight: 5 },
		]);

		expect(
			normalizeEngineeringScore(rubric, [
				{ criterionId: "correctness", score: 100 },
				{ criterionId: "security", score: 80 },
				{ criterionId: "performance", score: 90 },
				{ criterionId: "quality", score: 80 },
				{ criterionId: "innovation", score: 100 },
				{ criterionId: "reproducibility", score: 100 },
			]),
		).toBe(91);
	});

	it("accepts an optional rubric category while retaining legacy three-field criteria", () => {
		const rubric = validateTrackRubric([
			{ id: "tests", label: "Automated tests", weight: 60 },
			{
				id: "reproducibility",
				label: "Reproducibility",
				weight: 40,
				category: "Reproducibility",
			},
		]);

		expect(rubric[0]).not.toHaveProperty("category");
		expect(rubric[1]?.category).toBe("Reproducibility");
		expect(
			normalizeEngineeringScore(rubric, [
				{ criterionId: "tests", score: 80 },
				{ criterionId: "reproducibility", score: 100 },
			]),
		).toBe(88);
		expect(() =>
			validateTrackRubric([
				{
					id: "tests",
					label: "Automated tests",
					weight: 100,
					category: "Code quality and maintainability",
				},
			]),
		).toThrow();
	});

	it("averages submitted judges and applies the ten ninety formula", () => {
		expect(calculateTeamScore([80, 84], [90, 92])).toEqual({
			status: "READY",
			analysisAverage: 82,
			engineeringAverage: 91,
			finalScore: 90.1,
		});
	});

	it("keeps a team pending until both review stages have submissions", () => {
		expect(calculateTeamScore([82], [])).toEqual({
			status: "PENDING",
			analysisAverage: 82,
			engineeringAverage: null,
			finalScore: null,
		});
	});
});
