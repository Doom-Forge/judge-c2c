export type EngineeringCriterion = {
	id: string;
	label: string;
	weight: number;
};

export type ReviewFeedback = {
	problemUnderstanding?: string;
	remediation?: string;
	innovationImpact?: string;
	overall?: string;
};

export function preferredReviewSource<T>(
	submitted: T | null | undefined,
	draft: T | null | undefined,
): T | null {
	return submitted ?? draft ?? null;
}

export function parseReviewScore(value: string): number | null {
	if (!value.trim()) return null;
	const score = Number(value);
	return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}

export function validateEngineeringCriteria(
	rubric: EngineeringCriterion[],
	scores: Record<string, number | null>,
): { valid: boolean; reason: string | null } {
	if (
		rubric.length === 0 ||
		rubric.some(
			({ id }) =>
				!Number.isFinite(scores[id]) || scores[id]! < 0 ||
				scores[id]! > 100,
		)
	) {
		return { valid: false, reason: "criteria" };
	}
	return { valid: true, reason: null };
}

export function calculateEngineeringScore(
	rubric: EngineeringCriterion[],
	scores: Record<string, number>,
) {
	const totalWeight = rubric.reduce(
		(sum, criterion) => sum + criterion.weight,
		0,
	);
	if (!totalWeight || rubric.some(({ id }) => !Number.isFinite(scores[id]))) {
		return 0;
	}
	return rubric.reduce(
		(sum, criterion) =>
			sum + (scores[criterion.id]! * criterion.weight) / totalWeight,
		0,
	);
}

export function validateReview(
	stage: "ANALYSIS" | "ENGINEERING" | "REVISION",
	score: number | null,
	feedback: ReviewFeedback | null,
	reason?: string,
): { valid: boolean; reason: string | null } {
	if (stage === "REVISION") {
		return reason?.trim()
			? { valid: true, reason: null }
			: { valid: false, reason: "revision" };
	}
	if (score === null || !Number.isFinite(score) || score < 0 || score > 100) {
		return { valid: false, reason: "score" };
	}
	if (
		stage === "ANALYSIS" &&
		(!feedback ||
			!feedback.problemUnderstanding?.trim() ||
			!feedback.remediation?.trim() ||
			!feedback.innovationImpact?.trim() ||
			!feedback.overall?.trim())
	) {
		return { valid: false, reason: "feedback" };
	}
	return { valid: true, reason: null };
}
