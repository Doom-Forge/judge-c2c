import { z } from "zod";

const criterionSchema = z
	.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
		label: z.string().trim().min(1).max(160),
		weight: z.number().int().min(1).max(100),
	})
	.strict();
const criterionScoreSchema = z
	.object({
		criterionId: z.string().min(1).max(80),
		score: z.number().finite().min(0).max(100),
	})
	.strict();
export type TrackRubricCriterion = z.infer<typeof criterionSchema>;
export type CriterionScore = z.infer<typeof criterionScoreSchema>;

export function validateTrackRubric(raw: unknown): TrackRubricCriterion[] {
	const criteria = z.array(criterionSchema).min(1).max(50).parse(raw);
	if (
		new Set(criteria.map((criterion) => criterion.id)).size !==
			criteria.length
	) {
		throw new Error("RUBRIC_CRITERION_DUPLICATE");
	}
	if (
		criteria.reduce((sum, criterion) => sum + criterion.weight, 0) !== 100
	) {
		throw new Error("RUBRIC_WEIGHT_TOTAL");
	}
	return criteria;
}

export function normalizeEngineeringScore(
	rubricInput: unknown,
	scoreInput: unknown,
) {
	const rubric = validateTrackRubric(rubricInput),
		scores = z.array(criterionScoreSchema).max(50).parse(scoreInput),
		byId = new Map(
			scores.map((criterion) => [criterion.criterionId, criterion.score]),
		),
		rubricIds = new Set(rubric.map((criterion) => criterion.id));
	if (
		byId.size !== rubric.length ||
		rubric.some((criterion) => !byId.has(criterion.id)) ||
		scores.some((criterion) => !rubricIds.has(criterion.criterionId))
	) {
		throw new Error("RUBRIC_SCORE_SET_MISMATCH");
	}
	return rubric.reduce((sum, criterion) => {
		const score = byId.get(criterion.id);
		if (score === undefined) {
			throw new Error("RUBRIC_SCORE_SET_MISMATCH");
		}
		return sum + (score * criterion.weight) / 100;
	}, 0);
}

function average(scores: number[]) {
	if (
		scores.some(
			(score) => !Number.isFinite(score) || score < 0 || score > 100,
		)
	) {
		throw new Error("STAGE_SCORE_INVALID");
	}
	return scores.length
		? scores.reduce((sum, score) => sum + score, 0) / scores.length
		: null;
}

export function calculateTeamScore(
	analysisScores: number[],
	engineeringScores: number[],
) {
	const analysisAverage = average(analysisScores),
		engineeringAverage = average(engineeringScores);
	if (analysisAverage === null || engineeringAverage === null) {
		return {
			status: "PENDING" as const,
			analysisAverage,
			engineeringAverage,
			finalScore: null,
		};
	}
	return {
		status: "READY" as const,
		analysisAverage,
		engineeringAverage,
		finalScore: (analysisAverage * 10 + engineeringAverage * 90) / 100,
	};
}
